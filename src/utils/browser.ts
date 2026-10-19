/**
 * Browser profile and environment utilities.
 * Ensures strict adherence to persistent Ungoogled Chromium profile policy (./.chromium-profile).
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveChromiumPath } from '../browser/installer.js';
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
          if (pkg.name === 'xhot' || pkg.name === 'yt-cookie-exporter' || (pkg.bin && (pkg.bin['xhot'] || pkg.bin['flow-cli']))) {
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
 * Resolves the persistent Chromium profile directory.
 * Defaults to the repository's ./.chromium-profile (shared across YouTube and Google Flow SSO).
 */
export function resolveProfileDir(specifiedDir?: string): string {
  loadEnvFile();
  const target = specifiedDir || process.env.CHROMIUM_PROFILE_DIR || process.env.FLOW_PROFILE_DIR || DEFAULT_PERSISTENT_PROFILE;
  return path.resolve(target);
}

/**
 * Ensures the persistent profile directory exists on disk.
 */
export async function ensureProfileDir(specifiedDir?: string): Promise<string> {
  const resolved = resolveProfileDir(specifiedDir);
  await fs.mkdir(resolved, { recursive: true });
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
