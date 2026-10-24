import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { z } from 'zod';
import { generateRunId } from '../utils/run.js';
import { RunDocumentSchema, type RunDocument, type StageResult } from './contracts.js';
import { artifactSchemas, artifactFilenames, type ArtifactKey, type RunArtifacts } from './artifacts.js';

async function atomicJson(file: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value, null, 2) + '\n';
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** Runtime services and secrets must never become persisted configuration. */
function configSnapshot(value: object): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (typeof item === 'function' || /^(apiKey|authorization|password|secret|token|llmConfig)$/i.test(key)) return undefined;
    if (typeof item === 'string' && item && [
      'outDir', 'outputDir', 'profileDir', 'cookiePath', 'browserPath', 'storageDir',
      'standardsDir', 'standardPath', 'saveStandardPath', 'flowOutputDir',
    ].includes(key)) return path.resolve(item);
    return item;
  }));
}

export interface CreateRunOptions {
  pipelineId: string;
  runId?: string;
  outDir?: string;
  config?: object;
  filenames?: Partial<Record<ArtifactKey, string>>;
}

/** One logical run, backed by a small index and separately owned stage artifacts. */
export class RunContext {
  readonly filePath: string;
  private constructor(readonly outDir: string, readonly runId: string, readonly pipelineId: string,
    private readonly filenames: Partial<Record<ArtifactKey, string>> = {}) {
    this.filePath = path.join(outDir, 'run.json');
  }

  static async create(options: CreateRunOptions): Promise<RunContext> {
    const runId = options.runId || generateRunId(options.pipelineId);
    const outDir = path.resolve(options.outDir || path.join('artifacts', runId));
    await fs.mkdir(outDir, { recursive: true });
    const run = new RunContext(outDir, runId, options.pipelineId, options.filenames);
    await run.lock(async () => {
      try {
        await fs.access(run.filePath);
        throw new Error(`Run already exists at ${run.filePath}. Open it to continue, or choose a new output directory.`);
      } catch (error: any) {
        if (error.code !== 'ENOENT') throw error;
      }
      const now = new Date().toISOString();
      await atomicJson(run.filePath, RunDocumentSchema.parse({
        schemaVersion: 1, runId, pipelineId: options.pipelineId,
        createdAt: now, updatedAt: now, status: 'running',
        config: configSnapshot(options.config || {}), stages: {}, artifacts: {},
      }));
    });
    return run;
  }

  static async open(fileOrDir: string): Promise<RunContext> {
    const resolved = path.resolve(fileOrDir);
    const outDir = path.basename(resolved) === 'run.json' ? path.dirname(resolved) : resolved;
    const document = RunDocumentSchema.parse(JSON.parse(await fs.readFile(path.join(outDir, 'run.json'), 'utf8')));
    return new RunContext(outDir, document.runId, document.pipelineId);
  }

  static async openIfExists(fileOrDir: string): Promise<RunContext | undefined> {
    try { return await RunContext.open(fileOrDir); }
    catch (error: any) { if (error.code === 'ENOENT') return undefined; throw error; }
  }

  async snapshot(): Promise<RunDocument> {
    const document = RunDocumentSchema.parse(JSON.parse(await fs.readFile(this.filePath, 'utf8')));
    if (document.runId !== this.runId || document.pipelineId !== this.pipelineId) {
      throw new Error(`Run identity changed at ${this.filePath}`);
    }
    return document;
  }

  async config<T>(schema: z.ZodType<T, z.ZodTypeDef, any>): Promise<T> {
    return schema.parse((await this.snapshot()).config);
  }

  async configure(patch: object): Promise<void> {
    const clean = configSnapshot(patch);
    await this.update(document => { Object.assign(document.config, clean); });
  }

  async pathFor(key: ArtifactKey): Promise<string> {
    const entry = (await this.snapshot()).artifacts[key];
    if (!entry) throw new Error(`Run ${this.runId} has no "${key}" output; run its producing step first.`);
    return this.resolveArtifactPath(entry.path);
  }

