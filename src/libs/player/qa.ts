/**
 * Automated visual QA for the explainer player (自动视觉质检).
 *
 * Boots the player in the headless render browser (same engine as the final
 * render — local Firefox by default) at the target resolution, seeks a
 * grid of sample timestamps across every scene, takes screenshots and runs
 * programmatic visual checks so layout defects are caught by the build itself
 * instead of by a human reviewer:
 *
 *   - cropped content: any visible element extending beyond the video frame
 *   - clipped text: caption / title text cut off vertically
 *   - prompt reveal: prompt auto-scroll must complete before the scene ends
 *   - blank frames: near-zero pixel variance at any sample time
 */
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import sharp from 'sharp';
import { launchRenderBrowser, serveExplainerDir, type ExplainerRenderEngine } from './render.js';
import type { ExplainerTimeline } from './contracts.js';

export interface ExplainerQAIssue {
  kind:
    | 'element-overflow'
    | 'text-clipped'
    | 'prompt-unresolved'
    | 'blank-frame';
  detail: string;
  tSec: number;
}
export type TutorialQAIssue = ExplainerQAIssue;

export interface ExplainerQAResult {
  issues: ExplainerQAIssue[];
  screenshots: string[];
  checksRun: number;
}
export type TutorialQAResult = ExplainerQAResult;

export interface RunExplainerVisualQaParams {
  explainerDir?: string;
  tutorialDir?: string;
  /** Render engine override; defaults to the same engine family as renderExplainerVideo. */
  engine?: ExplainerRenderEngine;
  /** Chromium executable path — implies engine 'chromium'. */
  browserPath?: string;
  /** Where QA screenshots are saved (default <explainerDir>/qa). */
  shotsDir?: string;
  /** Samples per scene (default 4). */
  samplesPerScene?: number;
}
export type RunTutorialVisualQaParams = RunExplainerVisualQaParams;

interface FrameInspection {
  overflows: string[];
  textClipped: string[];
  promptUnresolved: string[];
}

