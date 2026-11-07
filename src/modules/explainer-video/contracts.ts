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
import type { RenderServiceRouteConfig } from '../../libs/player/render.js';
import type { OpusVoiceTrackResult } from '../../libs/player/tts.js';
import type { ExplainerStyle, ExplainerStylePatch } from '../../libs/player/style.js';
import type { XHotEvalResult } from '../evaluation/contracts.js';
import type { XHotHarvestResult } from '../harvest/contracts.js';

/** Host render service routing shared by the explainer production entry points. */
export interface ExplainerRenderServiceOptions extends RenderServiceRouteConfig {
  /** Explicitly bypass the render service and render locally. */
  forceLocalRender?: boolean;
}

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
  concurrency?: number;
  ttsVoice?: string;
  ttsRate?: string;
  ttsInstruct?: string;
  browserPath?: string;
  profileDir?: string;
  /** Pipeline style preset (default 'preset:cyan-tech' for xhot). */
  stylePreset?: string;
  /** Extra style: JSON file path or inline style object/patch. */
  style?: ExplainerStyle | ExplainerStylePatch | string;
  /** Force one clip transition shader for the whole video. */
  transition?: string;
  /** Host render service routing (URL/token/GPU). */
  renderService?: RenderServiceRouteConfig;
  /** Explicitly bypass the render service and render on this machine. */
  forceLocalRender?: boolean;
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
  /** LLM-generated storyboard (clips/shots/elements/narration — CONTENT ONLY). */
  storyboard: ExplainerStoryboard;
  /**
   * Pipeline style preset (default 'preset:ember-dark'). The run-directory
   * `style.json` and `style` below override it.
   */
  stylePreset?: string;
  /** Extra style: a JSON file path, or an inline style object/patch. */
  style?: ExplainerStyle | ExplainerStylePatch | string;
  /** Style patch migrated out of a legacy storyboard (loadStoryboardWithMigration). */
  storyboardStylePatch?: ExplainerStylePatch;
  /** Force one clip transition shader for the whole video (CLI --transition). */
  transition?: string;
  /** Max concurrent TTS line requests (default 2). */
  ttsConcurrency?: number;
  fps?: number;
  width?: number;
  height?: number;
  engine?: 'firefox' | 'chromium';
  subtitles?: boolean;
  concurrency?: number;
  ttsVoice?: string;
  ttsRate?: string;
  ttsInstruct?: string;
  browserPath?: string;
  profileDir?: string;
  crf?: number;
  preset?: string;
  /** Skip frame rendering (HTML preview + narration only). */
  previewOnly?: boolean;
  /** Host render service routing (URL/token/GPU). */
  renderService?: RenderServiceRouteConfig;
  /** Explicitly bypass the render service and render on this machine. */
  forceLocalRender?: boolean;
  /** Custom video output filename (defaults to 'explainer-video.mp4'). */
  videoFilename?: string;
  /** Custom grid preview filename (defaults to 'explainer-grid.jpg'). */
  gridFilename?: string;
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
