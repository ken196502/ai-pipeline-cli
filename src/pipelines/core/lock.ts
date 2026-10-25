/**
 * Pipeline run lock — refuses to start a pipeline while another one is running.
 *
 * Why this exists: every pipeline on this box drives the SAME persistent Chromium
 * profile (`AIGC-pipeline/.chromium-profile`, CDP port 9222). A second pipeline
 * attaches over CDP to the first one's browser, steals its pages, and — on the
 * X relogin path — may wipe the whole profile via `resetProfileFromSystem()`.
 * Running two pipelines concurrently is therefore never safe, so the CLI must
 * fail fast instead of corrupting a session.
 *
 * Two independent detectors:
 *   1. Run lock file (`.tmp/pipeline.lock`): authoritative, atomic create.
 *   2. Live process scan (`ps`): catches runs started without a lock (older
 *      builds, manual invocations from another terminal).
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { getProjectRootDir } from '../../utils/browser.js';

const execFileAsync = promisify(execFile);

export const PIPELINE_CONFLICT_CODE = 'PIPELINE_CONFLICT';
export const PIPELINE_CONFLICT_EXIT_CODE = 2;

export interface PipelineLockInfo {
  /** PID of the process holding the lock. */
  pid: number;
  /** Pipeline id (e.g. `xhot`, `flowTutor`). */
  pipelineId: string;
  /** Run id when known (assigned later for some pipelines). */
  runId?: string;
  /** Chromium profile the holder is using. */
  profileDir?: string;
  /** Full command line of the holder. */
  command?: string;
  /** ISO timestamp of acquisition. */
  startedAt: string;
  /** Project root the lock belongs to. */
  projectRoot: string;
  /** Hostname — the lock is host-local. */
  host: string;
  /** Ownership token so an exit hook never deletes someone else's lock. */
  token: string;
}

/** Where the conflict came from, so the error message can be precise. */
export type PipelineConflictSource = 'lock' | 'process';

export interface PipelineConflictHolder {
  source: PipelineConflictSource;
  pipelineId: string;
  pid?: number;
  startedAt?: string;
  command?: string;
  lockPath?: string;
}

export class PipelineConflictError extends Error {
  readonly code = PIPELINE_CONFLICT_CODE;

  constructor(
    message: string,
    readonly holder: PipelineConflictHolder
  ) {
    super(message);
    this.name = 'PipelineConflictError';
  }
}

export interface PipelineProcessInfo {
  pid: number;
  pipelineId: string;
  command: string;
}

/** Default lock location: `<projectRoot>/.tmp/pipeline.lock` (`.tmp/` is gitignored). */
export function defaultPipelineLockPath(projectRoot: string = getProjectRootDir()): string {
  return path.join(path.resolve(projectRoot), '.tmp', 'pipeline.lock');
}

