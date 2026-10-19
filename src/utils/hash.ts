import { createHash } from 'node:crypto';
import { stableStringify } from './json.js';

export function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Digest of a value's structure, independent of key ordering. */
export function hashObject(value: unknown): string {
  return sha256(stableStringify(value));
}

export function shortHash(input: string | Uint8Array, length = 8): string {
  return sha256(input).slice(0, length);
}
