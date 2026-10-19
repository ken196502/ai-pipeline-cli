/**
 * Deterministic CLI shutdown.
 *
 * A CLI that has finished its work must terminate. Long-running pipelines touch many
 * long-lived resources (background Chromium via `chromium.connectOverCDP()` WebSockets,
 * static HTTP servers, spawned ffmpeg/yt-dlp children, webhook sockets). Any handle
 * left behind keeps the Node event loop busy and the process "hangs" after the run has
 * actually completed (see plan-fix-pipeline-hang-on-exit.md).
 *
 * `exitAfterFlush()` therefore:
 *   1. REPORTS every suspicious still-alive resource (leaks stay visible, never hidden),
 *   2. gives stdout/stderr a moment to flush into the log file / terminal,
 *   3. exits with the intended code.
 */

/** Resource names that are expected to be alive in any running CLI. */
const BENIGN_RESOURCES = new Set([
  'TTYWrap',
  'PipeWrap',
  'Stdout',
  'Stderr',
  'Stdin',
  'Timeout',
  'Immediate',
  'FSReqCallback',
  'FSReqPromise',
]);

/**
 * Lists the resources that are still keeping the event loop alive.
 * Returns the suspicious ones (everything that is not an obvious I/O or timer handle).
 */
export function reportActiveResources(label = 'shutdown'): string[] {
  const info =
    typeof (process as { getActiveResourcesInfo?: () => string[] }).getActiveResourcesInfo === 'function'
      ? process.getActiveResourcesInfo()
      : [];

  const counts = new Map<string, number>();
  for (const name of info) counts.set(name, (counts.get(name) || 0) + 1);

  const suspicious = [...counts.entries()]
    .filter(([name]) => !BENIGN_RESOURCES.has(name))
    .map(([name, count]) => `${name}×${count}`);

  if (suspicious.length > 0) {
    console.warn(
      `[shutdown] ⚠ ${label}: ${suspicious.length} resource(s) still holding the event loop: ${suspicious.join(', ')}`
    );
  } else {
    console.log(`[shutdown] ${label}: no leftover handles — event loop is free`);
  }
  return suspicious;
}

/**
 * Ends the CLI deterministically: report leftovers, flush output, exit.
 */
export async function exitAfterFlush(code: number | string, label = 'shutdown'): Promise<never> {
  reportActiveResources(label);

  const exitCode = typeof code === 'number' ? code : Number(code) || 0;
  // Give stdout/stderr (piped into the run log) a moment to drain before exiting.
  await new Promise((resolve) => setTimeout(resolve, 100));
  process.exit(exitCode);
}
