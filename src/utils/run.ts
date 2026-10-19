/**
 * Shared run utilities for CLI artifact organization.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Generates a unique run ID with a given prefix.
 * Format: `{prefix}-{timestamp}-{6-char-random}`
 */
export function generateRunId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Resolves the output directory for a run.
 * If `outDir` is provided, uses it directly (resolved to absolute).
 * Otherwise defaults to `{cwd}/artifacts/{runId}/`.
 */
export function resolveOutputDir(outDir: string | undefined, runId: string): string {
  return outDir
    ? path.resolve(outDir)
    : path.resolve(process.cwd(), 'artifacts', runId);
}

/**
 * Creates the output directory and returns the resolved path.
 */
export async function ensureOutputDir(outDir: string | undefined, runId: string): Promise<string> {
  const resolved = resolveOutputDir(outDir, runId);
  await fs.mkdir(resolved, { recursive: true });
  return resolved;
}
