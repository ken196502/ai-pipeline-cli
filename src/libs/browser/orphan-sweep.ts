/**
 * Orphaned fasteval-browser sweeper (Linux-only, best-effort backstop).
 *
 * Background: fasteval YouTube searches launch headless Chromium with a throwaway
 * profile (see research/fasteval/browser-search.ts). When the owning job process is
 * killed (SIGKILL / crash) before its finally-block runs, the browser survives as an
 * orphan (reparented to init). Normal exits clean up correctly — this sweeper only
 * catches the killed-job leftovers.
 *
 * Ownership rule: a fasteval Chromium whose ancestor chain contains a living
 * node/npm/tsx/pi process belongs to a running job/agent and is left alone; one that
 * can be walked up to PID 1 is an orphan and gets SIGTERM → (3s) → SIGKILL.
 */
import fs from 'node:fs';

export interface OrphanSweepResult {
  /** fasteval browser main processes found. */
  scanned: number;
  /** orphans actually terminated. */
  terminated: number;
  pids: number[];
}

const OWNER_COMM_MARKERS = ['node', 'npm', 'tsx', 'pi', 'bun', 'deno'];

function readFileQuiet(pid: number, name: string): string | null {
  try {
    return fs.readFileSync(`/proc/${pid}/${name}`, 'utf8');
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function commOf(pid: number): string {
  const stat = readFileQuiet(pid, 'stat');
  if (!stat) return '';
  // comm is the first field in parentheses; it may contain spaces/parens, so take
  // the substring between the FIRST '(' and the LAST ')'.
  const open = stat.indexOf('(');
  const close = stat.lastIndexOf(')');
  return open >= 0 && close > open ? stat.slice(open + 1, close) : '';
}

function ppidOf(pid: number): number {
  const stat = readFileQuiet(pid, 'stat');
  if (!stat) return -1;
  const close = stat.lastIndexOf(')');
  if (close < 0) return -1;
  const rest = stat.slice(close + 2).split(' ');
  // rest[0] is state, rest[1] is ppid
  return Number(rest[1]) || -1;
}

/** true when any living ancestor looks like a JS runtime that could own a job/agent. */
function hasLivingOwnerAncestor(pid: number, maxDepth = 32): boolean {
  let cur = ppidOf(pid);
  let depth = 0;
  while (cur > 1 && depth < maxDepth) {
    const comm = commOf(cur);
    if (OWNER_COMM_MARKERS.some((m) => comm === m || comm.startsWith(`${m}-`))) return true;
    cur = ppidOf(cur);
    depth += 1;
  }
  return false;
}

export function sweepOrphanFastevalBrowsers(): OrphanSweepResult {
  const result: OrphanSweepResult = { scanned: 0, terminated: 0, pids: [] };
  if (process.platform !== 'linux') return result;

  let entries: string[] = [];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;

    const cmdline = readFileQuiet(pid, 'cmdline')?.replace(/\0/g, ' ') ?? '';
    if (!cmdline.includes('chromium')) continue;
    // only browser MAIN processes — children (--type=renderer/gpu/...) die with the main
    if (cmdline.includes('--type=')) continue;
    const profileMatch = cmdline.match(/--user-data-dir=(\S+)/);
    if (!profileMatch || !profileMatch[1].includes('fasteval')) continue;

    result.scanned += 1;
    if (hasLivingOwnerAncestor(pid)) continue;

    // orphan: graceful then forceful
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      continue;
    }
    const deadline = Date.now() + 3000;
    while (isAlive(pid) && Date.now() < deadline) {
      // synchronous 100ms pause (sweeper is a rare, intentionally blocking backstop)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
    if (isAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        continue;
      }
    }
    result.terminated += 1;
    result.pids.push(pid);
  }
  return result;
}
