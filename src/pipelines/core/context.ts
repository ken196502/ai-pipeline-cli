import path from 'node:path';
import fs from 'node:fs/promises';
import { createRunLogger, type RunLogger } from '../../utils/logger.js';
import { generateRunId, ensureOutputDir } from '../../utils/run.js';
import type { StageResult, StageStatus } from './contracts.js';

export interface PipelineExecutionContext {
  runId: string;
  outDir: string;
  startTime: number;
  logger: RunLogger;
  stages: Record<string, StageResult>;
  notify: (stage: string, message: string) => void;
  recordStage: (
    stage: string,
    status: StageStatus,
    durationMs: number,
    summary?: string,
    error?: string,
    details?: Record<string, unknown>
  ) => void;
  saveReports: (md: string, json: string) => Promise<void>;
}

export async function createDefaultExecutionContext(
  pipelineId: string,
  customOutDir?: string
): Promise<PipelineExecutionContext> {
  const runId = generateRunId(pipelineId);
  const outDir = await ensureOutputDir(customOutDir, runId);
  const logger = createRunLogger({ runId, logDir: outDir });
  const startTime = Date.now();
  const stages: Record<string, StageResult> = {};

  const recordStage = (
    stage: string,
    status: StageStatus,
    durationMs: number,
    summary?: string,
    error?: string,
    details?: Record<string, unknown>
  ) => {
    stages[stage] = { stage, status, durationMs, summary, error, details };
    if (status === 'failed') {
      logger.error(`[${stage}] FAILED (${(durationMs / 1000).toFixed(1)}s): ${error || summary}`);
    } else {
      logger.info(`[${stage}] ${status.toUpperCase()} (${(durationMs / 1000).toFixed(1)}s): ${summary || ''}`);
    }
  };

  const notify = (stage: string, message: string) => {
    logger.info(`[${stage}] ${message}`);
  };

  const saveReports = async (md: string, json: string) => {
    await fs.writeFile(path.join(outDir, 'report.md'), md, 'utf-8');
    await fs.writeFile(path.join(outDir, 'result.json'), json, 'utf-8');
  };

  return {
    runId,
    outDir,
    startTime,
    logger,
    stages,
    notify,
    recordStage,
    saveReports,
  };
}
