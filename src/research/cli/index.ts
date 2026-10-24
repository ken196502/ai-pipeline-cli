/**
 * Barrel Export for Modular YouTube Research CLIs.
 */

// Search & Candidate Discovery CLI
export {
  runSearchCli,
  renderCandidatesTable,
  type SearchCliOptions,
  type SearchCliResult,
} from './search.js';

// Evaluation Standard Distillation & Integrity Verification CLI
export {
  runGenerateStandard,
  runVerifyStandard,
  loadCandidatesFromFile,
  type GenerateStandardCliOptions,
  type VerifyStandardCliOptions,
  type VerifyStandardResult,
} from './standard.js';

// Veo-Optimized Flow Video Script CLI
export {
  runGenerateScriptCli,
  scriptCommand,
  type ScriptCliOptions,
  type ScriptCliResult,
} from './script.js';

// Standardized CLI Option Helpers
export {
  attachMetricThresholdOptions,
  parseMetricThresholdOptions,
} from './options.js';