/** True when the pid exists and we are allowed to signal it. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM means the process exists but belongs to another user.
    return err?.code === 'EPERM';
  }
}

/** Parent pid from /proc/<pid>/stat (field 4, after the parenthesised comm). */
async function readParentPid(pid: number): Promise<number | null> {
  try {
    const raw = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    const close = raw.lastIndexOf(')');
    if (close === -1) return null;
    const fields = raw.slice(close + 2).trim().split(/\s+/);
    const ppid = Number(fields[1]);
    return Number.isInteger(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

/**
 * `pid` plus every ancestor up to (excluding) init. Used to skip the shell /
 * `npx` wrappers of the current invocation: their command lines also contain
 * `src/cli.ts <pipeline>`, but they are not pipeline holders.
 */
export async function collectAncestorPids(pid: number = process.pid): Promise<Set<number>> {
  const seen = new Set<number>([pid]);
  let current = pid;
  for (let depth = 0; depth < 64; depth++) {
    const ppid = await readParentPid(current);
    if (!ppid || ppid <= 1 || seen.has(ppid)) break;
    seen.add(ppid);
    current = ppid;
  }
  return seen;
}

const CLI_ENTRY_RE = /(^|\/)cli\.(ts|js)$/;

/** Executables that can actually host a pipeline CLI run. */
const NODE_LIKE_EXECUTABLES = new Set(['node', 'nodejs', 'node.exe', 'tsx', 'bun', 'deno']);

/** Reads a process working directory from /proc (null when unreadable/unsupported). */
export async function readProcessCwd(pid: number): Promise<string | null> {
  try {
    return await fs.readlink(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

/**
 * Extracts `(pipelineId)` from a command line that invokes a pipeline CLI, e.g.
 *   node .../tsx src/cli.ts flowTutor "AI video tutorial how to make viral AI videos" --cookie-path ...
 *
 * Returns null when the command line is not a pipeline CLI invocation. The check
 * is deliberately strict — a plain substring match would flag unrelated shells,
 * `grep`/`less`/`tmux send-keys` wrappers and log tails that merely mention a
 * pipeline command:
 *   • argv[0] must be a Node-like executable (npm/npx/bash wrappers are skipped);
 *   • the entry script must resolve to THIS project's `src/cli.ts` / `dist/cli.js`;
 *   • the first non-flag argument after the entry is the pipeline id.
 */
export function parsePipelineIdFromCommandLine(
  command: string,
  knownPipelineIds: string[],
  context: { projectRoot?: string; cwd?: string | null } = {}
): string | null {
  const tokens = command.trim().split(/\s+/);
  const executable = path.basename(tokens[0] ?? '');
  if (!NODE_LIKE_EXECUTABLES.has(executable)) return null;

  const entryIdx = tokens.findIndex((t) => CLI_ENTRY_RE.test(t));
  if (entryIdx === -1) return null;
  const entry = tokens[entryIdx];

  const pipelineId = tokens.slice(entryIdx + 1).find((t) => !t.startsWith('-'));
  if (!pipelineId || !knownPipelineIds.includes(pipelineId)) return null;

  if (context.projectRoot) {
    const projectRoot = path.resolve(context.projectRoot);
    const allowed = new Set(
      ['src/cli.ts', 'src/cli.js', 'dist/cli.ts', 'dist/cli.js'].map((rel) => path.join(projectRoot, rel))
    );

    // The process must belong to THIS project: either its cwd is inside the project
    // or its command line references the project path. A different checkout using
    // the same relative entry (`src/cli.ts`) must not be reported as a conflict.
    const cwdIsProject = context.cwd
      ? path.resolve(context.cwd) === projectRoot || path.resolve(context.cwd).startsWith(projectRoot + path.sep)
      : false;
    if (!cwdIsProject && !command.includes(projectRoot)) return null;

    const resolvedEntry = path.isAbsolute(entry)
      ? path.resolve(entry)
      : path.resolve(context.cwd ?? projectRoot, entry);

    if (!allowed.has(resolvedEntry)) return null;
  }

  return pipelineId;
}

/**
 * Scans the process table for live pipeline invocations of THIS project.
 * Shell/`npx` wrappers of the current process are excluded via the ancestor set,
 * and one entry per pipeline id is returned (the `node` process is preferred
 * over its wrapper so the reported pid is the real holder).
 */
export async function findRunningPipelineProcesses(options: {
  projectRoot?: string;
  pipelineIds: string[];
  excludePids?: Iterable<number>;
  /** Test hook: replace the `ps` process table read. */
  readProcessTable?: () => Promise<string>;
}): Promise<PipelineProcessInfo[]> {
  const projectRoot = path.resolve(options.projectRoot || getProjectRootDir());
  const exclude = new Set<number>(options.excludePids ?? []);

  let stdout: string;
  try {
    stdout = options.readProcessTable
      ? await options.readProcessTable()
      : (await execFileAsync('ps', ['-eo', 'pid=,args='], { maxBuffer: 8 * 1024 * 1024 })).stdout;
  } catch {
    // A missing/unusable `ps` must not block pipelines; the lock file still guards us.
    return [];
  }

  const found = new Map<string, PipelineProcessInfo>();
  for (const line of stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2];
    if (!command || exclude.has(pid) || pid === process.pid) continue;

    const pipelineId = parsePipelineIdFromCommandLine(command, options.pipelineIds, {
      projectRoot,
      cwd: await readProcessCwd(pid),
    });
    if (!pipelineId) continue;

    const existing = found.get(pipelineId);
    const isNodeProcess = /(^|\/)node(\s|$)/.test(command.split(/\s+/)[0] ?? '');
    const existingIsNode = existing ? /(^|\/)node(\s|$)/.test(existing.command.split(/\s+/)[0] ?? '') : false;
    if (!existing || (isNodeProcess && !existingIsNode)) {
      found.set(pipelineId, { pid, pipelineId, command });
    }
  }

  return Array.from(found.values());
}

/** Reads the lock file, tolerating a missing or corrupt file. */
export async function readPipelineLock(
  lockPath: string = defaultPipelineLockPath()
): Promise<PipelineLockInfo | null> {
  try {
    const raw = await fs.readFile(lockPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.pid !== 'number') return null;
    return parsed as PipelineLockInfo;
  } catch {
    return null;
  }
}

function buildConflictMessage(
  requestedPipelineId: string,
  holder: PipelineConflictHolder
): string {
  const lines = [
    '⛔ Pipeline conflict detected — refusing to start.',
    '',
    `  Requested:        ${requestedPipelineId}`,
    `  Already running:  ${holder.pipelineId}${holder.pid ? ` (pid ${holder.pid})` : ''}`,
  ];
  if (holder.startedAt) lines.push(`  Started at:       ${holder.startedAt}`);
  if (holder.command) lines.push(`  Command:          ${holder.command}`);
  if (holder.lockPath) lines.push(`  Lock file:        ${holder.lockPath}`);
  lines.push(
    '',
    'Pipelines share one persistent Chromium profile (and its CDP session), so a',
    'second run would hijack the first one\'s browser and can wipe its cookies.',
    'Wait for the running pipeline to finish, or stop it, then retry.',
    'To run pipelines in parallel, give each one its own CHROMIUM_PROFILE_DIR.'
  );
  return lines.join('\n');
}

export interface AcquirePipelineLockOptions {
  pipelineId: string;
  runId?: string;
  profileDir?: string;
  command?: string;
  projectRoot?: string;
  lockPath?: string;
  /** Pipeline ids considered "pipelines" by the process scan. Defaults to [pipelineId]. */
  pipelineIds?: string[];
  /** Test hook: replace the process table scan. */
  detectProcesses?: (excludePids: Set<number>) => Promise<PipelineProcessInfo[]>;
  /** Test hook: skip the process scan entirely. */
  skipProcessScan?: boolean;
}

export interface PipelineLockHandle {
  path: string;
  info: PipelineLockInfo;
  /** Removes the lock if this process still owns it. Safe to call twice. */
  release: () => Promise<void>;
}

/**
 * Acquires the exclusive pipeline run lock.
 * Throws PipelineConflictError when another pipeline is already running.
 */
export async function acquirePipelineLock(
  options: AcquirePipelineLockOptions
): Promise<PipelineLockHandle> {
  const projectRoot = path.resolve(options.projectRoot || getProjectRootDir());
  const lockPath = options.lockPath || defaultPipelineLockPath(projectRoot);
  const pipelineIds = options.pipelineIds ?? [options.pipelineId];

  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  // ── 1. Atomic lock creation (two attempts: second one after clearing a stale file) ──
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const info: PipelineLockInfo = {
    pid: process.pid,
    pipelineId: options.pipelineId,
    runId: options.runId,
    profileDir: options.profileDir,
    command: options.command ?? process.argv.join(' '),
    startedAt: new Date().toISOString(),
    projectRoot,
    host: os.hostname(),
    token,
  };

  let acquired = false;
  for (let attempt = 0; attempt < 2 && !acquired; attempt++) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      try {
        await handle.writeFile(JSON.stringify(info, null, 2) + '\n', 'utf8');
      } finally {
        await handle.close();
      }
      acquired = true;
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;

      const existing = await readPipelineLock(lockPath);
      if (existing && existing.pid !== process.pid && isProcessAlive(existing.pid)) {
        const holder: PipelineConflictHolder = {
          source: 'lock',
          pipelineId: existing.pipelineId,
          pid: existing.pid,
          startedAt: existing.startedAt,
          command: existing.command,
          lockPath,
        };
        throw new PipelineConflictError(buildConflictMessage(options.pipelineId, holder), holder);
      }

      // Stale lock (dead pid, corrupt JSON, or our own leftover): clear and retry.
      await fs.rm(lockPath, { force: true }).catch(() => undefined);
    }
  }

  if (!acquired) {
    const holder: PipelineConflictHolder = { source: 'lock', pipelineId: 'unknown', lockPath };
    throw new PipelineConflictError(buildConflictMessage(options.pipelineId, holder), holder);
  }

  // ── 2. Release plumbing (explicit + exit-hook fallback) ──
  const ownsLock = (): boolean => {
    try {
      const current = JSON.parse(fsSync.readFileSync(lockPath, 'utf8'));
      return current?.pid === process.pid && current?.token === token;
    } catch {
      return false;
    }
  };

  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    process.removeListener('exit', onExit);
    if (!ownsLock()) return;
    await fs.rm(lockPath, { force: true }).catch(() => undefined);
  };

  // `exitAfterFlush()` calls process.exit(), which skips `finally` blocks — the
  // exit hook is the only guarantee the lock does not outlive the run.
  const onExit = (): void => {
    try {
      if (ownsLock()) fsSync.rmSync(lockPath, { force: true });
    } catch {
      /* best effort — a stale lock is reclaimed on the next start */
    }
  };
  process.once('exit', onExit);

  // ── 3. Belt and braces: a pipeline may be running without a lock (older build,
  //       manual invocation in another terminal). Scan for it before we start. ──
  if (!options.skipProcessScan) {
    try {
      const excludePids = await collectAncestorPids(process.pid);
      const running = options.detectProcesses
        ? await options.detectProcesses(excludePids)
        : await findRunningPipelineProcesses({ projectRoot, pipelineIds, excludePids });

      if (running.length > 0) {
        const other = running[0];
        const holder: PipelineConflictHolder = {
          source: 'process',
          pipelineId: other.pipelineId,
          pid: other.pid,
          command: other.command,
          lockPath,
        };
        await release();
        throw new PipelineConflictError(buildConflictMessage(options.pipelineId, holder), holder);
      }
    } catch (err) {
      if (err instanceof PipelineConflictError) throw err;
      // A failing scan must not silently allow concurrency — surface it instead.
      await release();
      throw err;
    }
  }

  return { path: lockPath, info, release };
}
