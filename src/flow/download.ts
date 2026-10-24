/**
 * Exactly-once, verified downloads for freshly generated Google Flow media.
 *
 * Every generated video (and keyframe image) is downloaded IMMEDIATELY after it is
 * synthesized — one download per generated media file:
 *
 *   - exactly once: a valid file already on disk is never downloaded again
 *     (safe across resume runs and retried steps);
 *   - verified: the file must really exist and be at least `minBytes` large,
 *     half-written / error payloads are deleted and retried;
 *   - loud: after `retries` attempts a descriptive error is thrown — a missing file
 *     is never silently recorded as a local path.
 */
import { mkdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

export interface EnsureDownloadOptions {
  /** Source URL of the freshly generated media. */
  url: string;
  /** Destination file path. */
  outputPath: string;
  /** Provider-specific fetch (in-page fetch for Puppeteer, HTTP fetch for the extension). */
  download: (url: string, outputPath: string) => Promise<void>;
  /** Total download attempts (default 3). */
  retries?: number;
  /** Base delay between attempts, grows linearly with the attempt (default 2000ms). */
  retryDelayMs?: number;
  /** Payloads smaller than this are treated as error responses (default 100 bytes). */
  minBytes?: number;
}

export interface DownloadedFile {
  /** Verified local file path. */
  outputPath: string;
  /** File size in bytes. */
  bytes: number;
  /** True when a valid file was already on disk and NO download ran (exactly once). */
  alreadyPresent: boolean;
  /** Number of download attempts actually performed (0 when already present). */
  attempts: number;
}

async function fileSize(filePath: string): Promise<number | null> {
  try {
    const s = await stat(filePath);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

/**
 * Downloads `url` to `outputPath` exactly once and verifies the resulting file.
 */
export async function ensureFileDownloaded(options: EnsureDownloadOptions): Promise<DownloadedFile> {
  const resolved = path.resolve(options.outputPath);
  const minBytes = options.minBytes ?? 100;
  const retries = Math.max(1, options.retries ?? 3);
  const retryDelayMs = options.retryDelayMs ?? 2_000;

  await mkdir(path.dirname(resolved), { recursive: true });

  // Exactly-once: a valid file already on disk is never downloaded again.
  const existing = await fileSize(resolved);
  if (existing !== null && existing >= minBytes) {
    return { outputPath: resolved, bytes: existing, alreadyPresent: true, attempts: 0 };
  }

  let lastError = 'unknown error';
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await options.download(options.url, resolved);

      const size = await fileSize(resolved);
      if (size === null) {
        lastError = `download reported success but ${resolved} does not exist`;
      } else if (size < minBytes) {
        lastError = `downloaded file is too small (${size} bytes < ${minBytes} bytes) — likely an error payload`;
        await unlink(resolved).catch(() => {});
      } else {
        return { outputPath: resolved, bytes: size, alreadyPresent: false, attempts: attempt };
      }
    } catch (err: any) {
      lastError = err?.message || String(err);
      await unlink(resolved).catch(() => {});
    }

    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
    }
  }

  throw new Error(
    `Failed to download "${options.url.slice(0, 120)}" to ${resolved} after ${retries} attempt(s): ${lastError}`
  );
}
