/**
 * Duplicate-clip detection for Flow batch generation.
 *
 * Flow can hand back a stale/duplicate result — an already-generated video
 * (re-signed URL, same CDN object) or byte-identical content — especially
 * around page refreshes or backend request deduplication. Stitching such a
 * clip into the final video silently produces a broken "repeating segments"
 * master (observed: run viral-1791900784598-797ux0, clips 5–7 were duplicates
 * of clips 1–2).
 *
 * This guard tracks every completed clip by (a) canonical Flow video identity
 * and (b) file content hash, so any repeat is rejected loudly at generation
 * time instead of slipping into the final cut.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { canonicalFlowVideoId } from './observer.js';

export interface PriorClipRef {
  label: string;
  videoUrl?: string | null;
  localVideoPath?: string | null;
}

/** SHA-1 hex digest of a media file, or null when the file is unreadable. */
export async function hashMediaFile(filePath: string): Promise<string | null> {
  try {
    const buf = await readFile(filePath);
    return createHash('sha1').update(buf).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Extracts the true media UUID from a Flow media URL
 * (https://flow-content.google/image/<uuid>?… or …/video/<uuid>?…).
 *
 * The Flow canvas recycles tile elements, so a freshly generated card can carry a
 * STALE data-media-id attribute while its <img src> already points at the new
 * media. The src URL is the freshest identity signal — prefer it over DOM keys
 * (observed: run viral-1791900784598-797ux0 recorded the stale key 6fcdeb5e for
 * three different fresh images).
 */
export function mediaUuidFromSrc(src: string | null | undefined): string | null {
  if (!src) return null;
  const m = src.match(/\/(?:image|video)\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i);
  return m ? m[1].toLowerCase() : null;
}

export const MEDIA_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

/**
 * Canonical identity tokens of a media reference (tile key or media src):
 * the embedded media UUID and the origin+path with the signed query stripped.
 * Volatile forms (raw signed srcs, blob:/data: URLs) are excluded so that
 * re-mounted or re-signed OLD media does not look fresh on the virtualized
 * Flow canvas.
 */
export function canonicalMediaTokens(value: string | null | undefined): string[] {
  if (!value) return [];
  const s = String(value);
  const out = new Set<string>();
  const m = s.match(MEDIA_UUID_RE);
  if (m) out.add(m[0].toLowerCase());
  if (/^(https?:)?\/\//i.test(s)) {
    try {
      const p = new URL(s);
      out.add(p.origin + p.pathname);
    } catch {
      // keep uuid/raw tokens only
    }
  }
  if (!s.includes('?') && !s.startsWith('blob:') && !s.startsWith('data:')) out.add(s);
  return [...out].filter((t) => !t.includes('?') && !t.startsWith('blob:') && !t.startsWith('data:'));
}

/**
 * Resolves the most truthful identity for a generated keyframe image:
 * 1. media UUID parsed from the src URL (flow-content …/image/<uuid>);
 * 2. `file:<sha1>` of the downloaded file — fresh canvas tiles sometimes expose
 *    only a proxied `/asb/…` src with no UUID, and recycled tiles carry stale
 *    attribute keys, so the downloaded bytes are the only reliable identity;
 * 3. the DOM-reported media key as a last resort.
 */
export async function resolveMediaKey(
  imageUrl: string | null,
  imageOutputPath: string | null,
  fallbackKey: string | null
): Promise<string | null> {
  const uuid = mediaUuidFromSrc(imageUrl);
  if (uuid) return uuid;
  if (imageOutputPath) {
    const hash = await hashMediaFile(imageOutputPath);
    if (hash) return `file:${hash}`;
  }
  return fallbackKey;
}

export class ClipDuplicateGuard {
  private readonly videoIds = new Map<string, string>(); // canonical video id -> owning clip label
  private readonly hashes = new Map<string, string>();   // content sha1 -> owning clip label

  private constructor() {}

  /** Seeds the guard with clips already marked completed (e.g. from a prior session). */
  static async seed(completed: PriorClipRef[]): Promise<ClipDuplicateGuard> {
    const guard = new ClipDuplicateGuard();
    for (const ref of completed) {
      await guard.add(ref);
    }
    return guard;
  }

  private async add(ref: PriorClipRef): Promise<void> {
    if (ref.videoUrl) {
      const id = canonicalFlowVideoId(ref.videoUrl);
      if (id && !this.videoIds.has(id)) this.videoIds.set(id, ref.label);
    }
    if (ref.localVideoPath) {
      const hash = await hashMediaFile(ref.localVideoPath);
      if (hash && !this.hashes.has(hash)) this.hashes.set(hash, ref.label);
    }
  }

  /**
   * Checks a freshly generated clip against everything registered so far and —
   * when unique — registers it. Returns a human-readable duplicate description
   * (e.g. "same Flow video object as clip-002") or null when the clip is unique.
   */
  async register(ref: PriorClipRef): Promise<string | null> {
    if (ref.videoUrl) {
      const prior = this.videoIds.get(canonicalFlowVideoId(ref.videoUrl));
      if (prior) return `same Flow video object as ${prior}`;
    }
    if (ref.localVideoPath) {
      const hash = await hashMediaFile(ref.localVideoPath);
      if (hash) {
        const prior = this.hashes.get(hash);
        if (prior) return `byte-identical content to ${prior}`;
      }
    }
    await this.add(ref);
    return null;
  }
}
