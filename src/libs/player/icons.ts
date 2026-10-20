/**
 * Lucide icon set access (via `lucide-static`).
 *
 * The complete lucide icon name list is exposed to the LLM as the icon
 * material inventory; resolved SVGs are injected into the tutorial player.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let iconsDirCache: string | null = null;

function resolveIconsDir(): string {
  if (iconsDirCache) return iconsDirCache;
  const packageJsonPath = require.resolve('lucide-static/package.json');
  iconsDirCache = path.join(path.dirname(packageJsonPath), 'icons');
  return iconsDirCache;
}

/** Lists every available lucide icon name (kebab-case, e.g. "sparkles"). */
export function listLucideIconNames(): string[] {
  const entries = fs.readdirSync(resolveIconsDir());
  return entries
    .filter((name) => name.endsWith('.svg'))
    .map((name) => name.slice(0, -4))
    .sort();
}

/** True when the given lucide icon name exists in the installed icon set. */
export function hasLucideIcon(name: string): boolean {
  if (!/^[a-z0-9-]+$/.test(name)) return false;
  return fs.existsSync(path.join(resolveIconsDir(), `${name}.svg`));
}

/**
 * Returns the raw SVG markup for a lucide icon.
 * Throws when the icon does not exist — never falls back to a placeholder.
 */
export function getLucideIconSvg(name: string): string {
  const iconPath = path.join(resolveIconsDir(), `${name}.svg`);
  if (!hasLucideIcon(name)) {
    throw new Error(`lucide icon "${name}" does not exist in lucide-static`);
  }
  return fs.readFileSync(iconPath, 'utf-8');
}

/** Resolves several icons at once into a name -> SVG map (for player inlining). */
export function resolveLucideIcons(names: Iterable<string>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const name of names) {
    map[name] = getLucideIconSvg(name);
  }
  return map;
}
