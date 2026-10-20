/**
 * Browser Session Persistence & Reuse Manager.
 *
 * Tracks running Chromium browser sessions per profile directory,
 * enabling background process persistence across CLI runs and instant
 * CDP reconnection without re-launching Chromium.
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import type { Browser } from 'playwright-core';
import pc from 'picocolors';

export interface BrowserSessionInfo {
  port: number;
  profileDir: string;
  pid: number;
  wsEndpoint?: string;
  createdAt: string;
  updatedAt: string;
}

const SESSION_FILENAME = '.browser-session.json';

/**
 * Returns the path to the session metadata file inside the profile directory.
 */
export function getSessionFilePath(profileDir: string): string {
  return path.join(path.resolve(profileDir), SESSION_FILENAME);
}

/**
 * Reads and parses the session metadata file if present.
 */
export async function readSessionInfo(profileDir: string): Promise<BrowserSessionInfo | null> {
  const filePath = getSessionFilePath(profileDir);
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(raw) as BrowserSessionInfo;
    if (typeof data.port === 'number' && data.port > 0) {
      return data;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Persists session metadata to the profile directory.
 */
export async function saveSessionInfo(
  profileDir: string,
  info: Omit<BrowserSessionInfo, 'updatedAt'>
): Promise<void> {
  const filePath = getSessionFilePath(profileDir);
  const data: BrowserSessionInfo = {
    ...info,
    updatedAt: new Date().toISOString(),
  };
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  } catch (err: any) {
    console.warn(pc.yellow(`[browser-session] Failed to write session file: ${err.message}`));
  }
}

/**
 * Deletes the session metadata file.
 */
export async function clearSessionInfo(profileDir: string): Promise<void> {
  const filePath = getSessionFilePath(profileDir);
  try {
    await fs.unlink(filePath);
  } catch {
    // Ignore if not present
  }
}

/**
 * Probes whether a Chromium CDP endpoint is active and responding on a given port.
 */
export async function isCDPEndpointAlive(
  port: number,
  timeoutMs = 1500
): Promise<{ alive: boolean; wsEndpoint?: string }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const data = (await res.json()) as { webSocketDebuggerUrl?: string };
      return {
        alive: true,
        wsEndpoint: data.webSocketDebuggerUrl,
      };
    }
    return { alive: false };
  } catch {
    return { alive: false };
  }
}

/**
 * Checks if a process with the given PID is currently alive on the host.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kills a process and all its children (the entire process tree).
 * Falls back to individual PID kill when process-group kill fails.
 */
async function killProcessTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  // Try killing the entire process group first (works when the process is a
  // session leader, which detached spawn creates).
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // Not a process group leader or already gone — fall through.
  }

  // Recursively find and kill child processes via /proc.
  try {
    const childPids = execSync(`pgrep -P ${pid}`, { encoding: 'utf-8', timeout: 3000 })
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(Number)
      .filter((n) => !isNaN(n));
    for (const childPid of childPids) {
      await killProcessTree(childPid, signal);
    }
  } catch {
    // pgrep failed (no children or not available) — fine.
  }

  // Kill the process itself.
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

/**
 * Finds and kills orphaned Chromium processes listening on a specific port.
 * Used to reclaim ports held by browsers that lost their session file.
 */
export async function killOrphanedBrowserOnPort(port: number): Promise<boolean> {
  try {
    const output = execSync(
      `ss -tlnp 2>/dev/null | grep ':${port} ' | grep -oP 'pid=\K\d+'`,
      { encoding: 'utf-8', timeout: 3000 }
    ).trim();
    const pid = parseInt(output, 10);
    if (isNaN(pid) || pid <= 1) return false;

    console.warn(pc.yellow(`[browser-session] Killing orphaned browser on port ${port} (pid ${pid})`));
    await killProcessTree(pid, 'SIGTERM');

    // Wait for process to die
    for (let i = 0; i < 15 && isPidAlive(pid); i++) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (isPidAlive(pid)) {
      await killProcessTree(pid, 'SIGKILL');
      await new Promise((r) => setTimeout(r, 500));
    }
    return !isPidAlive(pid);
  } catch {
    return false;
  }
}

