import type {
  ExplainerAsset,
  ExplainerStoryboard,
  ExplainerVideoSummary,
  ExplainerTimeline,
  TutorialAsset,
  TutorialStoryboard,
  TutorialGenerationSummary,
  TutorialTimeline,
} from '../../libs/player/contracts.js';
import type { OpusVoiceTrackResult } from '../../libs/player/tts.js';
import type { XHotEvalResult } from '../evaluation/contracts.js';
import type { XHotHarvestResult } from '../harvest/contracts.js';

export interface CreateExplainerVideoOptions {
  query: string;
  evalResult: XHotEvalResult;
  harvestResult: XHotHarvestResult;
  outDir: string;
  fps?: number;
  width?: number;
  height?: number;
  engine?: 'firefox' | 'chromium';
  subtitles?: boolean;
  ttsVoice?: string;
  ttsRate?: string;
  browserPath?: string;
  profileDir?: string;
  onProgress?: (stage: string, message: string) => void;
}
export type CreateXHotVideoOptions = CreateExplainerVideoOptions;

export type ExplainerProgress = (stage: string, message: string) => void;

export interface ExplainerGridOptions {
  /** Number of frames on the contact-sheet grid (default 12). */
  count?: number;
  /** Timestamp range of the final showcase segment for dedicated grid slots. */
  finalShowcaseRange?: { startSec: number; durationSec: number };
}

export interface ExplainerAfterRenderContext {
  videoPath: string;
  explainerDir: string;
  timeline: ExplainerTimeline;
  voiceTrack: OpusVoiceTrackResult;
}

export interface ExplainerProduceOptions {
  outDir: string;
  /** Subdirectory inside outDir holding the player bundle + video (default 'explainer'). */
  explainerDirname?: string;
  /** Legacy alias */
  tutorialDirname?: string;
  runId: string;
  topic: string;
  title: string;
  videoId?: string;
  narrationLanguage?: string;
  /** Ready-to-use visual assets (already copied into the assets dir by the caller). */
  assets: ExplainerAsset[];
  /** LLM-generated storyboard (clips/shots/elements/narration). */
  storyboard: ExplainerStoryboard;
  fps?: number;
  width?: number;
  height?: number;
  engine?: 'firefox' | 'chromium';
  subtitles?: boolean;
  ttsVoice?: string;
  ttsRate?: string;
  browserPath?: string;
  profileDir?: string;
  crf?: number;
  preset?: string;
  /** Skip frame rendering (HTML preview + narration only). */
  previewOnly?: boolean;
  /**
   * Filename of the JSON result file written to outDir (e.g. 'explainer-result.json').
   * Omit to skip writing a result file.
   */
  resultFilename?: string;
  /** If set, the storyboard is also written to <outDir>/<storyboardFilename>. */
  storyboardFilename?: string;
  /** Optional hook deriving grid options from the synthesized voice track. */
  gridOptions?: (voiceTrack: OpusVoiceTrackResult) => ExplainerGridOptions | undefined;
  /** Optional post-render hook (visual QA etc.). Throw to fail the production. */
  afterRender?: (ctx: ExplainerAfterRenderContext) => Promise<void>;
  /** Optional hook receiving the final summary. */
  onSummary?: (summary: ExplainerVideoSummary) => Promise<void> | void;
  /** Extra fields merged into the summary. */
  summaryExtras?: Partial<ExplainerVideoSummary>;
  onProgress?: ExplainerProgress;
}
