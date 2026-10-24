/**
 * Zod Schemas and TypeScript Interfaces for Flow Google VideoGen.
 */
import { z } from 'zod';

export const FlowProjectSchema = z.object({
  projectId: z.string().nullable(),
  url: z.string().url(),
  title: z.string().optional(),
});
export type FlowProject = z.infer<typeof FlowProjectSchema>;

export const FlowProjectItemSchema = z.object({
  projectId: z.string(),
  url: z.string(),
  title: z.string().optional(),
  lastModified: z.string().optional(),
});
export type FlowProjectItem = z.infer<typeof FlowProjectItemSchema>;

/**
 * Live credit balance snapshot — the ONLY quota source is the real balance
 * managed by flow.google.com (read via the top-right avatar "Account details"
 * panel). The local daily ledger and DAILY_VIDEO_LIMIT env gating were removed.
 */
export const QuotaSnapshotSchema = z.object({
  /** UTC date of the check (display only). */
  date: z.string(),
  /** Live balance read from flow.google.com. */
  actualCredits: z.number().int().nonnegative(),
  /** Credits required for one video task (env FLOW_VIDEO_CREDIT_COST, default 15). */
  costPerVideo: z.number().int().positive(),
  /** Balance before the task (task snapshots only). */
  creditsBefore: z.number().int().nullable().optional(),
  /** Balance after the task (task snapshots only). */
  creditsAfter: z.number().int().nullable().optional(),
});
export type QuotaSnapshot = z.infer<typeof QuotaSnapshotSchema>;

export const ViewportSchema = z
  .union([
    z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
    z.null(),
  ])
  .optional();

export const GenerateImageOptionsSchema = z.object({
  prompt: z.string().min(1, 'Prompt must not be empty'),
  timeoutMs: z.number().int().positive().default(120_000),
  outputPath: z.string().optional(),
  headed: z.boolean().default(false),
  projectId: z.string().optional(),
  aspect: z.enum(['landscape', 'portrait', 'square']).default('landscape'),
  profileDir: z.string().optional(),
  dataDir: z.string().optional(),
  viewport: ViewportSchema,
});
export type GenerateImageOptions = z.input<typeof GenerateImageOptionsSchema>;
export type ParsedGenerateImageOptions = z.output<typeof GenerateImageOptionsSchema>;

export const GenerateImageResultSchema = z.object({
  project: FlowProjectSchema,
  imageUrl: z.string().nullable().optional(),
  outputPath: z.string().nullable().optional(),
  mediaId: z.string().nullable().optional(),
  prompt: z.string(),
  createdAt: z.string().optional(),
});
export type GenerateImageResult = z.infer<typeof GenerateImageResultSchema>;

export const GenerateOptionsSchema = z.object({
  prompt: z.string().min(1, 'Prompt must not be empty'),
  imagePrompt: z.string().optional(),
  endImagePrompt: z.string().optional(),
  timeoutMs: z.number().int().positive().default(1_800_000),
  outputPath: z.string().optional(),
  imageOutputPath: z.string().optional(),
  endImageOutputPath: z.string().optional(),
  headed: z.boolean().default(false),
  projectId: z.string().optional(),
  duration: z.union([z.literal(4), z.literal(6), z.literal(8), z.literal(10)]).default(4),
  aspect: z.enum(['landscape', 'portrait']).default('landscape'),
  model: z.string().default('lite'),
  profileDir: z.string().optional(),
  dataDir: z.string().optional(),
  viewport: ViewportSchema,
});
export type GenerateOptions = z.input<typeof GenerateOptionsSchema>;
export type ParsedGenerateOptions = z.output<typeof GenerateOptionsSchema>;

export const GenerationResultSchema = z.object({
  project: FlowProjectSchema,
  quota: QuotaSnapshotSchema,
  videoUrl: z.string().url(),
  outputPath: z.string().nullable().optional(),
  imageUrl: z.string().nullable().optional(),
  imageOutputPath: z.string().nullable().optional(),
  durationSec: z.number().optional(),
  prompt: z.string().optional(),
  model: z.string().optional(),
  createdAt: z.string().optional(),
});
export type GenerationResult = z.infer<typeof GenerationResultSchema>;

export const BatchOptionsSchema = z.object({
  scriptPath: z.string().min(1, 'Script path required'),
  outDir: z.string().min(1, 'Output directory required'),
  projectId: z.string().optional(),
  headed: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  maxClips: z.number().int().positive().optional(),
  aspect: z.enum(['landscape', 'portrait']).optional(),
  model: z.string().default('lite'),
  profileDir: z.string().optional(),
  dataDir: z.string().optional(),
  viewport: ViewportSchema,
});
export type BatchOptions = z.input<typeof BatchOptionsSchema>;
export type ParsedBatchOptions = z.output<typeof BatchOptionsSchema>;

export const BatchClipResultSchema = z.object({
  clipIndex: z.number().int().nonnegative(),
  sceneId: z.string().optional(),
  title: z.string().optional(),
  imagePrompt: z.string().optional(),
  imageUrl: z.string().nullable().optional(),
  localImagePath: z.string().nullable().optional(),
  endImagePrompt: z.string().optional(),
  endImageUrl: z.string().nullable().optional(),
  localEndImagePath: z.string().nullable().optional(),
  visualPrompt: z.string().optional(),
  /** Shot transition of this clip (切分镜 "cut" / 连续 "continuous"). */
  transition: z.enum(['cut', 'continuous']).optional(),
  /** 备注 of the shot transition (what stays consistent / what changes). */
  transitionNote: z.string().optional(),
  outputPath: z.string().optional(),
  videoUrl: z.string().optional(),
  status: z.enum(['completed', 'failed', 'skipped']),
  error: z.string().optional(),
});
export type BatchClipResult = z.infer<typeof BatchClipResultSchema>;

export const BatchResultSchema = z.object({
  totalClips: z.number().int().nonnegative(),
  completedClips: z.number().int().nonnegative(),
  failedClips: z.number().int().nonnegative(),
  skippedClips: z.number().int().nonnegative(),
  outDir: z.string(),
  finalCredits: z.number().int().nonnegative().optional(),
  results: z.array(BatchClipResultSchema),
});
export type BatchResult = z.infer<typeof BatchResultSchema>;