/**
 * Determines whether an existing browser session for the given profile is alive and reachable.
 * Cleans up stale session files if the process or endpoint has terminated.
 */
export async function isSessionAlive(
  profileDir: string
): Promise<{ alive: boolean; session?: BrowserSessionInfo }> {
  const session = await readSessionInfo(profileDir);
  if (!session) {
    return { alive: false };
  }

  // Verify PID first if available
  if (session.pid && !isPidAlive(session.pid)) {
    await clearSessionInfo(profileDir);
    return { alive: false };
  }

  // Verify CDP endpoint
  const cdpCheck = await isCDPEndpointAlive(session.port);
  if (cdpCheck.alive) {
    if (cdpCheck.wsEndpoint && cdpCheck.wsEndpoint !== session.wsEndpoint) {
      session.wsEndpoint = cdpCheck.wsEndpoint;
      await saveSessionInfo(profileDir, session);
    }
    return { alive: true, session };
  }

  // Endpoint is dead
  await clearSessionInfo(profileDir);
  return { alive: false };
}

/**
 * Checks if a local TCP port is currently free.
 */
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Discovers an available port for the Chrome DevTools Protocol,
 * reusing the profile's active port if it is still alive.
 * Reclaims ports held by orphaned browsers (no session file) automatically.
 */
export async function findAvailablePort(
  startPort = 9222,
  profileDir?: string
): Promise<number> {
  if (profileDir) {
    const check = await isSessionAlive(profileDir);
    if (check.alive && check.session) {
      return check.session.port;
    }
  }

  for (let port = startPort; port < startPort + 50; port++) {
    const cdp = await isCDPEndpointAlive(port, 300);
    if (!cdp.alive) {
      const free = await isPortAvailable(port);
      if (free) {
        return port;
      }
      // Port is occupied by a non-CDP process (orphaned browser that hasn't
      // finished starting, or a zombie). Try to reclaim it.
      const reclaimed = await killOrphanedBrowserOnPort(port);
      if (reclaimed) {
        // Wait for OS to release the port
        await new Promise((r) => setTimeout(r, 500));
        const freeNow = await isPortAvailable(port);
        if (freeNow) return port;
      }
    }
    // CDP is alive on this port but not associated with our profile —
    // this is a legitimate browser. Skip it.
  }

  return startPort;
}

/**
 * Spawns Chromium as a detached process and waits for its CDP endpoint to be ready.
 */
