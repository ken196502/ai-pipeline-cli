/**
 * Pipeline Layer (Layer 3) — Auto-registration of all available pipelines.
 *
 * Each pipeline registers itself into the shared PipelineRegistry.
 * To add a new pipeline:
 *   1. Create src/pipelines/<name>/ with execute.ts, contracts.ts, cli.ts, etc.
 *   2. Import and register it below.
 */
import { pipelineRegistry } from './core/registry.js';
import { xhotPipeline } from './xhot/execute.js';
import { ytbhotPipeline } from './ytbhot/execute.js';

// ── Auto-register available pipelines ───────────────────────────
pipelineRegistry.register(xhotPipeline);
pipelineRegistry.register(ytbhotPipeline);

// ── Exports ─────────────────────────────────────────────────────
export * from './core/index.js';
export {
  xhotPipeline,
  executeXHotPipeline,
  type XHotPipelineOptions,
  type XHotPipelineResult,
  type XHotFullResult,
  XHOT_STAGES,
  XHotPipelineOptionsSchema,
  generateFinalReportMarkdown,
  generateFinalReportJson,
  saveFinalReports,
  printExecutiveSummary,
  attachXHotOptions,
  handleXHotCommand,
} from './xhot/index.js';
export {
  ytbhotPipeline,
  executeViralVideo as executeYtbHotPipeline,
  type ViralPipelineOptions as YtbHotPipelineOptions,
  type ViralPipelineResult as YtbHotPipelineResult,
} from './ytbhot/index.js';
export { pipelineRegistry };
