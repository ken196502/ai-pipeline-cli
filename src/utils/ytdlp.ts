import { exec, execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import pc from 'picocolors';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

/**
 * Augments process.env.PATH with common tool binary locations (e.g. ~/.pi/agent/bin, ~/.local/bin)
 * if they exist on disk, ensuring spawned subshells and child processes resolve tools reliably.
 */
export function ensureStandardBinaryPaths(): void {
  const home = process.env.HOME || '';
  const candidateDirs = [
    path.join(home, '.pi/agent/bin'),
    path.join(home, '.local/bin'),
    path.join(home, '.cargo/bin'),
    '/usr/local/bin',
    '/usr/bin',
    '/opt/homebrew/bin',
  ];

  const currentParts = (process.env.PATH || '').split(path.delimiter);
  const toPrepend: string[] = [];

  for (const dir of candidateDirs) {
    if (fsSync.existsSync(dir) && !currentParts.includes(dir)) {
      toPrepend.push(dir);
    }
  }

  if (toPrepend.length > 0) {
    process.env.PATH = [...toPrepend, process.env.PATH || ''].join(path.delimiter);
  }
}

// Auto-run once upon module load
ensureStandardBinaryPaths();

export interface YtDlpVerificationResult {
  usable: boolean;
  reason: string;
  ytDlpVersion?: string;
  output?: string;
  rawError?: string;
}

/**
 * Finds the path to uv executable.
 */
export async function findUvPath(): Promise<string | null> {
  const candidates = [
    process.env.UV_PATH,
    'uv',
    path.join(process.env.HOME || '', '.local/bin/uv'),
    '/opt/homebrew/bin/uv',
    '/usr/local/bin/uv',
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      const { stdout } = await execAsync(`which "${candidate}" 2>/dev/null || true`);
      const resolved = stdout.trim();
      if (resolved) {
        return resolved;
      }
    } catch {
      // Continue searching
    }
  }
  return null;
}

/**
 * Finds the path to yt-dlp executable.
 */
export async function findYtDlpPath(): Promise<string | null> {
  ensureStandardBinaryPaths();

  const candidates = [
    process.env.YTDLP_PATH,
    path.join(process.env.HOME || '', '.pi/agent/bin/yt-dlp'),
    path.join(process.env.HOME || '', '.local/bin/yt-dlp'),
    path.join(process.env.HOME || '', '.cargo/bin/yt-dlp'),
    '/usr/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    '/opt/homebrew/bin/yt-dlp',
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fsSync.constants.X_OK);
      return candidate;
    } catch {
      // Continue searching
    }
  }

  // Check if yt-dlp is available in current PATH
  try {
    const { stdout } = await execAsync('which yt-dlp 2>/dev/null || true');
    const resolved = stdout.trim();
    if (resolved && fsSync.existsSync(resolved)) {
      return resolved;
    }
  } catch {
    // Continue searching
  }

  return null;
}

/**
 * Resolves yt-dlp binary path, ensuring it is present.
 */
export async function resolveYtDlpBinary(): Promise<string> {
  const bin = await findYtDlpPath();
  if (bin) return bin;
  return ensureYtDlp();
}


/**
 * Ensures yt-dlp is installed using uv.
 */
export async function ensureYtDlp(): Promise<string> {
  let ytDlpPath = await findYtDlpPath();
  if (ytDlpPath) {
    try {
      const { stdout } = await execFileAsync(ytDlpPath, ['--version']);
      const version = stdout.trim();
      return ytDlpPath;
    } catch {
      // If found path failed, reinstall/update via uv
    }
  }

  const uvPath = await findUvPath();
  if (!uvPath) {
    throw new Error(
      'Neither yt-dlp nor uv was found. Please install uv (https://astral.sh/uv) or install yt-dlp.'
    );
  }

  await execAsync(`"${uvPath}" tool install yt-dlp`);

  ytDlpPath = await findYtDlpPath();
  if (!ytDlpPath) {
    const fallbackPath = path.join(process.env.HOME || '', '.local/bin/yt-dlp');
    try {
      await fs.access(fallbackPath);
      ytDlpPath = fallbackPath;
    } catch {
      throw new Error('Failed to locate yt-dlp after running "uv tool install yt-dlp".');
    }
  }

  return ytDlpPath;
}

