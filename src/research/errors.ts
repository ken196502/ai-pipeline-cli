/**
 * Unified error types crossing stage and task boundaries in the research pipeline.
 */

export interface AppErrorShape {
  code: string;
  message: string;
  stage: string;
  task: string;
  retryable: boolean;
  cause?: unknown;
}

export class AppError extends Error implements AppErrorShape {
  readonly code: string;
  readonly stage: string;
  readonly task: string;
  readonly retryable: boolean;
  override readonly cause?: unknown;

  constructor(params: {
    code: string;
    message: string;
    stage: string;
    task: string;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(params.message);
    this.name = 'AppError';
    this.code = params.code;
    this.stage = params.stage;
    this.task = params.task;
    this.retryable = params.retryable ?? false;
    this.cause = params.cause;
  }

  toJSON(): AppErrorShape {
    return {
      code: this.code,
      message: this.message,
      stage: this.stage,
      task: this.task,
      retryable: this.retryable,
      ...(this.cause === undefined ? {} : { cause: describeCause(this.cause) }),
    };
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Normalise any thrown value into the persisted AppError shape. */
export function toAppError(
  error: unknown,
  fallback: { stage: string; task: string; code?: string },
): AppError {
  if (isAppError(error)) return error;
  return new AppError({
    code: fallback.code ?? ErrorCodes.UNEXPECTED_ERROR,
    message: error instanceof Error ? error.message : String(error),
    stage: fallback.stage,
    task: fallback.task,
    retryable: false,
    cause: error,
  });
}

function describeCause(cause: unknown): unknown {
  if (cause instanceof Error) {
    return { name: cause.name, message: cause.message };
  }
  return cause;
}

export const ErrorCodes = {
  // General
  CONFIG_INVALID: 'CONFIG_INVALID',
  INVALID_REQUEST: 'INVALID_REQUEST',
  UNEXPECTED_ERROR: 'UNEXPECTED_ERROR',
  SCHEMA_VALIDATION_FAILED: 'SCHEMA_VALIDATION_FAILED',
  STAGE_TIMEOUT: 'STAGE_TIMEOUT',

  // YouTube / yt-dlp
  YTDLP_NOT_FOUND: 'YTDLP_NOT_FOUND',
  YTDLP_FAILED: 'YTDLP_FAILED',
  YTDLP_EXEC_ERROR: 'YTDLP_EXEC_ERROR',
  YOUTUBE_BOT_DETECTED: 'YOUTUBE_BOT_DETECTED',
  YOUTUBE_RATE_LIMITED: 'YOUTUBE_RATE_LIMITED',
  COOKIE_INVALID: 'COOKIE_INVALID',
  NO_CANDIDATES: 'NO_CANDIDATES',
  NO_ELIGIBLE_VIDEO: 'NO_ELIGIBLE_VIDEO',
  SUBTITLE_NOT_AVAILABLE: 'SUBTITLE_NOT_AVAILABLE',
  SUBTITLE_PARSE_FAILED: 'SUBTITLE_PARSE_FAILED',

  // LLM Gateway
  LLM_REQUEST_FAILED: 'LLM_REQUEST_FAILED',
  LLM_RESPONSE_INVALID: 'LLM_RESPONSE_INVALID',

  // Evaluation Standard / Rubric Scoring
  EVALUATION_STANDARD_GENERATION_FAILED: 'EVALUATION_STANDARD_GENERATION_FAILED',
  EVALUATION_STANDARD_INVALID: 'EVALUATION_STANDARD_INVALID',
  EVALUATION_RESPONSE_INVALID: 'EVALUATION_RESPONSE_INVALID',
  EVALUATION_EVIDENCE_INCOMPLETE: 'EVALUATION_EVIDENCE_INCOMPLETE',
  EVALUATION_FAILED: 'EVALUATION_FAILED',
  NO_EVALUABLE_CANDIDATE: 'NO_EVALUABLE_CANDIDATE',

  // Selected-video media evidence
  MEDIA_DOWNLOAD_FAILED: 'MEDIA_DOWNLOAD_FAILED',
  MEDIA_DEGENERATE: 'MEDIA_DEGENERATE',
  MEDIA_PROBE_FAILED: 'MEDIA_PROBE_FAILED',
  FRAME_EXTRACTION_FAILED: 'FRAME_EXTRACTION_FAILED',
  ASSET_PATH_INVALID: 'ASSET_PATH_INVALID',

  // Prompt-frame visual evidence
  FRAME_LOCATOR_RESPONSE_INVALID: 'FRAME_LOCATOR_RESPONSE_INVALID',
  PROMPT_RECOGNITION_RESPONSE_INVALID: 'PROMPT_RECOGNITION_RESPONSE_INVALID',
  NO_VIDEO_PROMPT_FOUND: 'NO_VIDEO_PROMPT_FOUND',
  PROMPT_REWRITE_FAILED: 'PROMPT_REWRITE_FAILED',
  VL_MODEL_FAILED: 'VL_MODEL_FAILED',

  // Flow canvas targeting
  FLOW_TARGETING_MISMATCH: 'FLOW_TARGETING_MISMATCH',
  // A token/credit-spending pipeline stage failed (LLM/VL tokens or Flow credits).
  TOKEN_STAGE_FAILED: 'TOKEN_STAGE_FAILED',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
