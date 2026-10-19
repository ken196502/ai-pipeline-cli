import type { TutorialAsset, TutorialGenerationSummary, TutorialStoryboard } from '../tutorial/contracts.js';

export type ExplainerProgress = (stage: string, message: string) => void;

export interface ExplainerGridOptions {
  /** Number of frames on the contact-sheet grid (default 12). */
  count?: number;
  /** Timestamp range of the final showcase segment for dedicated grid slots. */
  finalShowcaseRange?: { startSec: number; durationSec: number };
}

export interface ExplainerAfterRenderContext {
  videoPath: string;
  tutorialDir: string;
  timeline: import('../tutorial/contracts.js').TutorialTimeline;
  voiceTrack: import('../tutorial/tts.js').OpusVoiceTrackResult;
}

/**
 * Options for producing an explainer video from a ready storyboard + assets.
 *
 * This is the shared production tail used by every pipeline that renders an
 * OpusVideo explainer/presentation video (xhot introduction videos, viral
 * tutorial videos, future pipelines): TTS → timeline → player bundle → host
 * render script → frame render → (hook) → contact grid → summary.
 */
export interface ExplainerProduceOptions {
  outDir: string;
  /** Subdirectory inside outDir holding the player bundle + video (default 'tutorial'). */
  tutorialDirname?: string;
  runId: string;
  topic: string;
  title: string;
  videoId?: string;
  narrationLanguage?: string;
  /** Ready-to-use visual assets (already copied into the assets dir by the caller). */
  assets: TutorialAsset[];
  /** LLM-generated storyboard (clips/shots/elements/narration). */
  storyboard: TutorialStoryboard;
  fps?: number;
  width?: number;
  height?: number;
  engine?: 'firefox' | 'chromium';
  subtitles?: boolean;
  ttsVoice?: string;
  ttsRate?: string;
  browserPath?: string;
  crf?: number;
  preset?: string;
  /** Skip frame rendering (HTML preview + narration only). */
  previewOnly?: boolean;
  /**
   * Filename of the JSON result file written to outDir (e.g. 'tutorial-result.json').
   * Omit to skip writing a result file (callers using run.write handle persistence).
   */
  resultFilename?: string;
  /** If set, the storyboard is also written to <outDir>/<storyboardFilename>. */
  storyboardFilename?: string;
  /** Optional hook deriving grid options from the synthesized voice track. */
  gridOptions?: (voiceTrack: import('../tutorial/tts.js').OpusVoiceTrackResult) => ExplainerGridOptions | undefined;
  /** Optional post-render hook (visual QA etc.). Throw to fail the production. */
  afterRender?: (ctx: ExplainerAfterRenderContext) => Promise<void>;
  /** Optional hook receiving the final summary (e.g. run.write persistence). */
  onSummary?: (summary: TutorialGenerationSummary) => Promise<void> | void;
  /** Extra fields merged into the summary (e.g. model). */
  summaryExtras?: Partial<TutorialGenerationSummary>;
  onProgress?: ExplainerProgress;
}