  async read<K extends ArtifactKey>(key: K): Promise<RunArtifacts[K]> {
    return artifactSchemas[key].parse(JSON.parse(await fs.readFile(await this.pathFor(key), 'utf8'))) as RunArtifacts[K];
  }

  async optional<K extends ArtifactKey>(key: K): Promise<RunArtifacts[K] | undefined> {
    if (!(await this.snapshot()).artifacts[key]) return undefined;
    // Missing/corrupt registered artifacts are errors, not a reason to silently use stale files.
    return this.read(key);
  }

  async write<K extends ArtifactKey>(key: K, value: RunArtifacts[K], filename?: string): Promise<string> {
    const parsed = artifactSchemas[key].parse(value);
    if ('runId' in parsed && parsed.runId !== this.runId) {
      throw new Error(`Artifact "${key}" belongs to run ${parsed.runId}, expected ${this.runId}`);
    }
    let target = '';
    await this.update(async document => {
      const relativePath = filename || document.artifacts[key]?.path || this.filenames[key] || artifactFilenames[key];
      target = this.resolveArtifactPath(relativePath);
      if (Object.entries(document.artifacts).some(([other, entry]) => other !== key && this.resolveArtifactPath(entry.path) === target)) {
        throw new Error(`Artifact path already belongs to another stage: ${relativePath}`);
      }
      await atomicJson(target, parsed);
      document.artifacts[key] = { path: path.relative(this.outDir, target), updatedAt: new Date().toISOString() };
    });
    return target;
  }

  async recordStage(result: StageResult): Promise<void> {
    await this.update(document => {
      document.stages[result.stage] = result;
      if (result.status === 'in_progress') {
        document.status = 'running';
        delete document.error;
      }
    });
  }

  async finish(error?: unknown): Promise<void> {
    await this.update(document => {
      const failed = Object.values(document.stages).find(stage => stage.status === 'failed');
      document.status = error || failed ? 'failed' : 'completed';
      document.error = error ? (error instanceof Error ? error.message : String(error)) : failed?.error;
    });
  }

  /** Records a real step boundary, including its failure, before returning to the caller. */
  async step<T>(name: string, execute: () => Promise<T>): Promise<T> {
    const start = Date.now();
    await this.recordStage({ stage: name, status: 'in_progress', durationMs: 0 });
    try {
      const result = await execute();
      await this.recordStage({ stage: name, status: 'completed', durationMs: Date.now() - start });
      return result;
    } catch (error) {
      await this.recordStage({ stage: name, status: 'failed', durationMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private resolveArtifactPath(relativePath: string): string {
    const target = path.resolve(this.outDir, relativePath);
    const relative = path.relative(this.outDir, target);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
        ['run.json', '.run.lock'].includes(relative)) {
      throw new Error(`Invalid run artifact path: ${relativePath}`);
    }
    return target;
  }

  private async update(change: (document: RunDocument) => void | Promise<void>): Promise<void> {
    await this.lock(async () => {
      const document = await this.snapshot();
      await change(document);
      document.updatedAt = new Date().toISOString();
      await atomicJson(this.filePath, RunDocumentSchema.parse(document));
    });
  }

  // Serialize read-modify-write transactions across instances AND processes. Locks cover
  // only short disk operations; an interrupted writer leaves an explicit recoverable lock.
  private async lock<T>(execute: () => Promise<T>): Promise<T> {
    const lockPath = path.join(this.outDir, '.run.lock');
    const deadline = Date.now() + 10_000;
    let handle;
    for (;;) {
      try { handle = await fs.open(lockPath, 'wx', 0o600); break; }
      catch (error: any) {
        if (error.code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) throw new Error(`Run is locked: ${lockPath}. If its writer exited, remove the stale lock and retry.`);
        await delay(20);
      }
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      return await execute();
    } finally {
      await handle.close();
      await fs.rm(lockPath, { force: true });
    }
  }
}
