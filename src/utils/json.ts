/**
 * Deterministic stringify and JSON parsing helpers.
 */

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();

  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const entry = source[key];
    if (entry === undefined) continue;
    sorted[key] = sortValue(entry);
  }
  return sorted;
}

export type JsonParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function tryParseJson<T = unknown>(raw: string): JsonParseResult<T> {
  try {
    return { ok: true, value: JSON.parse(raw) as T };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
