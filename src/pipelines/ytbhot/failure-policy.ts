/**
 * Failure policy for the viral pipeline.
 *
 * Stages that spend external, non-refundable resources (LLM/VL tokens, Google Flow
 * credits) must NOT be retried by the continuous runner: a full round retry re-runs
 * research + Flow + tutorial from scratch and burns the same tokens again on a state
 * that already failed. When such a stage is the active stage of a failure, the
 * pipeline exits with a systemic-fatal code so the daemon stops and a human decides.
 *
 * Stages that spend nothing (env check, YouTube cookie refresh, Flow project
 * allocation, report writing) stay retryable.
 */
export const TOKEN_CONSUMING_STAGES: ReadonlySet<string> = new Set([
  'search-ytb', // FastEval VL cover evaluation + research LLM pipeline
  'standard-gen', // LLM evaluation-standard distillation
  'evaluate', // LLM/VL candidate scoring
  'extract-prompts', // LLM narrative prompt extraction
  'gen-prompts', // LLM Veo script generation
  'flow-generate', // Google Flow video credits
  'tutorial-gen', // LLM storyboard + TTS + frame render
]);

export function isTokenConsumingStage(stage: string | undefined | null): boolean {
  return !!stage && TOKEN_CONSUMING_STAGES.has(stage);
}

/**
 * Tags an in-flight failure with the active stage and, when that stage spends tokens
 * or Flow credits, with the systemic-fatal code that makes the CLI exit 3 (daemon stop).
 * Mutates `err` in place; returns true when the failure was classified as token-fatal.
 */
export function tagTokenStageFailure(
  err: unknown,
  activeStage: string | undefined,
  tokenStageCode: string
): boolean {
  const e = err as { stage?: string; code?: string } | null;
  if (!e || typeof e !== 'object') return false;
  if (!e.stage && activeStage) e.stage = activeStage;
  if (!e.code && isTokenConsumingStage(activeStage)) {
    e.code = tokenStageCode;
    return true;
  }
  return false;
}

/**
 * A Flow canvas targeting mismatch is deterministic: the recorded card identity can
 * never be mounted (wrong kind, or a `file:<sha1>` hash with no canvas token). Sweeping
 * and reloading already happened inside `rightClickImageTile`, so retrying the round
 * reproduces it identically — it must stop the runner instead of burning Flow credits.
 */
export function isFlowTargetingMismatch(message: string | undefined | null): boolean {
  return /Refusing to right-click the wrong card|could not aim at .* card|no (?:image|video) card .* found on the canvas/i.test(
    message || ''
  );
}
