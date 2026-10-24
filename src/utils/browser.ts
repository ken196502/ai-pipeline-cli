/**
 * Browser profile and environment utilities.
 * Ensures strict adherence to persistent Ungoogled Chromium profile policy (./.chromium-profile).
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import pc from 'picocolors';
import { resolveChromiumPath } from '../libs/browser/installer.js';
import { loadEnvFile } from '../env.js';

/**
 * Finds the project root directory (containing package.json for videogen).
 */
export function getProjectRootDir(): string {
  try {
    let curr: string;
    if (typeof __dirname !== 'undefined') {
      curr = path.resolve(__dirname);
    } else if (import.meta.url) {
      curr = path.dirname(fileURLToPath(import.meta.url));
    } else {
      curr = process.cwd();
    }

    while (curr !== path.dirname(curr)) {
      if (fsSync.existsSync(path.join(curr, 'package.json'))) {
        try {
          const pkg = JSON.parse(fsSync.readFileSync(path.join(curr, 'package.json'), 'utf8'));
          if (pkg.name === 'aigc-pipeline' || pkg.name === 'xhot' || pkg.name === 'yt-cookie-exporter' || (pkg.bin && (pkg.bin['aigc'] || pkg.bin['xhot'] || pkg.bin['flow-cli']))) {
            return curr;
          }
        } catch {}
      }
      curr = path.dirname(curr);
    }
  } catch {}
  return process.cwd();
}

export const DEFAULT_PERSISTENT_PROFILE = path.join(getProjectRootDir(), '.chromium-profile');

/**
 * Searches system locations for an existing logged-in Chromium / Chrome profile.
 */
export function findSystemProfileSource(): string | null {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.config', 'chromium'),
    path.join(home, '.config', 'google-chrome'),
    path.join(home, '.config', 'chromium-browser'),
  ];

  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) {
      const defaultDir = path.join(candidate, 'Default');
      const cookiesPath1 = path.join(defaultDir, 'Cookies');
      const cookiesPath2 = path.join(defaultDir, 'Network', 'Cookies');
      if (fsSync.existsSync(cookiesPath1) || fsSync.existsSync(cookiesPath2)) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Recursively copies a Chromium profile directory, omitting lock and ephemeral metric files.
 */
export async function copyProfileDir(
  src: string,
  dst: string,
  options: { extraIgnore?: Iterable<string> } = {}
): Promise<number> {
  const ignoreFileNames = new Set([
    'SingletonLock',
    'SingletonCookie',
    'SingletonSocket',
    'LOCK',
    'BrowserMetrics-spare.pma',
  ]);
  for (const name of options.extraIgnore ?? []) {
    ignoreFileNames.add(name);
  }

  let copiedCount = 0;
  await fs.mkdir(dst, { recursive: true });

  async function walkAndCopy(currentSrc: string, currentDst: string): Promise<void> {
    const entries = await fs.readdir(currentSrc, { withFileTypes: true });
    for (const entry of entries) {
      if (ignoreFileNames.has(entry.name) || entry.name.endsWith('.pma') || entry.name.endsWith('.tmp')) {
        continue;
      }
      const srcPath = path.join(currentSrc, entry.name);
      const dstPath = path.join(currentDst, entry.name);

      if (entry.isDirectory()) {
        await fs.mkdir(dstPath, { recursive: true });
        await walkAndCopy(srcPath, dstPath);
      } else if (entry.isFile()) {
        try {
          await fs.copyFile(srcPath, dstPath);
          copiedCount++;
        } catch {
          // ignore busy/ephemeral file errors
        }
      }
    }
  }

  await walkAndCopy(src, dst);
  return copiedCount;
}

/**
 * Resolves the persistent Chromium profile directory.
 * Defaults to the repository's ./.chromium-profile (shared across YouTube and Google Flow SSO).
 */
export function resolveProfileDir(specifiedDir?: string): string {
  loadEnvFile();
  const target = specifiedDir || process.env.CHROMIUM_PROFILE_DIR || process.env.FLOW_PROFILE_DIR || DEFAULT_PERSISTENT_PROFILE;
  return path.resolve(target);
}

/**
 * Deletes the target profile and re-clones it from the system Chromium profile.
 * Returns the source path and copied file count, or null when no system profile
 * is available (or it is the same directory).
 */
export async function resetProfileFromSystem(
  specifiedDir?: string
): Promise<{ source: string; copied: number } | null> {
  const resolved = resolveProfileDir(specifiedDir);
  const systemSource = findSystemProfileSource();
  if (!systemSource || path.resolve(systemSource) === path.resolve(resolved)) {
    return null;
  }
  console.log(pc.yellow(`[browser] Deleting profile "${resolved}" and re-cloning from "${systemSource}"...`));
  await fs.rm(resolved, { recursive: true, force: true });
  const copied = await copyProfileDir(systemSource, resolved, {
    extraIgnore: ['.browser-session.json'],
  });
  console.log(pc.green(`[browser] ✔ Cloned ${copied} files from ${systemSource} → ${resolved}`));
  return { source: systemSource, copied };
}

/**
 * Ensures the persistent profile directory exists on disk.
 * If the profile does not exist or lacks session data, automatically copies from the system profile.
 */
export async function ensureProfileDir(specifiedDir?: string): Promise<string> {
  const resolved = resolveProfileDir(specifiedDir);
  const exists = fsSync.existsSync(resolved);
  const defaultDir = path.join(resolved, 'Default');
  const hasCookies =
    fsSync.existsSync(path.join(defaultDir, 'Cookies')) ||
    fsSync.existsSync(path.join(defaultDir, 'Network', 'Cookies'));

  if (!exists || !hasCookies) {
    const systemSource = findSystemProfileSource();
    if (systemSource && path.resolve(systemSource) !== path.resolve(resolved)) {
      console.log(
        pc.cyan(
          `[browser] Profile at "${resolved}" is empty or missing session. Auto-cloning system Chromium profile from "${systemSource}"...`
        )
      );
      try {
        const fileCount = await copyProfileDir(systemSource, resolved);
        console.log(
          pc.green(
            `✔ Successfully cloned ${fileCount} files from system Chromium profile to "${resolved}".`
          )
        );
      } catch (err: any) {
        console.warn(
          pc.yellow(
            `[browser] Warning: Failed to clone system profile (${err.message}). Creating fresh empty directory.`
          )
        );
        await fs.mkdir(resolved, { recursive: true });
      }
    } else {
      await fs.mkdir(resolved, { recursive: true });
    }
  } else {
    await fs.mkdir(resolved, { recursive: true });
  }

  return resolved;
}

/**
 * Checks the status and readiness of a Chromium persistent profile.
 */
export async function checkProfileReady(specifiedDir?: string): Promise<{
  exists: boolean;
  path: string;
  hasCookies: boolean;
  hasStorage: boolean;
  subdirectories: string[];
}> {
  const profilePath = resolveProfileDir(specifiedDir);
  let exists = false;
  let hasCookies = false;
  let hasStorage = false;
  let subdirectories: string[] = [];

  try {
    const stat = await fs.stat(profilePath);
    exists = stat.isDirectory();
    if (exists) {
      const entries = await fs.readdir(profilePath);
      subdirectories = entries;
      hasCookies = entries.some((e: string) => e.toLowerCase().includes('cookie') || e === 'Default');
      hasStorage = entries.some((e: string) => e.toLowerCase().includes('storage') || e === 'IndexedDB');
    }
  } catch {
    exists = false;
  }

  return {
    exists,
    path: profilePath,
    hasCookies,
    hasStorage,
    subdirectories,
  };
}

export { resolveChromiumPath };
