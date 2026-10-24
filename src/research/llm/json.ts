/**
 * Structured-output decoding: strip markdown fences, isolate balanced JSON object/array,
 * validate with Zod, and construct repair turns on schema failure.
 *
 * Re-exports and wraps public JSON utilities with research-specific AppError handling.
 */
import { z } from 'zod';
import {
  extractJsonObject,
  decodeJson as publicDecodeJson,
  repairJsonMessage,
  repairMessage,
  snippetOf,
  stripFences,
  firstStructuralIndex,
  type JsonExtraction,
} from '../../llm/json.js';
import { LLMError } from '../../llm/client.js';
import { AppError, ErrorCodes } from '../errors.js';

export {
  extractJsonObject,
  repairJsonMessage,
  repairMessage,
  snippetOf,
  stripFences,
  firstStructuralIndex,
  type JsonExtraction,
};

export function decodeJson<S extends z.ZodTypeAny>(
  raw: string,
  schema: S,
  context: {
    code?: string;
    stage: string;
    task: string;
    retryable?: boolean;
    preprocess?: (value: unknown) => unknown;
  },
): z.infer<S> {
  try {
    return publicDecodeJson(raw, schema, context);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof LLMError) {
      throw new AppError({
        code: (error.code as any) ?? ErrorCodes.LLM_RESPONSE_INVALID,
        message: error.message,
        stage: error.stage || context.stage,
        task: error.task || context.task,
        retryable: error.retryable,
        cause: error.cause,
      });
    }
    throw error;
  }
}
