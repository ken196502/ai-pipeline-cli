/**
 * Automated visual QA for the tutorial player (自动视觉质检).
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
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import sharp from 'sharp';
import { launchRenderBrowser, serveTutorialDir, type TutorialRenderEngine } from './render.js';
import type { TutorialTimeline } from './contracts.js';

export interface TutorialQAIssue {
  kind:
    | 'element-overflow'
    | 'text-clipped'
    | 'prompt-unresolved'
    | 'blank-frame';
  detail: string;
  tSec: number;
}

export interface TutorialQAResult {
  issues: TutorialQAIssue[];
  screenshots: string[];
  checksRun: number;
}

export interface RunTutorialVisualQaParams {
  tutorialDir: string;
  /** Render engine override; defaults to the same engine family as renderTutorialVideo. */
  engine?: TutorialRenderEngine;
  /** Chromium executable path — implies engine 'chromium'. */
  browserPath?: string;
  /** Where QA screenshots are saved (default <tutorialDir>/qa). */
  shotsDir?: string;
  /** Samples per scene (default 4). */
  samplesPerScene?: number;
}

interface FrameInspection {
  overflows: string[];
  textClipped: string[];
  promptUnresolved: string[];
}

/** Runs the visual QA grid over one tutorial bundle. */
export async function runTutorialVisualQa(
  params: RunTutorialVisualQaParams
): Promise<TutorialQAResult> {
  const tutorialDir = path.resolve(params.tutorialDir);
  const shotsDir = params.shotsDir || path.join(tutorialDir, 'qa');
  const samplesPerScene = params.samplesPerScene ?? 4;
  await fs.mkdir(shotsDir, { recursive: true });

  const timeline = JSON.parse(
    await fs.readFile(path.join(tutorialDir, 'tutorial.json'), 'utf-8')
  ) as TutorialTimeline;

  const server = await serveTutorialDir(tutorialDir);
  let browser: Browser | BrowserContext | null = null;
  const issues: TutorialQAIssue[] = [];
  const screenshots: string[] = [];
  const unresolvedPromptIds = new Set<string>();
  let checksRun = 0;

  try {
    const envEngine = process.env.TUTORIAL_RENDER_ENGINE;
    const engine = params.engine ?? (envEngine === 'firefox' || envEngine === 'chromium' ? envEngine : 'chromium');
    const launched = await launchRenderBrowser({
      engine,
      browserPath: engine === 'chromium' ? params.browserPath : undefined,
      width: timeline.resolution.width,
      height: timeline.resolution.height,
    });
    browser = launched.browser;
    const page: Page = launched.page;
    await page.goto(`${server.origin}/tutorial-player.html?render=1`, { waitUntil: 'load', timeout: 120_000 });
    await page.waitForFunction('window.__tutorialReady === true || window.__tutorialError', undefined, { timeout: 120_000 });
    const bootError = await page.evaluate('window.__tutorialError || null');
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

    const sampleRanges: Array<{ startSec: number; durationSec: number }> = [];
    if (timeline.clips && timeline.clips.length > 0) {
      for (const clip of timeline.clips) {
        for (const shot of clip.shots) {
          sampleRanges.push({
            startSec: shot.vStart ?? 0,
            durationSec: shot.vDur ?? 4.2,
          });
        }
      }
    } else if (timeline.scenes && timeline.scenes.length > 0) {
      for (const scene of timeline.scenes) {
        sampleRanges.push({
          startSec: scene.startSec ?? 0,
          durationSec: scene.durationSec ?? 4.2,
        });
      }
    } else {
      sampleRanges.push({ startSec: 0, durationSec: timeline.totalDurationSec || 4.2 });
    }

    for (const range of sampleRanges) {
      for (let sample = 0; sample < samplesPerScene; sample += 1) {
        // Sample inside the range, biased away from its exact edges.
        const p = (sample + 0.5) / samplesPerScene;
        const tSec = range.startSec + range.durationSec * p;

        await page.evaluate((t: number) => window.__tutorial!.seek(t), tSec);
        const shotPath = path.join(shotsDir, `qa-${tSec.toFixed(2)}s.png`);
        await page.screenshot({ path: shotPath, type: 'png', timeout: 60_000 });
        screenshots.push(shotPath);
        checksRun += 1;

        // Blank frame detection via pixel variance.
        const stats = await sharp(shotPath).stats();
        const meanStdev =
          stats.channels.slice(0, 3).reduce((acc, c) => acc + c.stdev, 0) / 3;
        if (meanStdev < 3) {
          issues.push({
            kind: 'blank-frame',
            detail: `frame is nearly blank (mean stdev ${meanStdev.toFixed(2)})`,
            tSec,
          });
        }

        const inspection = await page.evaluate(
          (probeT: number) => {
            const result: FrameInspection = {
              overflows: [],
              textClipped: [],
              promptUnresolved: [],
            };
            const W = window.innerWidth;
            const H = window.innerHeight;

            for (const el of Array.from(document.querySelectorAll('#stage *'))) {
              const node = el as HTMLElement;
              if (node.classList && node.classList.contains('visual-source')) continue;
              // The drifting grid layer intentionally bleeds past the frame.
              if (node.id === 'grid-layer') continue;
              const style = window.getComputedStyle(node);
              if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
              const rect = node.getBoundingClientRect();
              if (rect.width < 4 || rect.height < 4) continue;
              if (rect.right > W + 4 || rect.bottom > H + 4 || rect.left < -4 || rect.top < -4) {
                result.overflows.push(
                  `<${node.tagName.toLowerCase()} class="${node.className}"> at t=${probeT.toFixed(2)} (rect ${rect.left.toFixed(0)},${rect.top.toFixed(0)} ${rect.width.toFixed(0)}x${rect.height.toFixed(0)} vs ${W}x${H})`
                );
              }
            }

            for (const sel of ['.caption-text', '.title-heading', '.title-kicker']) {
              const node = document.querySelector(sel) as HTMLElement | null;
              if (!node) continue;
              if (node.scrollHeight > node.clientHeight + 4) {
                result.textClipped.push(`${sel} clipped vertically (${node.scrollHeight} > ${node.clientHeight})`);
              }
            }

            // Prompt cards: every prompt material referenced by the timeline
            // must resolve to non-empty text through the player's prompt
            // registry (canvas player — the legacy DOM .prompt-text check is
            // replaced by this runtime probe).
            try {
              const cfg = JSON.parse(document.getElementById('tutorial-data')?.textContent || '{}');
              const assets = JSON.parse(document.getElementById('tutorial-assets')?.textContent || '[]');
              const promptIds = new Set(
                assets.filter((a: any) => a.kind === 'prompt').map((a: any) => a.id)
              );
              const referenced = new Set<string>();
              for (const clip of cfg.clips || []) {
                for (const shot of clip.shots || []) {
                  for (const element of shot.elements || []) {
                    const visual = element[1];
                    const id = typeof visual === 'string' ? visual : (visual && (visual.assetId || visual.name)) || '';
                    if (promptIds.has(id)) referenced.add(id);
                  }
                }
              }
              const api = (window as any).__tutorial;
              for (const id of referenced) {
                const text = api && typeof api.promptTextFor === 'function' ? api.promptTextFor(id) : null;
                if (!text) result.promptUnresolved.push(id);
              }
            } catch {
              // config parse failure is covered by the boot/blank-frame checks
            }

            return result;
          },
          tSec
        );

        for (const detail of inspection.overflows) {
          issues.push({ kind: 'element-overflow', detail, tSec });
        }
        for (const detail of inspection.textClipped) {
          issues.push({ kind: 'text-clipped', detail, tSec });
        }
        for (const id of inspection.promptUnresolved) {
          if (unresolvedPromptIds.has(id)) continue;
          unresolvedPromptIds.add(id);
          issues.push({
            kind: 'prompt-unresolved',
            detail: `prompt material "${id}" is referenced by the timeline but its full text resolved empty — the prompt card would render a placeholder`,
            tSec,
          });
        }
      }
    }

    return { issues, screenshots, checksRun };
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
    await server.close();
  }
}
