/**
 * Identifier and sequence generator utilities.
 */

export function sequentialId(prefix: string, index: number, pad = 3): string {
  const safePrefix = prefix.replace(/-+$/, '');
  const padded = index.toString().padStart(pad, '0');
  return `${safePrefix}-${padded}`;
}
