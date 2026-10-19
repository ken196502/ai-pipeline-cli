/**
 * Advanced Screenshot Capture Capabilities for Playwright Pages and Elements.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright-core';
import type { ScreenshotOptions, ScreenshotResult } from './types.js';

/**
 * Captures a screenshot of the page, specific element selector, or clipping region.
 */
export async function takeScreenshot(
  page: Page,
  options: ScreenshotOptions = {}
): Promise<ScreenshotResult> {
  const format = options.type || 'png';
  // Playwright screenshot() always resolves to a Buffer (there is no
  // `encoding` option like puppeteer had).
  const screenshotConfig: any = {
    type: format,
    omitBackground: options.omitBackground ?? false,
  };

  if (format === 'jpeg' || format === 'webp') {
    screenshotConfig.quality = options.quality ?? 85;
  }

  let rawBuffer: Buffer | string | Uint8Array;

  if (options.selector) {
    const el = await page.waitForSelector(options.selector, { timeout: 15000, state: 'attached' });
    if (!el) {
      throw new Error(`Element selector "${options.selector}" could not be resolved for screenshot`);
    }
    rawBuffer = await el.screenshot(screenshotConfig);
  } else if (options.clip) {
    screenshotConfig.clip = options.clip;
    rawBuffer = await page.screenshot(screenshotConfig);
  } else {
    screenshotConfig.fullPage = options.fullPage ?? false;
    rawBuffer = await page.screenshot(screenshotConfig);
  }

  // Playwright returns a Buffer directly; keep the defensive conversions for
  // ElementHandle.screenshot() return-type variance across versions.
  const buffer =
    Buffer.isBuffer(rawBuffer)
      ? rawBuffer
      : typeof rawBuffer === 'string'
        ? Buffer.from(rawBuffer, 'base64')
        : Buffer.from(rawBuffer);

  let savedPath: string | undefined;
  if (options.path) {
    savedPath = path.resolve(options.path);
    await fs.mkdir(path.dirname(savedPath), { recursive: true });
    await fs.writeFile(savedPath, buffer);
  }

  return {
    buffer,
    base64: buffer.toString('base64'),
    path: savedPath,
    format,
  };
}

/**
 * Captures a full-page scrollable screenshot.
 */
export async function takeFullPageScreenshot(
  page: Page,
  options: Omit<ScreenshotOptions, 'fullPage' | 'selector' | 'clip'> = {}
): Promise<ScreenshotResult> {
  return takeScreenshot(page, { ...options, fullPage: true });
}

/**
 * Captures a screenshot cropped strictly to a CSS element's bounding box.
 */
export async function takeElementScreenshot(
  page: Page,
  selector: string,
  options: Omit<ScreenshotOptions, 'selector' | 'clip'> = {}
): Promise<ScreenshotResult> {
  return takeScreenshot(page, { ...options, selector });
}

/**
 * Captures a screenshot of a specific pixel rectangle.
 */
export async function takeClipScreenshot(
  page: Page,
  clip: { x: number; y: number; width: number; height: number },
  options: Omit<ScreenshotOptions, 'clip' | 'selector'> = {}
): Promise<ScreenshotResult> {
  return takeScreenshot(page, { ...options, clip });
}