export async function spawnDetachedChromium(options: {
  executablePath: string;
  args: string[];
  profileDir: string;
  port: number;
  timeoutMs?: number;
}): Promise<number> {
  const { executablePath, args, profileDir, port, timeoutMs = 20_000 } = options;

  const child = spawn(executablePath, args, {
    detached: true,
    stdio: 'ignore',
  });
  // Ensure the browser becomes a process group leader so killProcessTree
  // can kill it and all its children via process.kill(-pid).
  child.unref();

  const pid = child.pid;
  if (!pid) {
    throw new Error(`Failed to spawn Chromium process at ${executablePath}`);
  }

  // Poll until CDP endpoint responds
  const start = Date.now();
  let wsEndpoint: string | undefined;

  while (Date.now() - start < timeoutMs) {
    const check = await isCDPEndpointAlive(port, 300);
    if (check.alive) {
      wsEndpoint = check.wsEndpoint;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!wsEndpoint) {
    throw new Error(
      `Chromium launched (PID ${pid}) but CDP endpoint on port ${port} did not respond within ${timeoutMs}ms.`
    );
  }

  await saveSessionInfo(profileDir, {
    port,
    profileDir: path.resolve(profileDir),
    pid,
    wsEndpoint,
    createdAt: new Date().toISOString(),
  });

  return pid;
}

/**
 * Fully terminates a running Chromium browser session.
 * 1. If an active CDP browser handle is provided, requests graceful exit via CDP 'Browser.close'.
 * 2. If profileDir is provided and a session is recorded, tries CDP 'Browser.close' if port is alive,
 *    and verifies process termination via PID.
 * 3. If process does not terminate within the graceful window, terminates it via SIGTERM / SIGKILL.
 * 4. Clears .browser-session.json.
 */
export async function closeBrowserSession(options: {
  browser?: Browser;
  profileDir?: string;
  timeoutMs?: number;
} = {}): Promise<void> {
  const { browser, profileDir, timeoutMs = 5000 } = options;

  let session: BrowserSessionInfo | null = null;
  if (profileDir) {
    session = await readSessionInfo(profileDir).catch(() => null);
  }

  // 1. Try graceful CDP close if we have a live browser handle
  if (browser && browser.isConnected()) {
    try {
      const cdp = await browser.newBrowserCDPSession();
      await cdp.send('Browser.close').catch(() => {});
      await cdp.detach().catch(() => {});
    } catch {
      // Ignore CDP errors
    }
    try {
      await browser.close();
    } catch {
      // Ignore disconnect errors
    }
  } else if (session?.port) {
    // If we only have profileDir and port is alive, try connecting via CDP to request Browser.close
    const cdpAlive = await isCDPEndpointAlive(session.port, 300);
    if (cdpAlive.alive) {
      try {
        const { chromium } = await import('playwright-core');
        const tempBrowser = await chromium.connectOverCDP({
          endpointURL: `http://127.0.0.1:${session.port}`,
          timeout: 2000,
        });
        const cdp = await tempBrowser.newBrowserCDPSession();
        await cdp.send('Browser.close').catch(() => {});
        await cdp.detach().catch(() => {});
        await tempBrowser.close().catch(() => {});
      } catch {
        // Fall back to PID check
      }
    }
  }

  // 2. Process tree check and SIGTERM/SIGKILL if still alive.
  //    Kill the ENTIRE process tree (renderer, gpu-process, utility workers)
  //    to prevent leaked child processes from holding ports and memory.
  if (session?.pid && isPidAlive(session.pid)) {
    const deadline = Date.now() + Math.min(timeoutMs, 3000);
    while (isPidAlive(session.pid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    if (isPidAlive(session.pid)) {
      await killProcessTree(session.pid, 'SIGTERM');

      const sigtermDeadline = Date.now() + 2000;
      while (isPidAlive(session.pid) && Date.now() < sigtermDeadline) {
        await new Promise((r) => setTimeout(r, 100));
      }

      if (isPidAlive(session.pid)) {
        await killProcessTree(session.pid, 'SIGKILL');
      }
    }
  }

  // 2b. Port-level fallback: if the session had a port, ensure nothing is
  //     still listening on it (handles cases where PID tracking was stale
  //     or the process re-parented to init).
  if (session?.port) {
    const portStillAlive = await isCDPEndpointAlive(session.port, 500);
    if (portStillAlive.alive) {
      await killOrphanedBrowserOnPort(session.port);
    }
  }

  // 3. Clear session metadata file
  if (profileDir) {
    await clearSessionInfo(profileDir).catch(() => {});
  }
}

/**
 * Releases a Playwright Browser handle.
 * If keepAlive is true (default), disconnects the CDP connection leaving Chromium running
 * (for connected browsers, `browser.close()` only drops the connection — verified).
 * If keepAlive is false, closes Chromium completely.
 */
export async function releaseBrowser(
  browser: Browser,
  options: { keepAlive?: boolean; profileDir?: string } = {}
): Promise<void> {
  const keepAlive = options.keepAlive ?? true;
  try {
    if (keepAlive) {
      // Connected browser: close() only drops the connection, Chromium stays alive.
      await browser.close();
    } else {
      await closeBrowserSession({ browser, profileDir: options.profileDir });
    }
  } catch {
    // Ignore errors during release/disconnect
  }
}
