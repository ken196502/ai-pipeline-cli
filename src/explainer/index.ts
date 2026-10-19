/**
 * Explainer video module (解说/介绍视频共享生产模块).
 *
 * Extracts the OpusVideo production tail shared by every pipeline that renders
 * an explainer-style video — xhot trending introductions, viral tutorial
 * commentary videos, and future pipelines:
 *
 *   TTS voice track → timeline assembly → player bundle → host render script
 *   → headless frame render → post-render hook (QA etc.) → contact grid
 *   → summary (+ optional result file / persistence hook)
 *
 * Domain pipelines only supply what genuinely differs: visual assets and a
 * storyboard (plus prompts for LLM storyboard generation).
 */
export {
  produceExplainerVideo,
  generateExplainerStoryboard,
  EXPLAINER_DEFAULTS,
} from './produce.js';
export type {
  ExplainerProduceOptions,
  ExplainerProgress,
  ExplainerGridOptions,
  ExplainerAfterRenderContext,
} from './contracts.js';
