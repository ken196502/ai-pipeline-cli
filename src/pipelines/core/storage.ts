/**
 * Pipeline-specific persistent storage manager.
 *
 * Provides organized, reusable on-disk storage for each pipeline:
 *   storage/<pipeline-id>/
 *     ├── standards/     # Reusable evaluation standards (<topic-slug>.json)
 *     └── transcripts/   # Cached & cleaned subtitle transcripts (<video-id>.json)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { EvaluationStandard, Transcript } from '../../research/contracts.js';
import { TranscriptSchema } from '../../research/contracts.js';
import { verifyStandardHash } from '../../research/evaluation/standard.js';

export const PipelineFlowCreditsSchema = z.object({
  actualCredits: z.number().int().nonnegative(),
  updatedAt: z.string(),
  source: z.string().optional(),
  profileDir: z.string().optional(),
  runId: z.string().optional(),
});
export type PipelineFlowCredits = z.infer<typeof PipelineFlowCreditsSchema>;

export const PipelineConfigSchema = z.object({
  pipelineId: z.string(),
  updatedAt: z.string(),
  flowCredits: PipelineFlowCreditsSchema.optional(),
  custom: z.record(z.unknown()).optional(),
});
export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;

export interface PipelineStorageOptions {
  /**
   * Root directory for all pipeline persistent stores.
   * Defaults to process.env.PIPELINE_STORAGE_DIR or './storage'.
   */
  baseDir?: string;

  /**
   * Unique identifier for the pipeline (e.g. 'viral-video-maker', 'research-audit').
   */
  pipelineId: string;
}

export class PipelineStorage {
  readonly baseDir: string;
  readonly pipelineId: string;
  readonly pipelineDir: string;
  readonly standardsDir: string;
  readonly transcriptsDir: string;
  readonly videosDir: string;

  constructor(options: PipelineStorageOptions) {
    this.baseDir = path.resolve(options.baseDir || process.env.PIPELINE_STORAGE_DIR || './storage');
    this.pipelineId = options.pipelineId;
    this.pipelineDir = path.join(this.baseDir, this.pipelineId);
    this.standardsDir = path.join(this.pipelineDir, 'standards');
    this.transcriptsDir = path.join(this.pipelineDir, 'transcripts');
    this.videosDir = path.join(this.pipelineDir, 'videos');
  }

  /**
   * Ensures the pipeline storage directories exist on disk.
   */
  async init(): Promise<void> {
    await fs.mkdir(this.standardsDir, { recursive: true });
    await fs.mkdir(this.transcriptsDir, { recursive: true });
    await fs.mkdir(this.videosDir, { recursive: true });
  }

  // ==========================================
  // Evaluation Standards Persistent Storage
  // ==========================================

  getStandardPath(topicSlug: string): string {
    const safeSlug = topicSlug.replace(/[^a-z0-9_-]/gi, '-');
    return path.join(this.standardsDir, `${safeSlug}.json`);
  }

  async hasStandard(topicSlug: string): Promise<boolean> {
    try {
      const stat = await fs.stat(this.getStandardPath(topicSlug));
      return stat.size > 0;
    } catch {
      return false;
    }
  }

  /**
   * Loads an evaluation standard for a given topic slug.
   * First checks the pipeline's own standardsDir, then falls back to fallbackDir (e.g. legacy ./standards).
   * Verifies the cryptographic SHA-256 standardHash.
   */
  async loadStandard(
    topicSlug: string,
    fallbackDir?: string
  ): Promise<{ standard: EvaluationStandard; path: string; isFallback?: boolean } | null> {
    const candidatePaths = [
      this.getStandardPath(topicSlug),
      path.join(this.standardsDir, `${topicSlug}-standard.json`),
    ];

    if (fallbackDir) {
      const resolvedFallback = path.resolve(fallbackDir);
      candidatePaths.push(
        path.join(resolvedFallback, `${topicSlug}.json`),
        path.join(resolvedFallback, `${topicSlug}-standard.json`)
      );
    }

    for (const candidatePath of candidatePaths) {
      try {
        const raw = await fs.readFile(candidatePath, 'utf8');
        const standard = JSON.parse(raw) as EvaluationStandard;
        if (verifyStandardHash(standard)) {
          const isFallback = !candidatePath.startsWith(this.standardsDir);
          // If loaded from fallback directory, also copy it into the pipeline's own standards store
          if (isFallback) {
            try {
              await this.saveStandard(topicSlug, standard);
            } catch {
              // Non-fatal if copy fails
            }
          }
          return { standard, path: candidatePath, isFallback };
        }
      } catch {
        // Continue checking next candidate
      }
    }

    return null;
  }

  /**
   * Persists a canonical evaluation standard to the pipeline storage.
   */
  async saveStandard(topicSlug: string, standard: EvaluationStandard): Promise<string> {
    await fs.mkdir(this.standardsDir, { recursive: true });
    const targetPath = this.getStandardPath(topicSlug);
    await fs.writeFile(targetPath, JSON.stringify(standard, null, 2), 'utf8');
    return targetPath;
  }

