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
import { flowTutorPipeline } from './flowtutor/execute.js';

// ── Auto-register available pipelines ───────────────────────────
pipelineRegistry.register(xhotPipeline);
pipelineRegistry.register(flowTutorPipeline);

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
  flowTutorPipeline,
  executeFlowTutorVideo,
  type FlowTutorPipelineOptions,
  type FlowTutorPipelineResult,
  type FlowTutorPipelineInput,
  FLOW_TUTOR_PIPELINE_STAGES,
  FlowTutorPipelineOptionsSchema,
  FLOW_TUTOR_EVALUATION_REQUIREMENTS,
  DEFAULT_FLOW_TUTOR_QUERY,
  DEFAULT_FLOW_TUTOR_EVALUATION_FOCUS,
  runFlowTutorPipeline,
  attachFlowTutorOptions,
  handleFlowTutorCommand,
} from './flowtutor/index.js';
export { pipelineRegistry };
