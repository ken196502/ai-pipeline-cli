/**
 * AIGC Pipeline Platform — 3-Layer Architecture:
 *
 * Layer 1: Utils & Libs (Low-level foundational libraries and utilities)
 * Layer 2: Modules (Autonomous business capability modules: auth, discovery, evaluation, harvest, explainer-video)
 * Layer 3: Pipelines (End-to-end orchestration pipelines: core framework, xhot, and future pipelines)
 */

// Layer 1: Utils & Libs
export * as utils from './utils/index.js';
export * as libs from './libs/index.js';

// Layer 2: Modules
export * as modules from './modules/index.js';
export * from './modules/index.js';

// Layer 3: Pipelines
export * as pipelines from './pipelines/index.js';
export * from './pipelines/index.js';

// Convenience re-exports for xhot pipeline
export { handleXHotCommand, attachXHotOptions } from './pipelines/xhot/cli.js';
