/**
 * Shared types for FlowClient and its submodules.
 */
import type { FlowConfig } from '../config.js';

/** Result of one Phase-1 keyframe image generation step. */
export interface ClipImageResult {
  mediaKey: string | null;
  mediaId: string | null;
  imageUrl: string | null;
  imageOutputPath: string | null;
}

export interface ClientContext {
  config: FlowConfig;
}
