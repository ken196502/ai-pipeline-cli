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

// ── Auto-register available pipelines ───────────────────────────
pipelineRegistry.register(xhotPipeline);

// Future pipelines:
// import { ytShortsPipeline } from './yt-shorts/execute.js';
// pipelineRegistry.register(ytShortsPipeline);

// ── Exports ─────────────────────────────────────────────────────
export * from './core/index.js';
export * from './xhot/index.js';
export { pipelineRegistry };
