import { pipelineRegistry } from './core/registry.js';
import { xhotPipeline } from './xhot/execute.js';

// Auto-register available pipelines
pipelineRegistry.register(xhotPipeline);

export * from './core/index.js';
export * from './xhot/index.js';
export { pipelineRegistry };