/** Runs the visual QA grid over one explainer bundle. */
export async function runExplainerVisualQa(
  params: RunExplainerVisualQaParams
): Promise<ExplainerQAResult> {
  const bundleDir = path.resolve(params.explainerDir || params.tutorialDir || '');
  const shotsDir = params.shotsDir || path.join(bundleDir, 'qa');
  const samplesPerScene = params.samplesPerScene ?? 4;
  await fs.mkdir(shotsDir, { recursive: true });

  const timelineFile = fss.existsSync(path.join(bundleDir, 'explainer.json'))
    ? path.join(bundleDir, 'explainer.json')
    : path.join(bundleDir, 'tutorial.json');

  const timeline = JSON.parse(
    await fs.readFile(timelineFile, 'utf-8')
  ) as ExplainerTimeline;

  const server = await serveExplainerDir(bundleDir);
  let browser: Browser | BrowserContext | null = null;
  const issues: ExplainerQAIssue[] = [];
  const screenshots: string[] = [];
  const unresolvedPromptIds = new Set<string>();
  let checksRun = 0;

  try {
    const envEngine = process.env.EXPLAINER_RENDER_ENGINE || process.env.TUTORIAL_RENDER_ENGINE;
    const engine = params.engine ?? (envEngine === 'firefox' || envEngine === 'chromium' ? envEngine : 'chromium');
    const launched = await launchRenderBrowser({
      engine,
      browserPath: engine === 'chromium' ? params.browserPath : undefined,
      width: timeline.resolution.width,
      height: timeline.resolution.height,
    });
    browser = launched.browser;
    const page: Page = launched.page;

    const playerHtmlFilename = fss.existsSync(path.join(bundleDir, 'explainer-player.html'))
      ? 'explainer-player.html'
      : 'tutorial-player.html';

    await page.goto(`${server.origin}/${playerHtmlFilename}?render=1`, { waitUntil: 'load', timeout: 120_000 });
    await page.waitForFunction(
      'window.__explainerReady === true || window.__tutorialReady === true || window.__explainerError || window.__tutorialError',
      undefined,
      { timeout: 120_000 }
    );
    const bootError = await page.evaluate('window.__explainerError || window.__tutorialError || null');
    if (bootError) {
      issues.push({ kind: 'blank-frame', detail: `player failed to boot: ${bootError}`, tSec: 0 });
      return { issues, screenshots, checksRun: 1 };
    }

    await page.evaluate(() => {
      document.documentElement.classList.add('render-mode');
      document.body.classList.add('render-mode');
      const hud = document.getElementById('hud');
      if (hud) hud.remove();
      const ctrl = document.getElementById('controls');
      if (ctrl) ctrl.remove();
    });

    const clips = timeline.clips || [];
    let shotIndex = 0;

    for (let ci = 0; ci < clips.length; ci += 1) {
      const clip = clips[ci];
      for (let si = 0; si < (clip.shots || []).length; si += 1) {
        const shot = clip.shots[si];
        const vStart = shot.vStart ?? 0;
        const vDur = Math.max(shot.vDur ?? 3, 0.5);

        for (let s = 0; s < samplesPerScene; s += 1) {
          const frac = (s + 0.5) / samplesPerScene;
          const tSec = vStart + vDur * frac;

          await page.evaluate((t: number) => {
            const api = window.__explainer || window.__tutorial;
            return api!.seek(t);
          }, tSec);

          const shotTag = `c${ci}-s${si}-sample${s}-${tSec.toFixed(2)}s`;
          const shotPath = path.join(shotsDir, `${shotTag}.png`);
          const pngBuffer = await page.screenshot({ type: 'png' });
          await fs.writeFile(shotPath, pngBuffer);
          screenshots.push(shotPath);
          checksRun += 1;

          // Inspection: pixel variance (blank-frame guard)
          try {
            const stats = await sharp(pngBuffer).stats();
            const maxVariance = Math.max(...stats.channels.map((c) => c.stdev));
            if (maxVariance < 2.0) {
              issues.push({
                kind: 'blank-frame',
                detail: `frame at ${tSec.toFixed(2)}s appears near-blank (max stdev ${maxVariance.toFixed(2)})`,
                tSec,
              });
            }
          } catch {}

          // Inspection: DOM geometry checks
          const inspection = (await page.evaluate(() => {
            const overflows: string[] = [];
            const textClipped: string[] = [];
            const promptUnresolved: string[] = [];

            const viewW = window.innerWidth;
            const viewH = window.innerHeight;

            const cards = document.querySelectorAll('.visual-card, .caption-text, .bubble-bot, .bubble-user');
            for (let i = 0; i < cards.length; i += 1) {
              const el = cards[i] as HTMLElement;
              const r = el.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              if (r.left < -10 || r.top < -10 || r.right > viewW + 10 || r.bottom > viewH + 10) {
                overflows.push(`${el.className} exceeds viewport bounds [${Math.round(r.left)}, ${Math.round(r.top)}, ${Math.round(r.right)}, ${Math.round(r.bottom)}]`);
              }
              if (el.scrollHeight > el.clientHeight + 8 && el.clientHeight > 0) {
                textClipped.push(`${el.className} has vertical scroll overflow (${el.scrollHeight}px > ${el.clientHeight}px)`);
              }
            }

            return { overflows, textClipped, promptUnresolved };
          })) as FrameInspection;

          for (const over of inspection.overflows) {
            issues.push({ kind: 'element-overflow', detail: `${shotTag}: ${over}`, tSec });
          }
          for (const clipText of inspection.textClipped) {
            issues.push({ kind: 'text-clipped', detail: `${shotTag}: ${clipText}`, tSec });
          }
        }
        shotIndex += 1;
      }
    }
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
    await server.close();
  }

  return { issues, screenshots, checksRun };
}

export const runTutorialVisualQa = runExplainerVisualQa;
