/**
 * Bundles the player runtime (`runtime/*.js` + `runtime/transitions/*.glsl`)
 * into a single IIFE string that `writeExplainerPlayer()` embeds in the page.
 *
 * The engine used to live in a ~1900-line template string inside this TS module
 * (no type checking, no lint, double-escaped regexes, untestable). It is now a
 * real ESM source tree bundled with esbuild.
 */
import { buildSync } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const runtimeDir = path.dirname(fileURLToPath(import.meta.url));

let cachedBundle: string | null = null;

/** Bundles the player runtime once per process and caches the result. */
export function buildPlayerRuntime(): string {
  if (cachedBundle) return cachedBundle;

  const result = buildSync({
    entryPoints: [path.join(runtimeDir, 'core.js')],
    bundle: true,
    write: false,
    format: 'iife',
    target: ['chrome100', 'firefox100', 'safari15'],
    platform: 'browser',
    legalComments: 'none',
    logLevel: 'silent',
    loader: { '.glsl': 'text' },
    charset: 'utf8',
  });

  if (result.errors.length > 0) {
    const messages = result.errors.map((e) => `${e.location?.file || '?'}: ${e.text}`).join('\n');
    throw new Error(`player runtime bundle failed:\n${messages}`);
  }

  cachedBundle = result.outputFiles[0].text;
  return cachedBundle;
}

/** Test hook: drops the cached bundle (used by the runtime regression tests). */
export function resetPlayerRuntimeCache(): void {
  cachedBundle = null;
}
