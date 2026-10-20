/**
 * Chat helper that guarantees an extracted JSON object reply.
 *
 * Strategy (per plan-llm-json-parse-hardening.md):
 * 1. Call chat() with response_format=json_object.
 * 2. If the model ignored JSON mode and replied with prose, extract the first
 *    balanced JSON object/array from the raw text (extractJsonObject — more
 *    robust than regex: quote/escape aware).
 * 3. If still no JSON, append the assistant's raw reply plus a repair message
 *    and retry the LLM (2 retries, i.e. 3 attempts total).
 * 4. If every attempt fails, throw LLMError(LLM_RESPONSE_INVALID) — no
 *    fallback values, fail fast per project policy.
 */
import { chat, LLMError, type ChatMessage, type ChatRequest, type ChatResult } from './client.js';
import { getEnvConfig, type EnvConfig } from '../../utils/env.js';
import { extractJsonObject, repairMessage, snippetOf } from './json.js';

const MAX_REPAIR_RETRIES = 2;

export interface ChatJsonObjectOptions extends Omit<ChatRequest, 'responseFormat'> {
  /** Extra context for error messages. */
  task?: string;
}

/**
 * Requests a JSON object reply and tolerates models that ignore JSON mode.
 * Returns the parsed JSON value, or throws LLMError after exhausting retries.
 */
export async function chatJsonObject(
  options: ChatJsonObjectOptions,
  customConfig?: EnvConfig,
): Promise<{ value: unknown; result: ChatResult }> {
  const stage = options.context?.stage ?? 'llm';
  const task = options.task ?? options.context?.task ?? 'json-chat';

  const messages: ChatMessage[] = [...options.messages];
  let lastResult: ChatResult | null = null;
  let lastReason = 'No attempts made';

  for (let attempt = 0; attempt <= MAX_REPAIR_RETRIES; attempt += 1) {
    const result = await chat({
      ...options,
      messages,
      responseFormat: 'json_object',
    }, customConfig);
    lastResult = result;

    const extracted = extractJsonObject(result.content);
    if (extracted.ok) {
      return { value: extracted.value, result };
    }
    lastReason = extracted.reason;

    // Repair turn: show the model its own bad reply and demand raw JSON only.
    messages.push({ role: 'assistant', content: result.content });
    messages.push(repairMessage());
  }

  throw new LLMError({
    code: 'LLM_RESPONSE_INVALID',
    message: `LLM did not return valid JSON for ${task} after ${MAX_REPAIR_RETRIES + 1} attempts (${lastReason}); last reply: ${snippetOf(lastResult?.content ?? '')}`,
    stage,
    task,
    retryable: false,
    cause: { attempts: MAX_REPAIR_RETRIES + 1, reason: lastReason },
  });
}