  /**
   * Removes evaluation standard(s) matching the topic slug.
   */
  async removeStandard(topicSlug: string): Promise<string[]> {
    const removed: string[] = [];
    const candidatePaths = [
      this.getStandardPath(topicSlug),
      path.join(this.standardsDir, `${topicSlug}-standard.json`),
    ];
    for (const p of candidatePaths) {
      try {
        await fs.rm(p, { force: true });
        removed.push(p);
      } catch {}
    }
    return removed;
  }

  /**
   * Purges all evaluation standards in the pipeline storage directory.
   */
  async removeAllStandards(): Promise<string[]> {
    const removed: string[] = [];
    try {
      const files = await fs.readdir(this.standardsDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const p = path.join(this.standardsDir, file);
          await fs.rm(p, { force: true });
          removed.push(p);
        }
      }
    } catch {}
    return removed;
  }

  // ==========================================
  // Cleaned Subtitle Transcripts Persistent Storage
  // ==========================================

  getTranscriptPath(videoId: string, language?: string): string {
    const safeId = videoId.replace(/[^a-zA-Z0-9_-]/g, '');
    if (language && language !== 'en' && language !== 'und') {
      const safeLang = language.replace(/[^a-zA-Z0-9_-]/g, '');
      return path.join(this.transcriptsDir, `${safeId}_${safeLang}.json`);
    }
    return path.join(this.transcriptsDir, `${safeId}.json`);
  }

  async hasTranscript(videoId: string, language?: string): Promise<boolean> {
    try {
      const stat = await fs.stat(this.getTranscriptPath(videoId, language));
      return stat.size > 0;
    } catch {
      // If language was specified, also check fallback without language suffix
      if (language) {
        try {
          const stat = await fs.stat(this.getTranscriptPath(videoId));
          return stat.size > 0;
        } catch {
          return false;
        }
      }
      return false;
    }
  }

  /**
   * Loads a cleaned transcript from the pipeline's persistent storage.
   * Validates structure and ensures it contains at least one cue.
   */
  async loadTranscript(videoId: string, language?: string): Promise<Transcript | null> {
    const candidatePaths = [this.getTranscriptPath(videoId, language)];
    if (language) {
      candidatePaths.push(this.getTranscriptPath(videoId));
    }

    for (const targetPath of candidatePaths) {
      try {
        const raw = await fs.readFile(targetPath, 'utf8');
        const parsed = JSON.parse(raw);
        const validated = TranscriptSchema.safeParse(parsed);
        if (validated.success && validated.data.cues.length > 0) {
          return validated.data;
        }
      } catch {
        // Try next candidate
      }
    }

    return null;
  }

  /**
   * Persists a cleaned transcript to the pipeline's persistent storage.
   */
  async saveTranscript(transcript: Transcript): Promise<string> {
    const validated = TranscriptSchema.parse(transcript);
    await fs.mkdir(this.transcriptsDir, { recursive: true });
    const targetPath = this.getTranscriptPath(validated.videoId, validated.language);
    await fs.writeFile(targetPath, JSON.stringify(validated, null, 2), 'utf8');
    return targetPath;
  }

  /**
   * Lists all cached transcripts in the storage.
   */
  async listTranscripts(): Promise<Array<{ videoId: string; language: string; cueCount: number; path: string }>> {
    const results: Array<{ videoId: string; language: string; cueCount: number; path: string }> = [];
    try {
      const files = await fs.readdir(this.transcriptsDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(this.transcriptsDir, file);
          try {
            const raw = await fs.readFile(filePath, 'utf8');
            const data = JSON.parse(raw) as Transcript;
            if (data.videoId && Array.isArray(data.cues)) {
              results.push({
                videoId: data.videoId,
                language: data.language || 'en',
                cueCount: data.cues.length,
                path: filePath,
              });
            }
          } catch {}
        }
      }
    } catch {}
    return results;
  }

  /**
   * Removes a specific cached transcript.
   */
  async removeTranscript(videoId: string, language?: string): Promise<boolean> {
    const targetPath = this.getTranscriptPath(videoId, language);
    try {
      await fs.rm(targetPath, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  // ==========================================
  // Candidate Video Media (yt-dlp) Persistent Storage
  // ==========================================

  getVideoPath(videoId: string, ext = 'mp4'): string {
    const safeId = videoId.replace(/[^a-zA-Z0-9_-]/g, '');
    const cleanExt = ext.replace(/^\./, '') || 'mp4';
    return path.join(this.videosDir, `${safeId}.${cleanExt}`);
  }

  /**
   * Finds an existing candidate video file in persistent storage.
   * Checks common container extensions (.mp4, .mkv, .webm, .mov, etc.)
   */
  async findVideo(videoId: string): Promise<string | null> {
    const safeId = videoId.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeId) return null;

    try {
      const files = await fs.readdir(this.videosDir);
      const match = files.find((f) => {
        if (!f.startsWith(safeId)) return false;
        const ext = path.extname(f).toLowerCase();
        return ['.mp4', '.mkv', '.webm', '.mov', '.m4v'].includes(ext);
      });

      if (match) {
        const fullPath = path.join(this.videosDir, match);
        const stat = await fs.stat(fullPath);
        if (stat.size > 0) {
          return fullPath;
        }
      }
    } catch {}

    return null;
  }

  async hasVideo(videoId: string): Promise<boolean> {
    return Boolean(await this.findVideo(videoId));
  }

  /**
   * Persists a downloaded candidate video to the pipeline storage.
   * Copies the file from sourcePath if sourcePath is different from targetPath.
   */
  async saveVideo(videoId: string, sourcePath: string): Promise<string> {
    const safeId = videoId.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safeId) {
      throw new Error(`Invalid videoId for video storage: "${videoId}"`);
    }

    const stat = await fs.stat(sourcePath);
    if (!stat.isFile() || stat.size === 0) {
      throw new Error(`Source video does not exist or is empty: ${sourcePath}`);
    }

    await fs.mkdir(this.videosDir, { recursive: true });
    const ext = path.extname(sourcePath) || '.mp4';
    const targetPath = this.getVideoPath(safeId, ext);

    if (path.resolve(sourcePath) !== path.resolve(targetPath)) {
      await fs.copyFile(sourcePath, targetPath);
    }

    return targetPath;
  }

  /**
   * Lists all cached candidate video media in storage.
   */
  async listVideos(): Promise<Array<{ videoId: string; path: string; sizeBytes: number }>> {
    const results: Array<{ videoId: string; path: string; sizeBytes: number }> = [];
    try {
      const files = await fs.readdir(this.videosDir);
      for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        if (['.mp4', '.mkv', '.webm', '.mov', '.m4v'].includes(ext)) {
          const filePath = path.join(this.videosDir, file);
          try {
            const stat = await fs.stat(filePath);
            const videoId = path.basename(file, ext);
            results.push({
              videoId,
              path: filePath,
              sizeBytes: stat.size,
            });
          } catch {}
        }
      }
    } catch {}
    return results;
  }

  /**
   * Removes a cached video from storage.
   */
  async removeVideo(videoId: string): Promise<boolean> {
    const videoPath = await this.findVideo(videoId);
    if (videoPath) {
      try {
        await fs.rm(videoPath, { force: true });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  // ==========================================
  // Pipeline-Specific Config & Flow Credits Persistent Storage
  // storage/<pipeline-id>/config.json
  // ==========================================

  /**
   * Returns path to the pipeline's persistent configuration file (storage/<pipeline-id>/config.json).
   */
  getConfigPath(): string {
    return path.join(this.pipelineDir, 'config.json');
  }

  /**
   * Loads the pipeline-specific configuration file.
   */
  async loadConfig(): Promise<PipelineConfig | null> {
    try {
      const raw = await fs.readFile(this.getConfigPath(), 'utf8');
      const parsed = JSON.parse(raw);
      return PipelineConfigSchema.parse(parsed);
    } catch {
      return null;
    }
  }

  /**
   * Persists/merges updates into the pipeline-specific configuration file.
   */
  async saveConfig(partial: Partial<PipelineConfig>): Promise<PipelineConfig> {
    await fs.mkdir(this.pipelineDir, { recursive: true });
    const existing = await this.loadConfig();
    const config: PipelineConfig = {
      updatedAt: new Date().toISOString(),
      ...existing,
      ...partial,
      pipelineId: this.pipelineId, // lock pipelineId
    };
    await fs.writeFile(this.getConfigPath(), JSON.stringify(config, null, 2), 'utf8');
    return config;
  }

  /**
   * Retrieves the latest recorded Flow credit snapshot for this pipeline.
   */
  async getFlowCredits(): Promise<PipelineFlowCredits | null> {
    const config = await this.loadConfig();
    return config?.flowCredits ?? null;
  }

  /**
   * Updates the latest Flow credits in this pipeline's persistent configuration file.
   */
  async updateFlowCredits(
    actualCredits: number,
    meta?: Partial<Omit<PipelineFlowCredits, 'actualCredits' | 'updatedAt'>>
  ): Promise<PipelineConfig> {
    const flowCredits: PipelineFlowCredits = {
      actualCredits: Math.max(0, Math.floor(actualCredits)),
      updatedAt: new Date().toISOString(),
      source: meta?.source || 'flow.google.com',
      profileDir: meta?.profileDir,
      runId: meta?.runId,
    };
    return this.saveConfig({ flowCredits });
  }
}

/**
 * Convenience factory to create a PipelineStorage instance.
 */
export function getPipelineStorage(pipelineId: string, baseDir?: string): PipelineStorage {
  return new PipelineStorage({ pipelineId, baseDir });
}
