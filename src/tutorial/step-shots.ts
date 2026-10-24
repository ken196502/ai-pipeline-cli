/**
 * Browser operation step screenshots (浏览器操作步骤截图) as tutorial material.
 *
 * The tutorial shows the creation workflow step by step; operation scenes
 * (typing a prompt in a tool UI, adjusting settings, exporting, ...) get their
 * material from REAL browser screenshots instead of only wireframe demos:
 *
 *   ① capture  — drive a real browser through the operation steps
 *                (navigate / click / type / wait) and screenshot every step
 *                into <outDir>/step-NNN.png plus a steps.json manifest.
 *   ② collect  — ingest a directory of step screenshots as `image` materials
 *                (id `browser-step-NNN`, derivedFrom `browser-step`) copied
 *                into the tutorial bundle assets/ for the player to load.
 *
 * A steps.json manifest carries the step order and labels:
 *   { "steps": [{ "index": 1, "label": "输入提示词", "file": "step-001.png" }] }
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { launchBrowser } from '../browser/launcher.js';
import { click, navigate, type as typeText, wait as waitAction } from '../browser/actions.js';
import { takeScreenshot } from '../browser/screenshots.js';
import { releaseBrowser } from '../browser/session.js';
import type { TutorialAsset } from './contracts.js';

// ==========================================
// Step script (input for capture)
// ==========================================

/** One operation action performed before the step is screenshotted. */
export const BrowserStepActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('click'),
      selector: z.string().min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal('type'),
      selector: z.string().min(1),
      text: z.string().min(1),
      clear: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('wait'),
      ms: z.number().int().positive().optional(),
      selector: z.string().min(1).optional(),
    })
    .strict(),
]);
export type BrowserStepAction = z.infer<typeof BrowserStepActionSchema>;

/** "wait" actions need "ms" or "selector" (checked outside the discriminated union). */
const BrowserStepActionsSchema = z.array(BrowserStepActionSchema).superRefine((actions, ctx) => {
  actions.forEach((action, index) => {
    if (action.action === 'wait' && action.ms == null && !action.selector) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index],
        message: 'wait action needs "ms" or "selector"',
      });
    }
  });
});

/** One browser operation step to capture. */
export const BrowserStepSpecSchema = z
  .object({
    label: z.string().min(1),
    /** Navigate to this URL before running the actions (optional). */
    url: z.string().url().optional(),
    actions: BrowserStepActionsSchema.default([]),
    /** Extra settle time (ms) before the screenshot. */
    settleMs: z.number().int().nonnegative().default(600),
  })
  .strict();
export type BrowserStepSpec = z.infer<typeof BrowserStepSpecSchema>;

/** A capture script: an ordered list of browser operation steps. */
export const BrowserStepScriptSchema = z
  .object({ steps: z.array(BrowserStepSpecSchema).min(1) })
  .strict();
export type BrowserStepScript = z.infer<typeof BrowserStepScriptSchema>;

/**
 * Parses and validates a step script from raw JSON (object with "steps" or a
 * bare array of steps). Throws descriptive errors on invalid scripts.
 */
