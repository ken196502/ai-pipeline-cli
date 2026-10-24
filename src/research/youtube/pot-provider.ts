/**
 * bgutil-ytdlp-pot-provider lifecycle helper.
 *
 * YouTube now requires a Proof-of-Origin (PO) token for the `web` player client;
 * without it yt-dlp returns empty/degraded formats ("The page needs to be
 * reloaded", storyboards only). The bgutil HTTP server (port 4416) generates
 * those tokens locally via the BotGuard VM. The matching yt-dlp plugin
 * (pip package `bgutil-ytdlp-pot-provider`) auto-detects the server on
 * http://127.0.0.1:4416, so all we must guarantee is that the server process
 * is alive before any yt-dlp call.
 *
 * This ONLY supports the yt-dlp download path. There is intentionally no
 * browser/player-capture fallback here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const POT_PORT = 4416;
const POT_HOST = '127.0.0.1';

/** Resolves the bgutil provider server directory (override with BGUTIL_POT_SERVER_DIR). */
export function resolvePotServerDir(): string {
  return (
    process.env.BGUTIL_POT_SERVER_DIR ||
    path.join(os.homedir(), '.local', 'share', 'bgutil-pot-provider', 'server')
  );
}

/** TCP probe: is the bgutil PO-token server listening? */
export async function isPotProviderUp(timeoutMs = 1_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: POT_HOST, port: POT_PORT });
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * Ensures the bgutil PO-token server is running. Spawns it detached (so it
 * outlives the pipeline) if the port is closed. Returns true when the server is
 * reachable, false when it could not be started (the caller should surface a
 * clear error rather than silently retrying a doomed yt-dlp call).
 */
export async function ensurePotProviderRunning(timeoutMs = 20_000): Promise<boolean> {
  if (await isPotProviderUp()) return true;

  const serverDir = resolvePotServerDir();
  const entry = path.join(serverDir, 'build', 'main.js');
  if (!fs.existsSync(entry)) {
    return false;
  }

  try {
    const child = spawn(process.execPath, [entry], {
      cwd: serverDir,
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
  } catch {
    return false;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPotProviderUp()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
