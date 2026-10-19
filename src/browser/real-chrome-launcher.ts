/**
 * Real Chrome Launcher — launches a genuine Chrome/Chromium process
 * WITHOUT CDP remote debugging, using persistent profile with the extension loaded.
 *
 * The browser runs as a fully normal user process.
 * All automation happens via:
 *   - Chrome Extension (DOM observation, anti-detection patches at document_start)
 *   - Native Messaging Host (bridge between extension and Node.js)
 *   - xdotool (OS-level mouse/keyboard input)
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { NativeBridge } from './native-bridge.js';

const execFileAsync = promisify(execFile);

export interface RealChromeOptions {
  /** Path to Chrome/Chromium executable. Auto-detected if omitted. */
  executablePath?: string;
  /** Persistent user data directory (profile). Reuses existing login cookies. */
  profileDir?: string;
  /** Path to the VideoGen extension directory. */
  extensionPath?: string;
  /** Initial URL to open. */
  url?: string;
  /** Window size. */
  windowSize?: { width: number; height: number };
  /** Proxy server URL. */
  proxyServer?: string;
  /** Extra Chrome args. */
  extraArgs?: string[];
  /** Whether to reuse existing Chrome process on same profile. */
  reuseExisting?: boolean;
}

export interface RealChromeSession {
  /** PID of the Chrome process (null if reusing). */
  pid: number | null;
  /** Bridge for communicating with the extension. */
  bridge: NativeBridge;
  /** Profile directory path. */
  profileDir: string;
  /** Whether we reused an existing process. */
  reused: boolean;
  /** Close the session. */
  close: () => Promise<void>;
}

/**
 * Find the Chrome/Chromium executable.
 */
async function findChromeBinary(preferred?: string): Promise<string> {
  if (preferred) {
    try {
      await fs.access(preferred, fs.constants.X_OK);
      return preferred;
    } catch {
      throw new Error(`Chrome executable not found or not executable: ${preferred}`);
    }
  }

  const candidates = [
    '/usr/bin/ungoogled-chromium',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
    '/opt/google/chrome/google-chrome',
  ];

  for (const bin of candidates) {
    try {
      await fs.access(bin, fs.constants.X_OK);
      return bin;
    } catch {}
  }

  // Try `which`
  for (const name of ['ungoogled-chromium', 'google-chrome-stable', 'google-chrome', 'chromium-browser', 'chromium']) {
    try {
      const { stdout } = await execFileAsync('which', [name]);
      const resolved = stdout.trim();
      if (resolved) return resolved;
    } catch {}
  }

  throw new Error(
    'No Chrome/Chromium binary found. Install google-chrome or ungoogled-chromium.'
  );
}

/**
 * Check if a Chrome process is already running with the given profile directory.
 */
async function findExistingChromeProcess(profileDir: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('pgrep', ['-f', `--user-data-dir=${profileDir}`]);
    const pids = stdout.trim().split('\n').filter(Boolean).map(Number);
    for (const pid of pids) {
      try {
        process.kill(pid, 0); // Check if alive
        return pid;
      } catch {}
    }
  } catch {}
  return null;
}

/**
 * Get the X11 window ID for a Chrome process.
 */
async function findChromeWindowId(pid?: number | null): Promise<string | null> {
  try {
    let searchArgs: string[];
    if (pid) {
      searchArgs = ['search', '--pid', String(pid)];
    } else {
      searchArgs = ['search', '--name', 'Chromium|Chrome|flow.google.com'];
    }
    const { stdout } = await execFileAsync('xdotool', searchArgs);
    const ids = stdout.trim().split('\n').filter(Boolean);
    return ids[0] || null;
  } catch {
    return null;
  }
}

/**
 * Detect the physical screen dimensions via xdpyinfo.
 * Returns { width, height } or null if detection fails.
 */
async function detectScreenSize(): Promise<{ width: number; height: number } | null> {
  try {
    const { stdout } = await execFileAsync('xdpyinfo', [], {
      timeout: 5_000,
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
    });
    const match = stdout.match(/dimensions:\s+(\d+)x(\d+)\s+pixels/);
    if (match) {
      const w = parseInt(match[1], 10);
      const h = parseInt(match[2], 10);
      if (w >= 800 && h >= 600) return { width: w, height: h };
    }
  } catch {}
  return null;
}

/**
 * Launch a real Chrome browser with the VideoGen extension loaded.
 * NO CDP, NO remote debugging — fully undetectable.
 */
