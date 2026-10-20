/**
 * Public OpenAI-compatible chat completions client with multimodal vision support,
 * FIFO serial request queuing, and deterministic exponential backoff retry.
 *
 * HTTP 429 (gateway TPM/RPM limit) gets its own, much longer retry budget:
 * the request is held until the rate-limit window resets and retried, only
 * failing (retryable LLMError) after the rate-limit budget is exhausted.
 */
import { getEnvConfig, type EnvConfig } from '../../utils/env.js';
import type {
  ChatContent,
  ChatImagePart,
  ChatMessage,
  ChatRequest,
  ChatResult,
  ChatTextPart,
  RetryPolicy,
} from './types.js';

export {
  type ChatContent,
  type ChatImagePart,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type ChatTextPart,
  type RetryPolicy,
};

/** HTTP status the gateway uses for "inference exceeds tpm/rpm limit". */
export const RATE_LIMIT_STATUS = 429;

/** Exponential backoff factor shared by both retry budgets. */
const BACKOFF_FACTOR = 2;

/** Default retry budgets for chat completions. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 1500,
  maxDelayMs: 20_000,
  rateLimitMaxRetries: 8,
  rateLimitBaseDelayMs: 5_000,
  rateLimitMaxDelayMs: 60_000,
  rateLimitRetryAfterCapMs: 120_000,
};

/** Merges partial per-request overrides over the default retry policy. */
export function resolveRetryPolicy(overrides?: Partial<RetryPolicy>): RetryPolicy {
  const merged: RetryPolicy = { ...DEFAULT_RETRY_POLICY };
  if (!overrides) return merged;
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      (merged as unknown as Record<string, number>)[key] = value;
    }
  }
  return merged;
}

/**
 * Deterministic backoff schedule for one attempt.
 *
 * - rate limited (429): `max(exponentialBackoff, min(Retry-After, cap))`, so a
 *   gateway hint always wins over a too-short backoff but can never stall
 *   forever.
 * - otherwise: an upstream `Retry-After` hint replaces the backoff (bounded by
 *   `maxDelayMs`), preserving historical behaviour.
 */
export function resolveRetryDelayMs(
  policy: RetryPolicy,
  options: { rateLimited: boolean; attempt: number; retryAfterMs?: number },
): number {
  const { rateLimited, attempt, retryAfterMs } = options;

  if (rateLimited) {
    const backoff = Math.min(
      policy.rateLimitMaxDelayMs,
      policy.rateLimitBaseDelayMs * BACKOFF_FACTOR ** (attempt - 1),
    );
    if (retryAfterMs == null) return backoff;
    const hinted = Math.min(policy.rateLimitRetryAfterCapMs, Math.max(0, retryAfterMs));
    return Math.max(backoff, hinted);
  }

  if (retryAfterMs != null) {
    return Math.max(0, Math.min(policy.maxDelayMs, retryAfterMs));
  }
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * BACKOFF_FACTOR ** (attempt - 1));
}

export class LLMError extends Error {
  readonly code: string;
  readonly stage: string;
  readonly task: string;
  readonly retryable: boolean;
  override readonly cause?: unknown;