/**
 * Uses yt-dlp to test if the provided cookies.txt can authenticate with YouTube.
 */
export async function verifyCookiesWithYtDlp(
  ytDlpPath: string,
  cookieFilePath: string,
  testUrl: string = 'https://www.youtube.com/feed/history',
  proxyUrl?: string
): Promise<YtDlpVerificationResult> {
  try {
    const { stdout: versionOut } = await execFileAsync(ytDlpPath, ['--version']);
    const ytDlpVersion = versionOut.trim();

    const noProxyRequested =
      proxyUrl === 'none' ||
      proxyUrl === 'direct' ||
      proxyUrl === '' ||
      process.env.YTDLP_NO_PROXY === '1' ||
      process.env.YTDLP_NO_PROXY === 'true';

    let resolvedProxy: string | null = null;
    if (!noProxyRequested) {
      resolvedProxy =
        proxyUrl ??
        process.env.PROXY_URL ??
        process.env.ALL_PROXY ??
        process.env.all_proxy ??
        process.env.HTTPS_PROXY ??
        process.env.https_proxy ??
        process.env.HTTP_PROXY ??
        process.env.http_proxy ??
        null;

      if (resolvedProxy === 'none' || resolvedProxy === 'direct' || resolvedProxy === '') {
        resolvedProxy = null;
      }
    }

    const args = [
      '--cookies',
      cookieFilePath,
      '-v',
      '--skip-download',
      '--flat-playlist',
      '--playlist-items',
      '1',
    ];

    if (resolvedProxy) {
      args.push('--proxy', resolvedProxy);
    } else if (noProxyRequested) {
      args.push('--proxy', '');
    }

    args.push(testUrl);

    const { stdout, stderr } = await execFileAsync(ytDlpPath, args, {
      timeout: 25000,
    });

    const combinedOutput = `${stdout}\n${stderr}`;

    // If yt-dlp completed successfully (exit code 0), the cookies are usable.
    // yt-dlp may print a warning about rotated cookies even when it successfully
    // authenticates and downloads the playlist — treating warnings as fatal
    // triggers false re-login prompts.
    if (
      combinedOutput.includes('Finished downloading playlist') ||
      combinedOutput.includes('Downloading playlist')
    ) {
      return {
        usable: true,
        reason: 'yt-dlp successfully queried YouTube with the provided cookies.',
        ytDlpVersion,
        output: combinedOutput,
      };
    }

    if (combinedOutput.includes('The provided YouTube account cookies are no longer valid')) {
      return {
        usable: false,
        reason: 'YouTube reported that the cookies are no longer valid (likely rotated or revoked).',
        ytDlpVersion,
        output: combinedOutput,
      };
    }

    if (combinedOutput.includes('Sign in to confirm you’re not a bot')) {
      return {
        usable: false,
        reason: 'YouTube prompted bot verification / sign-in required.',
        ytDlpVersion,
        output: combinedOutput,
      };
    }

    return {
      usable: true,
      reason: 'yt-dlp successfully queried YouTube with the provided cookies.',
      ytDlpVersion,
      output: combinedOutput,
    };
  } catch (error: any) {
    const output = `${error.stdout || ''}\n${error.stderr || ''}\n${error.message || ''}`;

    if (output.includes('The provided YouTube account cookies are no longer valid')) {
      return {
        usable: false,
        reason: 'YouTube account cookies have expired or been rotated by YouTube.',
        output,
        rawError: error.message,
      };
    }

    if (output.includes('Sign in to confirm you’re not a bot')) {
      return {
        usable: false,
        reason: 'YouTube requires sign in / bot verification.',
        output,
        rawError: error.message,
      };
    }

    if (output.includes('Private video') || output.includes('Sign in')) {
      return {
        usable: false,
        reason: 'Authentication failed (Sign in required).',
        output,
        rawError: error.message,
      };
    }

    return {
      usable: false,
      reason: `yt-dlp execution error: ${error.message}`,
      output,
      rawError: error.message,
    };
  }
}
