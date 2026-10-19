/**
 * Detection, Inspection, and Installation Utilities for Chromium and Ungoogled Chromium.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import pc from 'picocolors';
import type { ChromiumInstallInfo } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Standard search locations for Chromium binaries on macOS.
 */
const MACOS_CANDIDATE_PATHS = [
  '/Applications/Ungoogled Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  path.join(os.homedir(), 'Applications/Ungoogled Chromium.app/Contents/MacOS/Chromium'),
  path.join(os.homedir(), 'Applications/Chromium.app/Contents/MacOS/Chromium'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  '/opt/homebrew/bin/chromium',
  '/usr/local/bin/chromium',
  '/opt/homebrew/bin/ungoogled-chromium',
  '/usr/local/bin/ungoogled-chromium',
];

/**
 * Standard search locations for Chromium binaries on Linux.
 */
const LINUX_CANDIDATE_PATHS = [
  '/usr/bin/ungoogled-chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/local/bin/chromium',
  '/usr/local/bin/ungoogled-chromium',
  path.join(os.homedir(), '.local/bin/chromium'),
  path.join(os.homedir(), '.local/bin/ungoogled-chromium'),
];

/**
 * Resolves all candidate paths based on platform and environment variables.
 */
export function getSearchPaths(): string[] {
  const customEnvPaths = [process.env.CHROMIUM_PATH, process.env.CHROME_PATH].filter(
    (p): p is string => Boolean(p && p.trim().length > 0)
  );

  const platform = process.platform;
  const platformPaths = platform === 'darwin' ? MACOS_CANDIDATE_PATHS : LINUX_CANDIDATE_PATHS;

  return [...customEnvPaths, ...platformPaths];
}

/**
 * Checks whether a binary path belongs to a Homebrew-installed Ungoogled Chromium cask.
 * The `ungoogled-chromium` cask installs as "Chromium.app" (no "ungoogled" in path or
 * version output), so we detect it by checking the Homebrew Caskroom metadata.
 */
async function isHomebrewUngoogled(binaryPath: string): Promise<boolean> {
  try {
    const caskroom = '/opt/homebrew/Caskroom/ungoogled-chromium';
    const entries = await fs.readdir(caskroom).catch(() => [] as string[]);
    for (const ver of entries) {
      if (ver.startsWith('.')) continue;
      const appPath = path.join(caskroom, ver, 'Chromium.app');
      try {
        // Check if the binary lives inside (or is the same as) the cask's Chromium.app
        const realBinary = await fs.realpath(binaryPath);
        const realApp = await fs.realpath(path.join(appPath, 'Contents', 'MacOS', 'Chromium'));
        if (realBinary === realApp) return true;
      } catch {
        // Try symlink-based check: Caskroom/<ver>/Chromium.app -> /Applications/Chromium.app
        try {
          const link = await fs.readlink(path.join(caskroom, ver, 'Chromium.app'));
          const resolved = path.resolve(path.join(caskroom, ver), link);
          if (binaryPath.startsWith(resolved + '/')) return true;
        } catch {
          // not a symlink or unreadable — skip
        }
      }
    }
  } catch {
    // Caskroom doesn't exist
  }
  return false;
}

/**
 * Inspects a binary path by verifying file accessibility and running `--version`.
 */
export async function inspectChromiumBinary(binaryPath: string): Promise<{
  valid: boolean;
  version: string | null;
  isUngoogled: boolean;
}> {
  try {
    await fs.access(binaryPath, fs.constants.X_OK);
  } catch {
    return { valid: false, version: null, isUngoogled: false };
  }

  try {
    const { stdout } = await execFileAsync(binaryPath, ['--version'], {
      timeout: 5000,
    });
    const versionStr = stdout.trim();
    const isUngoogled =
      binaryPath.toLowerCase().includes('ungoogled') ||
      versionStr.toLowerCase().includes('ungoogled') ||
      (await isHomebrewUngoogled(binaryPath));

    return {
      valid: true,
      version: versionStr,
      isUngoogled,
    };
  } catch {
    // Binary exists and is executable, but --version failed (sandbox/environment restriction)
    const isUngoogled =
      binaryPath.toLowerCase().includes('ungoogled') ||
      (await isHomebrewUngoogled(binaryPath));
    return {
      valid: true,
      version: 'Unknown version',
      isUngoogled,
    };
  }
}

/**
 * Detects installed Chromium or Ungoogled Chromium on the host machine.
 */
export async function detectChromiumInstallation(): Promise<ChromiumInstallInfo> {
  const platform = process.platform;
  const searchPaths = getSearchPaths();

  for (const candidate of searchPaths) {
    const inspected = await inspectChromiumBinary(candidate);
    if (inspected.valid) {
      return {
        found: true,
        path: candidate,
        version: inspected.version,
        isUngoogled: inspected.isUngoogled,
        platform,
        notes: inspected.isUngoogled
          ? 'Ungoogled Chromium detected'
          : 'Standard Chromium detected',
      };
    }
  }

  return {
    found: false,
    path: null,
    version: null,
    isUngoogled: false,
    platform,
    notes: `Chromium executable not found across ${searchPaths.length} standard paths. Set CHROMIUM_PATH or install via homebrew/package manager.`,
  };
}

/**
 * Resolves the Chromium binary path or throws an informative error if absent.
 */
export async function resolveChromiumPath(preferredPath?: string): Promise<string> {
  if (preferredPath) {
    const inspected = await inspectChromiumBinary(preferredPath);
    if (inspected.valid) {
      return preferredPath;
    }
    throw new Error(`Specified Chromium binary is not accessible or executable: ${preferredPath}`);
  }

  const detection = await detectChromiumInstallation();
  if (detection.found && detection.path) {
    return detection.path;
  }

  throw new Error(
    'Chromium executable not found. Please install Ungoogled Chromium or set the CHROMIUM_PATH environment variable.'
  );
}

/**
 * Attempts automated installation of Ungoogled Chromium if package managers are available.
 */
export async function installUngoogledChromium(): Promise<{
  success: boolean;
  message: string;
}> {
  const platform = process.platform;

  if (platform === 'darwin') {
    // Check if Homebrew is available
    let hasBrew = false;
    try {
      await execFileAsync('brew', ['--version']);
      hasBrew = true;
    } catch {
      hasBrew = false;
    }

    if (!hasBrew) {
      return {
        success: false,
        message:
          'Homebrew is not installed. Please install Homebrew or download Ungoogled Chromium manually from:\nhttps://github.com/ungoogled-software/ungoogled-chromium-macos/releases',
      };
    }

    try {
      console.log(pc.cyan('📦 Installing eloston-ungoogled-chromium via Homebrew cask...'));
      const { stdout, stderr } = await execFileAsync('brew', [
        'install',
        '--cask',
        'eloston-ungoogled-chromium',
      ], { timeout: 300000 });

      const verified = await detectChromiumInstallation();
      if (verified.found && verified.path) {
        return {
          success: true,
          message: `Ungoogled Chromium installed successfully at: ${verified.path}`,
        };
      }
      return {
        success: true,
        message: `Brew install completed:\n${stdout || stderr}`,
      };
    } catch (err: any) {
      return {
        success: false,
        message: `Homebrew installation failed: ${err.message}`,
      };
    }
  } else if (platform === 'linux') {
    return {
      success: false,
      message:
        'Automated installation on Linux requires elevated root privileges. Please install via your package manager:\n' +
        '  Debian/Ubuntu: sudo apt update && sudo apt install -y chromium\n' +
        '  Arch Linux: sudo pacman -S ungoogled-chromium\n' +
        '  Or download portable binaries from: https://github.com/ungoogled-software/ungoogled-chromium-portable-linux/releases',
    };
  }

  return {
    success: false,
    message: `Automated installation is not supported on platform: ${platform}`,
  };
}
