/**
 * OpenAI-compatible chat completions client with multimodal vision support,
 * FIFO concurrency queueing, and deterministic exponential backoff retry.
 *
 * Re-exports and wraps the public LLM client with research-specific AppError handling.
 */
import {
  chat as publicChat,
  imagePart,
  imagePartFromBase64,
  SerialRequestQueue,
  requestQueue,
  HttpStatusError,
  NonRetryableError,
  LLMError,
  type ChatImagePart,
  type ChatTextPart,
  type ChatContent,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
} from '../../llm/client.js';
import { type EnvConfig } from '../../env.js';
import { AppError, ErrorCodes } from '../errors.js';

export {
  imagePart,
  imagePartFromBase64,
  SerialRequestQueue,
  requestQueue,
  HttpStatusError,
  NonRetryableError,
  LLMError,
  type ChatImagePart,
  type ChatTextPart,
  type ChatContent,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
};

/**
 * Executes a chat completion against the configured LLM gateway, translating
 * any LLMError into research AppError for backward compatibility.
 */
export async function chat(
  req: ChatRequest,
  customConfig?: EnvConfig,
): Promise<ChatResult> {
  const context = req.context ?? { stage: 'research', task: 'llm-chat' };
  try {
    return await publicChat({ ...req, context }, customConfig);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof LLMError) {
      throw new AppError({
        code: (error.code as any) ?? ErrorCodes.LLM_REQUEST_FAILED,
        message: error.message,
        stage: error.stage || context.stage,
        task: error.task || context.task,
        retryable: error.retryable,
        cause: error.cause,
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new AppError({
      code: ErrorCodes.LLM_REQUEST_FAILED,
      message: `LLM request failed: ${message}`,
      stage: context.stage,
      task: context.task,
      retryable: false,
      cause: error,
    });
  }
}