export async function launchRealChrome(
  options: RealChromeOptions = {}
): Promise<RealChromeSession> {
  const profileDir = path.resolve(options.profileDir || './.chromium-profile');
  const extensionPath = path.resolve(
    options.extensionPath || path.join(path.dirname(new URL(import.meta.url).pathname), '../../extension')
  );

  // Auto-detect screen size — never exceed the physical display
  let windowSize = options.windowSize;
  if (!windowSize) {
    const screen = await detectScreenSize();
    if (screen) {
      windowSize = { width: screen.width, height: screen.height };
      console.log(pc.gray(`[real-chrome] Detected screen: ${screen.width}x${screen.height} — window sized to fit`));
    } else {
      // Conservative fallback when screen detection fails
      windowSize = { width: 1280, height: 720 };
      console.log(pc.yellow(`[real-chrome] Could not detect screen size — using conservative ${windowSize.width}x${windowSize.height}`));
    }
  }
  const reuseExisting = options.reuseExisting !== false;

  await fs.mkdir(profileDir, { recursive: true });

  // Verify extension directory
  const manifestPath = path.join(extensionPath, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`Extension manifest not found at ${manifestPath}. Ensure the extension is built.`);
  }

  // Check for existing Chrome process on this profile
  let pid: number | null = null;
  let reused = false;

  if (reuseExisting) {
    pid = await findExistingChromeProcess(profileDir);
    if (pid) {
      console.log(pc.green(`[real-chrome] Reusing existing Chrome process (PID ${pid}) on profile: ${path.basename(profileDir)}`));
      reused = true;
    }
  }

  if (!pid) {
    // Launch new Chrome process
    const executablePath = await findChromeBinary(options.executablePath);
    console.log(pc.cyan(`[real-chrome] Launching: ${executablePath}`));
    console.log(pc.gray(`  Profile: ${profileDir}`));
    console.log(pc.gray(`  Extension: ${extensionPath}`));

    const args = [
      `--user-data-dir=${profileDir}`,
      `--load-extension=${extensionPath}`,
      `--disable-extensions-except=${extensionPath}`,
      `--window-size=${windowSize.width},${windowSize.height}`,
      '--window-position=0,0',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--ignore-gpu-blocklist',
      '--enable-gpu-rasterization',
      '--enable-zero-copy',
      // DO NOT add: --remote-debugging-port, --enable-automation
    ];

    // Proxy
    const proxyUrl = options.proxyServer
      ?? process.env.PROXY_URL
      ?? process.env.ALL_PROXY
      ?? process.env.HTTPS_PROXY
      ?? process.env.HTTP_PROXY
      ?? null;

    if (proxyUrl) {
      args.push(`--proxy-server=${proxyUrl}`);
      args.push('--proxy-bypass-list=<-loopback>');
    }

    if (options.extraArgs) {
      args.push(...options.extraArgs);
    }

    // Open URL if specified
    if (options.url) {
      args.push(options.url);
    }

    const child = spawn(executablePath, args, {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        DISPLAY: process.env.DISPLAY || ':0',
      },
    });
    child.unref();
    pid = child.pid || null;

    if (!pid) {
      throw new Error('Failed to spawn Chrome process');
    }

    console.log(pc.green(`[real-chrome] Chrome started (PID ${pid})`));

    // Wait for the window to appear
    const windowDeadline = Date.now() + 15_000;
    let windowId: string | null = null;
    while (Date.now() < windowDeadline) {
      windowId = await findChromeWindowId(pid);
      if (windowId) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    if (windowId) {
      console.log(pc.green(`[real-chrome] Chrome window detected (Window ID: ${windowId})`));
    } else {
      console.log(pc.yellow(`[real-chrome] Chrome window not detected (may be headless or starting up)`));
    }
  }

  // Connect to the Native Messaging Host bridge
  const socketPath = path.join(path.dirname(profileDir), '.videogen-nm.sock');
  const bridge = new NativeBridge({ socketPath });

  try {
    // Wait for the native host to start (it's launched by Chrome when the extension connects)
    console.log(pc.cyan(`[real-chrome] Waiting for Native Messaging bridge...`));
    await bridge.waitAndConnect(30_000);
    console.log(pc.green(`[real-chrome] Native bridge connected!`));

    // Verify the bridge is working
    const pong = await bridge.ping();
    if (pong) {
      console.log(pc.green(`[real-chrome] Bridge ping successful — extension is active`));
    }
  } catch (err: any) {
    console.warn(pc.yellow(`[real-chrome] Native bridge not available: ${err.message}`));
    console.warn(pc.yellow(`[real-chrome] Falling back to xdotool-only mode (no DOM queries)`));
  }

  // Save session info
  const sessionInfoPath = path.join(profileDir, '.real-chrome-session.json');
  await fs.writeFile(sessionInfoPath, JSON.stringify({
    pid,
    profileDir,
    extensionPath,
    socketPath,
    reused,
    startedAt: new Date().toISOString(),
  }, null, 2), 'utf8').catch(() => {});

  return {
    pid,
    bridge,
    profileDir,
    reused,
    close: async () => {
      bridge.disconnect();
      if (pid && !reused) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {}
      }
    },
  };
}

/**
 * Check if the Native Messaging Host is properly installed for this extension.
 */
export async function checkNativeHostInstallation(): Promise<{
  installed: boolean;
  paths: string[];
  errors: string[];
}> {
  const nmHostDirs = [
    path.join(process.env.HOME || '~', '.config/google-chrome/NativeMessagingHosts'),
    path.join(process.env.HOME || '~', '.config/chromium/NativeMessagingHosts'),
    path.join(process.env.HOME || '~', '.config/ungoogled-chromium/NativeMessagingHosts'),
  ];

  const found: string[] = [];
  const errors: string[] = [];
  const manifestName = 'com.videogen.host.json';

  for (const dir of nmHostDirs) {
    const manifestPath = path.join(dir, manifestName);
    if (existsSync(manifestPath)) {
      found.push(manifestPath);
      try {
        const content = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        if (!existsSync(content.path)) {
          errors.push(`Host script not found at: ${content.path}`);
        }
      } catch (e: any) {
        errors.push(`Invalid manifest at ${manifestPath}: ${e.message}`);
      }
    }
  }

  return {
    installed: found.length > 0 && errors.length === 0,
    paths: found,
    errors,
  };
}
