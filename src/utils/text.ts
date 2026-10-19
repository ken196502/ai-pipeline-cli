export function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

export function slugify(input: string, maxLength = 60): string {
  const slug = normalizeWhitespace(input)
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, maxLength).replace(/-+$/g, '') || 'untitled';
}

export function truncate(input: string, maxLength: number, ellipsis = '…'): string {
  if (input.length <= maxLength) return input;
  return input.slice(0, Math.max(0, maxLength - ellipsis.length)) + ellipsis;
}

export function wordCount(input: string): number {
  const normalized = normalizeWhitespace(input);
  if (!normalized) return 0;
  const cjk = normalized.match(/[一-龥]/g)?.length ?? 0;
  const latin = normalized.replace(/[一-龥]/g, ' ').trim();
  const latinWords = latin ? latin.split(/\s+/).length : 0;
  return cjk + latinWords;
}

export function stripAnsi(input: string): string {
  return input.replace(/\[[0-9;]*[a-zA-Z]/g, '');
}

export function formatTable(
  headers: string[],
  rows: (string | number | undefined | null)[][]
): string {
  const allRows = [headers, ...rows.map((r) => r.map((c) => String(c ?? '')))];
  const colWidths = headers.map((_, colIdx) =>
    Math.max(...allRows.map((row) => stripAnsi(row[colIdx] ?? '').length), 3)
  );

  const formatRow = (row: string[]) =>
    row
      .map((cell, idx) => {
        const width = colWidths[idx];
        const visibleLen = stripAnsi(cell).length;
        const pad = ' '.repeat(Math.max(0, width - visibleLen));
        return cell + pad;
      })
      .join('  ');

  const separator = colWidths.map((w) => '-'.repeat(w)).join('  ');
  const headerLine = formatRow(headers);
  const dataLines = rows.map((r) => formatRow(r.map((c) => String(c ?? ''))));

  return [headerLine, separator, ...dataLines].join('\n');
}

/**
 * Strong-profanity pattern for LLM provider content-filter compliance
 * (e.g. Volcengine Ark rejects requests with SensitiveContentDetected).
 * Word-bounded to avoid false positives like "Scunthorpe" or "class".
 */
const PROFANITY_PATTERN =
  /\b(f+u+c+k+(?:i?n?g'?|e?[rd])?|m[o0]+therf+u+c+k+(?:i?n?g'?)?|s+h+[i1!]+t+(?:t?y|s)?|b+[i1]+t+c+h+(?:e?s?)?|c+u+n+t|d+[i1]+c+k(?:s|head)?|a+s+s+h[o0]+l+e+|b+u+l+l+s+h+[i1]+t|w+t+f|c[o0]+c+k(?:s)?|pr[i1]ck|tw[a4]t)\b/gi;

/**
 * Masks strong profanity in LLM-facing text: keeps the first letter, asterisks
 * the rest (e.g. "FUCKING" -> "F******"). Deterministic; never used for
 * user-facing or evidence-preserving outputs.
 */
export function maskProfanity(input: string): { text: string; maskedCount: number } {
  let maskedCount = 0;
  const text = input.replace(PROFANITY_PATTERN, (word) => {
    maskedCount += 1;
    return word[0] + '*'.repeat(Math.max(2, word.length - 1));
  });
  return { text, maskedCount };
}