  constructor(params: {
    code?: string;
    message: string;
    stage?: string;
    task?: string;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(params.message);
    this.name = 'LLMError';
    this.code = params.code ?? 'LLM_REQUEST_FAILED';
    this.stage = params.stage ?? 'llm';
    this.task = params.task ?? 'chat';
    this.retryable = params.retryable ?? false;
    this.cause = params.cause;
  }
}

export class HttpStatusError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.name = 'HttpStatusError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

export class SerialRequestQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export const requestQueue = new SerialRequestQueue();

/** Wrap binary JPEG bytes for an OpenAI-compatible vision endpoint. */
export function imagePart(jpeg: Uint8Array): ChatImagePart {
  return {
    type: 'image_url',
    image_url: {
      url: `data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}`,
    },
  };
}

/**
 * True when every message carries plain-string content, i.e. the request is
 * eligible for the Responses API (which lacks the image_url part format).
 */
export function isTextOnlyRequest(messages: readonly ChatMessage[]): boolean {
  return messages.every((m) => typeof m.content === 'string');
}

/**
 * Converts chat-completions messages into a Responses API `input` array.
 * Responses uses the same role/content shape for text messages, but does not
 * accept system-role entries the same way — the gateway accepts them, so the
 * mapping stays 1:1.
 */
export function toResponsesInput(messages: readonly ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

/**
 * Builds the Responses API request body from a chat-style request.
 */
export function buildResponsesBody(args: {
  model: string;
  messages: readonly ChatMessage[];
  temperature?: number;
  responseFormat?: 'json_object' | 'text';
  reasoningEffort: 'minimal' | 'low' | 'medium' | 'high';
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: args.model,
    input: toResponsesInput(args.messages),
    reasoning: { effort: args.reasoningEffort },
  };
  if (typeof args.temperature === 'number') body.temperature = args.temperature;
  if (args.responseFormat === 'json_object') {
    body.text = { format: { type: 'json_object' } };
  }
  return body;
}

/**
 * Parses an OpenAI Responses API payload into a ChatResult.
 * Content comes from the first `type: 'message'` output item's output_text
 * parts; reasoning items are skipped (no readable content to fall back to).
 */
export function parseResponsesResponse(payload: Record<string, unknown>): ChatResult {
  const outputs = Array.isArray(payload.output) ? payload.output : [];
  const messageItem = outputs.find(
    (o) => o && typeof o === 'object' && (o as Record<string, unknown>).type === 'message',
  ) as Record<string, unknown> | undefined;

  const contentParts = messageItem && Array.isArray(messageItem.content)
    ? messageItem.content
    : [];
  const text = contentParts
    .map((p) =>
      p && typeof p === 'object' && (p as Record<string, unknown>).type === 'output_text'
        ? (p as Record<string, unknown>).text
        : undefined,
    )
    .filter((t): t is string => typeof t === 'string' && t.length > 0)
    .join('');

  if (!text.trim()) {
    throw new NonRetryableError('Responses API reply contained no output_text content');
  }

  const rawUsage = payload.usage as Record<string, unknown> | undefined;
  const inputTokens = typeof rawUsage?.input_tokens === 'number' ? rawUsage.input_tokens : 0;
  const outputTokens =
    typeof rawUsage?.output_tokens === 'number'
      ? rawUsage.output_tokens
      : typeof rawUsage?.output_tokens_details === 'object' &&
          rawUsage.output_tokens_details !== null &&
          typeof (rawUsage.output_tokens_details as Record<string, unknown>).tokens === 'number'
        ? (rawUsage.output_tokens_details as Record<string, unknown>).tokens as number
        : 0;

  return {
    content: text,
    model: typeof payload.model === 'string' ? payload.model : 'unknown',
    usage:
      inputTokens || outputTokens
        ? { promptTokens: inputTokens, completionTokens: outputTokens }
        : null,
  };
}

/** Wrap base64 string for an OpenAI-compatible vision endpoint. */
export function imagePartFromBase64(base64: string, mimeType?: string): ChatImagePart {
  const url = base64.startsWith('data:')
    ? base64
    : `data:${mimeType ?? sniffImageMime(base64)};base64,${base64}`;
  return {
    type: 'image_url',
    image_url: { url },
  };
}

/** Detects the real image mime type from magic bytes (PNG/JPEG) of a base64 payload. */
function sniffImageMime(base64: string): string {
  const head = Buffer.from(base64.slice(0, 16), 'base64');
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    return 'image/png';
  }
  return 'image/jpeg';
}

/**
 * Executes a chat completion against the configured LLM gateway.
 */
export async function chat(
  req: ChatRequest,
  customConfig?: EnvConfig,
): Promise<ChatResult> {
  const config = customConfig || getEnvConfig();
  // `context` is mandatory at the type level so every caller declares its
  // pipeline step. JS callers that bypass the compiler still get traced:
  // a missing context falls back to the generic coordinates AND captures the
  // call site so the error points at the exact code location that omitted it.
  const context = req.context ?? { stage: 'llm', task: 'chat' };
  const missingContextCaller = req.context ? undefined : captureCallSite();

  if (!config.baseUrl || !config.apiKey) {
    throw new LLMError({
      code: 'LLM_REQUEST_FAILED',
      message: 'LLM base URL or API key is not configured in environment',
      stage: context.stage,
      task: context.task,
      retryable: false,
    });
  }

  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const responsesEndpoint = `${config.baseUrl.replace(/\/+$/, '')}/responses`;
  const targetModel =
    req.model && req.model.trim() && req.model.trim() !== 'default'
      ? req.model.trim()
      : config.llmModel;

  // Responses API is only valid for text-only requests; vision (image part)
  // messages keep using the chat-completions endpoint.
  const useResponses =
    config.apiStyle === 'responses' && isTextOnlyRequest(req.messages);

  return requestQueue.enqueue(async () => {
    if (useResponses) {
      return await invokeWithRetry(
        responsesEndpoint,
        config.apiKey,
        {
          ...req,
          model: targetModel,
          context,
          missingContextCaller,
          timeoutMs: req.timeoutMs ?? 180_000,
          parseResponse: (payload) => parseResponsesResponse(payload),
          transformBody: (args) =>
            buildResponsesBody({
              model: args.model,
              messages: args.messages,
              temperature: args.temperature,
              responseFormat: args.responseFormat,
              reasoningEffort: config.reasoningEffort,
            }),
        },
      );
    }
    return await invokeWithRetry(endpoint, config.apiKey, {
      ...req,
      model: targetModel,
      context,
      missingContextCaller,
      timeoutMs: req.timeoutMs ?? 180_000,
    });
  });
}

interface InvokeArgs extends ChatRequest {
  model: string;
  context: { stage: string; task: string };
  timeoutMs: number;
  /** Call site that omitted `req.context`; surfaced in the error for tracing. */
  missingContextCaller?: string;
  /** Builds an alternative (e.g. Responses API) request body. */
  transformBody?: (args: InvokeArgs) => Record<string, unknown>;
  /** Parses a non-standard response payload (e.g. Responses API). */
  parseResponse?: (payload: Record<string, unknown>) => ChatResult;
}

async function invokeWithRetry(
  endpoint: string,
  apiKey: string,
  args: InvokeArgs,
): Promise<ChatResult> {
  const policy = resolveRetryPolicy(args.retryPolicy);
  let genericAttempts = 0;
  let rateLimitAttempts = 0;
  let rateLimitWaitMs = 0;

  for (;;) {
    try {
      const response = await rawFetchRequest(endpoint, apiKey, args);
      if (!response.ok) {
        let errSnippet = '';
        try {
          const text = await response.text();
          errSnippet = text ? `: ${text.slice(0, 300)}` : '';
        } catch {
          // ignore error reading body
        }
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        throw new HttpStatusError(
          `POST ${endpoint} returned HTTP ${response.status}${errSnippet}`,
          response.status,
          retryAfter,
        );
      }

      const payload = (await response.json()) as Record<string, unknown>;
      return args.parseResponse ? args.parseResponse(payload) : parseChatResponse(payload);
    } catch (error) {
      const isRateLimit =
        error instanceof HttpStatusError && error.status === RATE_LIMIT_STATUS;
      const isNonRetryable =
        error instanceof NonRetryableError ||
        (error instanceof HttpStatusError && [400, 401, 403].includes(error.status));

      // Attempt budgets are tracked per error class, so a burst of 429s never
      // consumes the network/5xx budget and vice versa.
      const attemptNo = isRateLimit ? ++rateLimitAttempts : ++genericAttempts;
      const budget = isRateLimit ? policy.rateLimitMaxRetries : policy.maxRetries;
      const budgetExhausted = attemptNo > budget;

      if (isNonRetryable || budgetExhausted) {
        const detail =
          isRateLimit && rateLimitWaitMs > 0
            ? ` [rate-limited: waited ${Math.round(rateLimitWaitMs / 1000)}s across ${rateLimitAttempts} attempts]`
            : undefined;
        throw toLLMError(error, endpoint, args.model, args.context, detail, args.missingContextCaller);
      }

      const delayMs = resolveRetryDelayMs(policy, {
        rateLimited: isRateLimit,
        attempt: attemptNo,
        retryAfterMs: error instanceof HttpStatusError ? error.retryAfterMs : undefined,
      });
      if (isRateLimit) rateLimitWaitMs += delayMs;

      console.warn(
        `[llm] ${describeFailure(error)} — waiting ${formatDelay(delayMs)} before ` +
          `retry ${attemptNo}/${budget} (${args.context.stage}/${args.context.task})`,
      );

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/** Short human-readable label for a failed attempt (used in retry logs). */
function describeFailure(error: unknown): string {
  if (error instanceof HttpStatusError) {
    return error.status === RATE_LIMIT_STATUS
      ? `rate limited (HTTP ${error.status})`
      : `HTTP ${error.status}`;
  }
  if (error instanceof Error && error.name && error.name !== 'Error') return error.name;
  return 'request failed';
}

function formatDelay(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

async function rawFetchRequest(
  endpoint: string,
  apiKey: string,
  args: InvokeArgs,
): Promise<Response> {
  const body: Record<string, unknown> = args.transformBody
    ? args.transformBody(args)
    : {
        model: args.model,
        messages: args.messages,
        temperature: args.temperature ?? 0.2,
      };

  if (!args.transformBody && args.responseFormat === 'json_object') {
    body.response_format = { type: 'json_object' };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), args.timeoutMs);

  try {
    return await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseChatResponse(payload: Record<string, unknown>): ChatResult {
  const choices = payload.choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const message =
    first && typeof first === 'object'
      ? (first as Record<string, unknown>).message
      : undefined;

  let content: string;
  const rawContent =
    message && typeof message === 'object'
      ? (message as Record<string, unknown>).content
      : undefined;

  if (typeof rawContent === 'string' && rawContent.trim().length > 0) {
    content = rawContent;
  } else {
    const reasoning =
      message && typeof message === 'object'
        ? (message as Record<string, unknown>).reasoning_content
        : undefined;
    if (typeof reasoning === 'string' && reasoning.trim().length > 0) {
      content = reasoning;
    } else {
      throw new NonRetryableError('LLM response returned no content in choices[0].message');
    }
  }

  const usage = extractUsage(payload.usage);
  return {
    content,
    model: typeof payload.model === 'string' ? payload.model : 'unknown',
    usage,
  };
}

function extractUsage(raw: unknown): ChatResult['usage'] {
  if (!raw || typeof raw !== 'object') return null;
  const usage = raw as Record<string, unknown>;
  const promptTokens =
    typeof usage.prompt_tokens === 'number' && usage.prompt_tokens >= 0
      ? Math.floor(usage.prompt_tokens)
      : 0;
  const completionTokens =
    typeof usage.completion_tokens === 'number' && usage.completion_tokens >= 0
      ? Math.floor(usage.completion_tokens)
      : 0;
  return { promptTokens, completionTokens };
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.floor(seconds * 1000);
  }
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    const diff = date - Date.now();
    return diff > 0 ? diff : undefined;
  }
  return undefined;
}

function toLLMError(
  error: unknown,
  endpoint: string,
  model: string,
  context: { stage: string; task: string },
  detail?: string,
  missingContextCaller?: string,
): LLMError {
  if (error instanceof LLMError) return error;

  const status = error instanceof HttpStatusError ? error.status : undefined;
  const retryable = status == null || status >= 500 || status === RATE_LIMIT_STATUS;
  const message = error instanceof Error ? error.message : String(error);
  // When the caller omitted `req.context`, append the captured call site so the
  // error identifies which pipeline step to fix even with generic coordinates.
  const callerNote = missingContextCaller ? ` [caller omitted context: ${missingContextCaller}]` : '';

  return new LLMError({
    code: 'LLM_REQUEST_FAILED',
    message: `LLM request failed: ${message}${detail ?? ''}${callerNote}`,
    stage: context.stage,
    task: context.task,
    retryable,
    cause: {
      status,
      endpoint,
      model,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      ...(missingContextCaller ? { caller: missingContextCaller } : {}),
    },
  });
}

/**
 * First stack frame outside this module — used to identify callers that omit
 * the mandatory request context, so their errors still name a code location.
 */
function captureCallSite(): string | undefined {
  const stack = new Error().stack;
  if (!stack) return undefined;
  for (const line of stack.split('\n').slice(1)) {
    if (line.includes('llm/client')) continue;
    const match = line.match(/\(?([^(\s]+):(\d+):(\d+)\)?\s*$/);
    if (match) return `${match[1]}:${match[2]}`;
  }
  return undefined;
}
