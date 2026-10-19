/**
 * Public type definitions for LLM requests, completions, structured output, and diagnostics.
 */

export interface ChatImagePart {
  type: 'image_url';
  image_url: { url: string };
}

export interface ChatTextPart {
  type: 'text';
  text: string;
}

export type ChatContent = string | ReadonlyArray<ChatTextPart | ChatImagePart>;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: ChatContent;
}

/**
 * Backoff/retry budget for chat completions. Defaults live in
 * `DEFAULT_RETRY_POLICY` (src/llm/client.ts); requests may override subsets.
 */
export interface RetryPolicy {
  /** Additional attempts after the first for ordinary errors (network/5xx). */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Additional attempts after the first when the gateway answers HTTP 429. */
  rateLimitMaxRetries: number;
  rateLimitBaseDelayMs: number;
  rateLimitMaxDelayMs: number;
  /** Upper bound applied to an upstream `Retry-After` hint on HTTP 429. */
  rateLimitRetryAfterCapMs: number;
}

export interface ChatRequest {
  model?: string;
  messages: readonly ChatMessage[];
  temperature?: number;
  responseFormat?: 'json_object' | 'text';
  timeoutMs?: number;
  /**
   * Mandatory pipeline step coordinates for error attribution. Every caller
   * must declare which stage/task it belongs to so a failed request can be
   * traced to its pipeline step. Runtime callers that bypass the type system
   * and omit this get their call site captured instead (see client.ts).
   */
  context: { stage: string; task: string };
  /** Partial retry overrides merged over the default retry policy. */
  retryPolicy?: Partial<RetryPolicy>;
}

export interface ChatResult {
  content: string;
  model: string;
  usage: { promptTokens: number; completionTokens: number } | null;
}

export type JsonExtraction =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

export interface EnvVerificationResult {
  valid: boolean;
  reason: string;
  statusCode?: number;
  baseUrl: string;
  modelsFound?: string[];
  latencyMs?: number;
}