export function parseBrowserStepScript(raw: unknown): BrowserStepSpec[] {
  const value =
    Array.isArray(raw)
      ? { steps: raw }
      : raw && typeof raw === 'object' && Array.isArray((raw as { steps?: unknown }).steps)
        ? { steps: (raw as { steps: unknown[] }).steps }
        : raw;
  const parsed = BrowserStepScriptSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid browser step script — ${issues}`);
  }
  return parsed.data.steps;
}

// ==========================================
// Capture (drive browser + screenshot per step)
// ==========================================

export interface BrowserStepShotManifestEntry {
  index: number;
  label: string;
  file: string;
}

export interface BrowserStepShotManifest {
  capturedAt: string;
  steps: BrowserStepShotManifestEntry[];
}

export interface CaptureBrowserStepShotsParams {
  steps: readonly BrowserStepSpec[];
  /** Output directory for step-NNN.png + steps.json (usually <outDir>/browser-steps). */
  outDir: string;
  browserPath?: string;
  onProgress?: (stage: string, message: string) => void;
}

export interface CaptureBrowserStepShotsResult {
  outDir: string;
  manifestPath: string;
  steps: BrowserStepShotManifestEntry[];
}

function padStep(index: number): string {
  return String(index).padStart(3, '0');
}

/**
 * Drives a real browser through the operation steps and screenshots every
 * step (viewport shot after the step's actions settled).
 */
export async function captureBrowserStepShots(
  params: CaptureBrowserStepShotsParams
): Promise<CaptureBrowserStepShotsResult> {
  const steps = params.steps;
  if (steps.length === 0) {
    throw new Error('captureBrowserStepShots: no steps given');
  }
  const outDir = path.resolve(params.outDir);
  await fs.mkdir(outDir, { recursive: true });

  const progress = params.onProgress ?? (() => {});
  progress('steps', `Launching browser to capture ${steps.length} operation step screenshot(s)`);

  const launched = await launchBrowser({
    executablePath: params.browserPath,
    headless: true,
    // Reuse the logged-in profile session when one is running (real tool UIs
    // need login state); a freshly launched browser is closed again below.
    reuseSession: true,
    keepAlive: false,
    stealth: false,
  });

  const { browser, page } = launched;
  const entries: BrowserStepShotManifestEntry[] = [];

  try {
    for (const [idx, step] of steps.entries()) {
      const index = idx + 1;
      if (step.url) {
        await navigate(page, step.url);
      }
      for (const action of step.actions) {
        if (action.action === 'click') {
          await click(page, action.selector);
        } else if (action.action === 'type') {
          await typeText(page, action.selector, action.text, { clear: action.clear, humanize: false });
        } else if (action.action === 'wait') {
          if (action.selector) await waitAction(page, action.selector);
          if (action.ms != null) await waitAction(page, action.ms);
        }
      }
      if (step.settleMs > 0) {
        await waitAction(page, step.settleMs);
      }
      const file = `step-${padStep(index)}.png`;
      await takeScreenshot(page, { path: path.join(outDir, file), type: 'png' });
      entries.push({ index, label: step.label, file });
      progress('steps', `Captured step ${index}/${steps.length}: ${step.label}`);
    }
  } finally {
    // Never close a browser session we merely reconnected to.
    await releaseBrowser(browser, { keepAlive: launched.reused, profileDir: launched.userDataDir });
  }

  const manifest: BrowserStepShotManifest = {
    capturedAt: new Date().toISOString(),
    steps: entries,
  };
  const manifestPath = path.join(outDir, 'steps.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

  return { outDir, manifestPath, steps: entries };
}

// ==========================================
// Collect (screenshots -> tutorial materials)
// ==========================================

export interface CollectBrowserStepShotsParams {
  /** Directory holding step screenshots (+ optional steps.json manifest). */
  stepsDir: string;
  /** Tutorial bundle assets directory (tutorial/assets). */
  assetsOutDir: string;
}

export interface CollectBrowserStepShotsResult {
  assets: TutorialAsset[];
  skippedMissingMedia: string[];
}

// Matches browser step screenshots (step-NNN.png) and Gemini chat page
// screenshots (gemini-NNN.png, same manifest format).
const SHOT_FILE_PATTERN = /^(step-|gemini-).*\.(png|jpe?g|webp)$/i;

async function readStepManifest(stepsDir: string): Promise<BrowserStepShotManifestEntry[] | null> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(stepsDir, 'steps.json'), 'utf-8'));
    const list = Array.isArray(raw) ? raw : raw?.steps;
    if (!Array.isArray(list)) return null;
    return list.map((entry: any, idx: number) => ({
      index: typeof entry?.index === 'number' ? entry.index : idx + 1,
      label: String(entry?.label ?? `operation step ${idx + 1}`),
      file: String(entry?.file ?? ''),
    }));
  } catch {
    return null;
  }
}

/**
 * Ingests a directory of browser operation step screenshots as image
 * materials (id `browser-step-NNN`, derivedFrom `browser-step`) copied into
 * the tutorial bundle assets/. Order + labels come from steps.json when
 * present, otherwise from the natural file order.
 */
export async function collectBrowserStepShots(
  params: CollectBrowserStepShotsParams
): Promise<CollectBrowserStepShotsResult> {
  const stepsDir = path.resolve(params.stepsDir);
  const assetsOutDir = path.resolve(params.assetsOutDir);
  await fs.mkdir(assetsOutDir, { recursive: true });

  const assets: TutorialAsset[] = [];
  const skippedMissingMedia: string[] = [];

  const manifestEntries = await readStepManifest(stepsDir);
  let files: Array<{ file: string; label: string; index: number }>;
  if (manifestEntries && manifestEntries.length > 0) {
    files = manifestEntries.map((entry) => ({ file: entry.file, label: entry.label, index: entry.index }));
  } else {
    const names = (await fs.readdir(stepsDir))
      .filter((name) => SHOT_FILE_PATTERN.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    files = names.map((name, idx) => ({ file: name, label: `operation step ${idx + 1}`, index: idx + 1 }));
  }

  for (const entry of files) {
    const sourcePath = path.join(stepsDir, entry.file);
    let isFile = false;
    try {
      isFile = (await fs.stat(sourcePath)).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) {
      skippedMissingMedia.push(sourcePath);
      continue;
    }
    const ext = path.extname(entry.file) || '.png';
    const src = `assets/browser-step-${padStep(entry.index)}${ext}`;
    await fs.copyFile(sourcePath, path.join(assetsOutDir, path.basename(src)));
    assets.push({
      id: `browser-step-${padStep(entry.index)}`,
      kind: 'image',
      label: `Browser step ${entry.index} — ${entry.label}`,
      src,
      sourcePath,
      derivedFrom: 'browser-step',
    });
  }

  return { assets, skippedMissingMedia };
}
