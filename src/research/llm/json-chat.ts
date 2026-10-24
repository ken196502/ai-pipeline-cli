/**
 * Research-specific wrapper around the public chatJsonObject helper.
 *
 * Translates LLMError into research AppError for backward compatibility,
 * mirroring the chat() wrapper in src/research/llm/client.ts.
 */
import { chatJsonObject as publicChatJsonObject } from '../../llm/json-chat.js';
import type { ChatRequest } from '../../llm/types.js';
import { LLMError } from '../../llm/client.js';
import { AppError, ErrorCodes } from '../errors.js';
import type { EnvConfig } from '../../env.js';

export async function chatJsonObject(
  req: Omit<ChatRequest, 'responseFormat'>,
  customConfig?: EnvConfig,
): Promise<{ value: unknown }> {
  const context = req.context ?? { stage: 'research', task: 'json-chat' };
  try {
    return await publicChatJsonObject(req, customConfig);
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
