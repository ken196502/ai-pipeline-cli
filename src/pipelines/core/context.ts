import path from 'node:path';
import fs from 'node:fs/promises';
import { createRunLogger, type RunLogger } from '../../utils/logger.js';
import { generateRunId, ensureOutputDir } from '../../utils/run.js';
import { writeRunManifest } from '../../utils/artifacts.js';
import { RunContext, pipelineArtifactFilenames } from '../../run/index.js';
import type { StageResult, StageStatus } from './contracts.js';

export type PipelineProgressCallback = (stage: string, message: string, data?: unknown) => void;

export interface PipelineExecutionContext {
  runId: string;
  pipelineId?: string;
  outDir: string;
  startTime: number;
  logger: RunLogger;
  run: RunContext;
  stages: Record<string, StageResult>;
  notify: (stage: string, message: string, data?: unknown) => void;
  recordStage: (
    stage: string,
    status: StageStatus,
    durationMs: number,
    summary?: string,
    error?: string,
    details?: Record<string, unknown>
  ) => StageResult;
  saveReports: (md?: string, json?: unknown) => Promise<{ markdownPath?: string; jsonPath?: string } | void>;
  writeManifest?: () => Promise<string>;
  flush?: () => Promise<void>;
  close?: () => Promise<void>;
}
export type PipelineContext = PipelineExecutionContext;

export async function createDefaultExecutionContext(
  pipelineId: string,
  customOutDir?: string,
  options: {
    runId?: string;
    onProgress?: PipelineProgressCallback;
    config?: object;
    title?: string;
    logFileName?: string;
    jsonlFileName?: string;
  } = {}
): Promise<PipelineExecutionContext> {
  const runId = options.runId || generateRunId(pipelineId);
  const outDir = await ensureOutputDir(customOutDir, runId);
  const logger = createRunLogger({
    runId,
    logDir: outDir,
    title: options.title || `${pipelineId.toUpperCase()} PIPELINE RUN LOG`,
    logFileName: options.logFileName || 'pipeline.log',
    jsonlFileName: options.jsonlFileName || 'events.jsonl',
  });
  const startTime = Date.now();
  const stages: Record<string, StageResult> = {};

  const run = await RunContext.create({
    pipelineId,
    runId,
    outDir,
    config: options.config,
    filenames: ['flowTutor', 'research-audit'].includes(pipelineId) ? pipelineArtifactFilenames : undefined,
  });

  let pending = Promise.resolve();
  const persistStage = (result: StageResult) => {
    const snapshot = structuredClone(result);
    pending = pending.then(() => run.recordStage(snapshot));
    void pending.catch(() => {});
  };
  const flush = () => pending;

  const recordStage = (
    stage: string,
    status: StageStatus,
    durationMs: number,
    summary?: string,
    error?: string,
    details?: Record<string, unknown>
  ): StageResult => {
    const result: StageResult = { stage, status, durationMs, summary, error, details };
    stages[stage] = result;
    persistStage(result);
    if (status === 'failed') {
      logger.error(`[${stage}] FAILED (${(durationMs / 1000).toFixed(1)}s): ${error || summary}`);
    } else {
      logger.info(`[${stage}] ${status.toUpperCase()} (${(durationMs / 1000).toFixed(1)}s): ${summary || ''}`);
    }
    logger.event(`stage:${status}`, { stage, durationMs, summary, error });
    return result;
  };

  const notify = (stage: string, message: string, data?: unknown) => {
    if (stage !== 'complete' && !stages[stage]) {
      stages[stage] = { stage, status: 'in_progress', durationMs: 0 };
      persistStage(stages[stage]);
    }
    logger.info(`[${stage}] ${message}`, data as Record<string, unknown> | undefined);
    if (options.onProgress) {
      try {
        options.onProgress(stage, message, data);
      } catch {}
    }
  };

  const saveReports = async (
    md?: string,
    json?: unknown
  ): Promise<{ markdownPath?: string; jsonPath?: string }> => {
    let markdownPath: string | undefined;
    let jsonPath: string | undefined;

    if (md) {
      markdownPath = path.join(outDir, 'FINAL_REPORT.md');
      await fs.writeFile(markdownPath, md, 'utf-8');
      const legacyMd = path.join(outDir, 'report.md');
      await fs.writeFile(legacyMd, md, 'utf-8').catch(() => {});
    }

    if (json !== undefined) {
      jsonPath = path.join(outDir, 'final-report.json');
      const serialized = typeof json === 'string' ? json : JSON.stringify(json, null, 2);
      await fs.writeFile(jsonPath, serialized, 'utf-8');
      const legacyJson = path.join(outDir, 'result.json');
      await fs.writeFile(legacyJson, serialized, 'utf-8').catch(() => {});
    }

    return { markdownPath, jsonPath };
  };

  const writeManifest = async (): Promise<string> => {
    await flush();
    return writeRunManifest(runId, outDir);
  };

  const close = async (): Promise<void> => {
    try {
      await flush();
    } finally {
      await logger.close();
    }
  };

  return {
    runId,
    pipelineId,
    outDir,
    startTime,
    logger,
    run,
    stages,
    notify,
    recordStage,
    saveReports,
    writeManifest,
    flush,
    close,
  };
}

export const createPipelineContext = (options: {
  pipelineId: string;
  runId?: string;
  outDir?: string;
  title?: string;
  onProgress?: PipelineProgressCallback;
  logFileName?: string;
  jsonlFileName?: string;
  config?: object;
}) => createDefaultExecutionContext(options.pipelineId, options.outDir, options);
