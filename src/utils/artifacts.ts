/**
 * Run Artifacts and Manifest Management Utility.
 *
 * Ensures every execution run generates organized, timestamped artifacts:
 * - pipeline.log (plain text log)
 * - events.jsonl (line-delimited structured event stream)
 * - manifest.json (index of all artifacts with size and sha256 checksum)
 * - intermediate & final JSON / Markdown files
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './hash.js';
import { generateRunId } from './run.js';

export interface ArtifactEntry {
  name: string;
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  sha256Hash: string;
  category: 'log' | 'jsonl' | 'report' | 'script' | 'metadata' | 'media' | 'standard';
  mimeType?: string;
  description?: string;
}

export interface RunManifest {
  runId: string;
  createdAt: string;
  runDir: string;
  totalArtifacts: number;
  totalSizeBytes: number;
  artifacts: ArtifactEntry[];
}

export interface EnsureRunDirOptions {
  baseDir?: string;
  runId?: string;
  prefix?: string;
}

/**
 * Resolves the directory for a specific run.
 */
export function resolveRunDir(options: EnsureRunDirOptions = {}): { runId: string; runDir: string } {
  const runId = options.runId || generateRunId(options.prefix || 'run');
  const baseDir = options.baseDir
    ? path.resolve(options.baseDir)
    : path.resolve(process.cwd(), 'artifacts', 'runs');
  const runDir = path.join(baseDir, runId);
  return { runId, runDir };
}

/**
 * Ensures the run directory exists on disk.
 */
export async function ensureRunDir(options: EnsureRunDirOptions = {}): Promise<{ runId: string; runDir: string }> {
  const { runId, runDir } = resolveRunDir(options);
  await fs.mkdir(runDir, { recursive: true });
  return { runId, runDir };
}

/**
 * Categorizes a file by extension and basename.
 */
export function categorizeArtifact(filename: string): ArtifactEntry['category'] {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.log')) return 'log';
  if (lower.endsWith('.jsonl')) return 'jsonl';
  if (lower.endsWith('.md')) return 'report';
  if (lower.endsWith('.mp4') || lower.endsWith('.webm') || lower.endsWith('.png') || lower.endsWith('.jpg')) return 'media';
  if (lower.includes('standard')) return 'standard';
  if (lower.includes('script') || lower.includes('prompts')) return 'script';
  return 'metadata';
}

/**
 * Scans a run directory and builds a comprehensive manifest.json.
 */
export async function buildRunManifest(runId: string, runDir: string): Promise<RunManifest> {
  const artifacts: ArtifactEntry[] = [];
  let totalSizeBytes = 0;

  async function scan(currentDir: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await scan(fullPath);
      } else if (entry.isFile()) {
        if (entry.name === 'manifest.json') continue; // Do not self-index manifest
        try {
          const buffer = await fs.readFile(fullPath);
          const sizeBytes = buffer.length;
          const hash = sha256(buffer);
          const relPath = path.relative(runDir, fullPath);

          artifacts.push({
            name: entry.name,
            relativePath: relPath,
            absolutePath: fullPath,
            sizeBytes,
            sha256Hash: hash,
            category: categorizeArtifact(entry.name),
          });

          totalSizeBytes += sizeBytes;
        } catch {
          // Ignore files that cannot be read
        }
      }
    }
  }

  await scan(runDir);

  // Sort artifacts by category and relative path
  artifacts.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return {
    runId,
    createdAt: new Date().toISOString(),
    runDir,
    totalArtifacts: artifacts.length,
    totalSizeBytes,
    artifacts,
  };
}

/**
 * Writes manifest.json to the run directory.
 */
export async function writeRunManifest(runId: string, runDir: string): Promise<string> {
  const manifest = await buildRunManifest(runId, runDir);
  const manifestPath = path.join(runDir, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  return manifestPath;
}
