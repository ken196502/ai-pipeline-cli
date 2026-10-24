/**
 * Gemini chatbot page screenshots (Gemini 聊天页面真实截图) as tutorial material.
 *
 * The tutorial must NOT paint HTML UI mocks for the chatbot / prompt-writing
 * operation scenes. Instead the REAL Gemini page (gemini.google.com) is driven
 * in the browser and screenshotted step by step:
 *
 *   ① open the Gemini app page            → gemini-001.png
 *   ② type the master prompt into the
 *      chat input box                     → gemini-002.png
 *   ③ press send / run, let the reply
 *      start streaming                    → gemini-003.png
 *
 * Screenshots land in <outDir>/gemini-shots/ with a gemini-shots.json manifest
 * (same shape as the browser step manifest) and are ingested via
 * collectBrowserStepShots as `browser-step-NNN` image materials
 * (derivedFrom: browser-step), so they reuse the storyboard rules and the
 * "operation screenshots must appear" coverage check.
 *
 * Every failed step aborts loudly (no silent degradation, no fake material).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { launchBrowser } from '../browser/launcher.js';
import { click, navigate, type as typeText, wait as waitAction } from '../browser/actions.js';
import { takeScreenshot } from '../browser/screenshots.js';
import { releaseBrowser } from '../browser/session.js';

export const GEMINI_APP_URL = 'https://gemini.google.com/app';

/** CSS selectors for the Gemini chat input, tried in order. */
export const GEMINI_INPUT_SELECTORS = [
  'rich-textarea div[contenteditable="true"]',
  'div[contenteditable="true"]',
  'textarea[aria-label]',
  'textarea',
];

/** CSS selectors for the Gemini send/run button, tried in order. */
export const GEMINI_SEND_SELECTORS = [
  'button[aria-label*="Run" i]',
  'button[aria-label*="Send" i]',
  'button[type="submit"]',
  'button.send-button',
];

/** One captured Gemini shot: index (1-based), label and written file name. */
export interface GeminiShotEntry {
  index: number;
  label: string;
  file: string;
}

export interface CaptureGeminiShotsParams {
  /** The master prompt typed into the Gemini chat box (usually the flow image prompt). */
  prompt: string;
  /** Output directory for gemini-NNN.png + gemini-shots.json. */
  outDir: string;
  /** Optional overrides for the per-shot labels. */
  labels?: { open?: string; typed?: string; sent?: string };
  browserPath?: string;
  profileDir?: string;
  /** Max chars of the prompt actually typed (keeps the screenshots readable). */
  maxPromptChars?: number;
  onProgress?: (stage: string, message: string) => void;
}

export interface CaptureGeminiShotsResult {
  outDir: string;
  manifestPath: string;
  shots: GeminiShotEntry[];
}

function padShot(index: number): string {
  return String(index).padStart(3, '0');
}

/**
 * Waits for the first selector of the list to become visible.
 * Throws a combined error when none of them appears in time.
 */
async function waitForAnySelector(page: Page, selectors: readonly string[], timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      try {
        await page.waitForSelector(selector, { timeout: 1_000, state: 'visible' });
        return selector;
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw new Error(
    `none of the selectors appeared: ${selectors.join(', ')}${
      lastError instanceof Error ? ` (last error: ${lastError.message})` : ''
    }`
  );
}

/**
 * Drives the real browser through the Gemini chat operation and screenshots
 * every step. The typed text and the send click happen with the humanized
 * actions shared by the rest of the pipeline.
 */
export async function captureGeminiShots(
  params: CaptureGeminiShotsParams
): Promise<CaptureGeminiShotsResult> {
  const prompt = params.prompt.trim();
  if (!prompt) {
    throw new Error('captureGeminiShots: prompt is required (the master prompt typed into Gemini)');
  }
  const outDir = path.resolve(params.outDir);
  await fs.mkdir(outDir, { recursive: true });

  const progress = params.onProgress ?? (() => {});
  progress('gemini', 'Launching browser to capture Gemini chat page screenshots');

  const launched = await launchBrowser({
    executablePath: params.browserPath,
    profileDir: params.profileDir,
    headless: true,
    reuseSession: true,
    keepAlive: true,
    stealth: true,
  });

  const { browser, page } = launched;
  const entries: GeminiShotEntry[] = [];
  const maxChars = params.maxPromptChars ?? 400;
  const typedPrompt = prompt.length > maxChars ? prompt.slice(0, maxChars) : prompt;

  const shoot = async (label: string): Promise<GeminiShotEntry> => {
    const index = entries.length + 1;
    const file = `gemini-${padShot(index)}.png`;
    await takeScreenshot(page, { path: path.join(outDir, file), type: 'png' });
    const entry = { index, label, file };
    entries.push(entry);
    progress('gemini', `Captured Gemini shot ${index}: ${label} (${file})`);
    return entry;
  };

  try {
    // ① Open the Gemini app page.
    await navigate(page, GEMINI_APP_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await waitAction(page, 2_500);
    await shoot(params.labels?.open || 'Open Gemini Chat');

    // ② Type the master prompt into the chat input box.
    const inputSelector = await waitForAnySelector(page, GEMINI_INPUT_SELECTORS);
    await typeText(page, inputSelector, typedPrompt, { humanize: false, clear: true });
    await waitAction(page, 800);
    await shoot(params.labels?.typed || 'Enter Generation Prompt in Gemini');

    // ③ Send the prompt and let the reply start streaming.
    const sendSelector = await waitForAnySelector(page, GEMINI_SEND_SELECTORS, 10_000);
    await click(page, sendSelector);
    await waitAction(page, 4_000);
    await shoot(params.labels?.sent || 'Submit Prompt and Await Response');
  } finally {
    // Keep the persistent browser alive so subsequent stages and pipeline runs retain session tokens.
    if (launched?.page && !launched.page.isClosed()) {
      await launched.page.close().catch(() => {});
    }
    await releaseBrowser(browser, { keepAlive: true, profileDir: launched.userDataDir });
  }

  const manifestPath = path.join(outDir, 'gemini-shots.json');
  await fs.writeFile(
    manifestPath,
    JSON.stringify({ capturedAt: new Date().toISOString(), prompt: typedPrompt, steps: entries }, null, 2) + '\n',
    'utf-8'
  );

  return { outDir, manifestPath, shots: entries };
}
