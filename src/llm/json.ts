/**
 * Public structured-output decoding: strip markdown fences, isolate balanced JSON object/array,
 * validate with Zod, and construct repair turns on schema failure.
 */
import { z } from 'zod';
import { LLMError, type ChatMessage } from './client.js';
import type { JsonExtraction } from './types.js';

export { type JsonExtraction };

/**
 * Isolates the first balanced JSON object or array in a raw reply string.
 * Quotes and escape characters are respected so braces/brackets in string
 * literals (e.g. OCR text, prompts, code examples) are not counted.
 *
 * The balanced segment is parsed strictly first. LLMs occasionally emit
 * near-valid JSON with a trailing comma before `}`/`]` or with JS-style
 * comments; those two deviations are removed deterministically (only outside
 * string literals) and parsing is retried once. Anything else still fails
 * loudly, with the original parser error plus context around the failing
 * position so the bad segment can be diagnosed from logs alone.
 */
export function extractJsonObject(raw: string): JsonExtraction {
  const text = stripFences(raw);
  const start = firstStructuralIndex(text);
  if (start === -1) {
    return { ok: false, reason: 'No JSON object or array found in response' };
  }

  const open = text[start] as '{' | '[';
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === open) {
      depth += 1;
    } else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        return parseBalancedCandidate(text.slice(start, i + 1));
      }
    }
  }

  return { ok: false, reason: 'Unterminated JSON object or array' };
}

/**
 * Parses one balanced JSON segment. Falls back to a deterministic sanitation
 * pass for the two safe-to-remove LLM deviations (trailing commas, JS-style
 * comments); genuine syntax errors are reported with positional context.
 */
function parseBalancedCandidate(candidate: string): JsonExtraction {
  try {
    return { ok: true, value: JSON.parse(candidate) };
  } catch (originalError) {
    const originalMessage =
      originalError instanceof Error
        ? originalError.message
        : 'Unparsable JSON segment';

    const sanitized = sanitizeJsonText(candidate);
    if (sanitized.removedTrailingCommas > 0 || sanitized.removedComments > 0) {
      try {
        const value = JSON.parse(sanitized.text);
        console.warn(
          `[llm/json] model reply contained non-strict JSON; removed ` +
            `${sanitized.removedTrailingCommas} trailing comma(s) and ` +
            `${sanitized.removedComments} comment(s) before successful parse`,
        );
        return { ok: true, value };
      } catch {
        // Sanitized text was still broken — report the original error below.
      }
    }

    return {
      ok: false,
      reason: `${originalMessage} | near: ${contextAtErrorPosition(candidate, originalMessage)}`,
    };
  }
}

/**
 * Removes LLM-specific JSON deviations, quote/escape-aware so punctuation
 * inside string literals (URLs, comments in review text, e.g. "a,}" or
 * "https://x//y") is never touched. Only two transformations are applied,
 * both unambiguous in JSON grammar which has no comments or trailing commas:
 * 1. a comma followed by optional whitespace then `}` or `]`
 * 2. JS-style comments: `//` to end-of-line, or `/*` up to its closing star-slash delimiter
 */
export function sanitizeJsonText(text: string): {
  text: string;
  removedTrailingCommas: number;
  removedComments: number;
} {
  let out = '';
  let inString = false;
  let escaped = false;
  let removedTrailingCommas = 0;
  let removedComments = 0;
  let i = 0;

  while (i < text.length) {
    const char = text[i];

    if (inString) {
      out += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      i += 1;
      continue;
    }

    if (char === '/' && text[i + 1] === '/') {
      removedComments += 1;
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }

    if (char === '/' && text[i + 1] === '*') {
      removedComments += 1;
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i = Math.min(i + 2, text.length);
      continue;
    }

    if (char === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text[j] === '}' || text[j] === ']') {
        removedTrailingCommas += 1;
        i += 1;
        continue;
      }
    }

    out += char;
    i += 1;
  }

  return { text: out, removedTrailingCommas, removedComments };
}

/** Bounded single-line context around the V8 JSON error position, for logs. */
function contextAtErrorPosition(text: string, errorMessage: string, radius = 80): string {
  const match = /position (\d+)/.exec(errorMessage);
  const pos = match ? Number(match[1]) : 0;
  const from = Math.max(0, pos - radius);
  const to = Math.min(text.length, pos + radius);
  return JSON.stringify(text.slice(from, to));
}

/**
 * Extract and validate raw model output against a Zod schema.
 */
export function decodeJson<S extends z.ZodTypeAny>(
  raw: string,
  schema: S,
  context: {
    code?: string;
    stage?: string;
    task?: string;
    retryable?: boolean;
    preprocess?: (value: unknown) => unknown;
  } = {},
): z.infer<S> {
  const stage = context.stage ?? 'llm';
  const task = context.task ?? 'decode-json';
  const extracted = extractJsonObject(raw);

  if (extracted.ok) {
    const candidate = context.preprocess
      ? context.preprocess(extracted.value)
      : extracted.value;
    const checked = schema.safeParse(candidate);
    if (checked.success) {
      return checked.data;
    }

    throw new LLMError({
      code: context.code ?? 'LLM_RESPONSE_INVALID',
      message: `Model reply failed ${task} schema validation`,
      stage,
      task,
      retryable: context.retryable ?? false,
      cause: {
        issues: checked.error.issues.slice(0, 5).map((issue) => ({
          path: issue.path.join('.') || '<root>',
          message: issue.message,
        })),
        snippet: snippetOf(raw),
      },
    });
  }

  throw new LLMError({
    code: context.code ?? 'LLM_RESPONSE_INVALID',
    message: `Model reply for ${task} was not valid JSON (${extracted.reason})`,
    stage,
    task,
    retryable: context.retryable ?? false,
    cause: { snippet: snippetOf(raw) },
  });
}

/** One-shot repair message naming specific validation failures. */
export function repairJsonMessage(errors: readonly string[], attempt = 1): ChatMessage {
  return {
    role: 'user',
    content: [
      'Your previous reply failed JSON validation.',
      `Repair attempt ${attempt}: reply with ONLY the corrected JSON object matching the schema.`,
      ...errors.slice(0, 8).map((err) => `- ${err}`),
    ].join('\n'),
  };
}

/** Generic repair message. */
export function repairMessage(): ChatMessage {
  return {
    role: 'user',
    content:
      'Your previous reply was not valid JSON matching the schema. ' +
      'Reply with ONLY the raw JSON object, without markdown formatting or conversational text.',
  };
}

/** Bounded snippet safe to persist in error causes. */
export function snippetOf(raw: string, max = 1024): string {
  return raw.replace(/\n+/g, ' ').slice(0, max);
}

export function stripFences(raw: string): string {
  let text = raw.trim();
  const fence = text.indexOf('```');
  if (fence === -1) return text;
  const firstLineEnd = text.indexOf('\n', fence);
  const start = firstLineEnd === -1 ? fence + 3 : firstLineEnd + 1;
  const end = text.lastIndexOf('```');
  text = text.slice(start, end > start ? end : text.length).trim();
  return text;
}

export function firstStructuralIndex(text: string): number {
  const brace = text.indexOf('{');
  const bracket = text.indexOf('[');
  if (brace === -1) return bracket;
  if (bracket === -1) return brace;
  return Math.min(brace, bracket);
}
