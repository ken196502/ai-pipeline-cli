/**
 * Flow Client (Extension Mode) — Orchestrates video generation on Google Flow
 * using Real Chrome + Extension + Native Messaging + xdotool.
 *
 * NO Playwright, NO Puppeteer, NO CDP — fully undetectable.
 */
import { FlowVideoScriptSchema } from '../research/script/contracts.js';
import type { RunContext } from '../run/index.js';
import { readFile, stat, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import pc from 'picocolors';
import { launchRealChrome, type RealChromeSession } from '../browser/real-chrome-launcher.js';
import { closeBrowserSession } from '../browser/session.js';
import { NativeBridge, type DOMState, type ElementRect } from '../browser/native-bridge.js';
import {
  systemClick,
  systemRightClick,
  systemType,
  systemKeyCombo,
  systemKeyPress,
  systemEscape,
  systemSelectAll,
  systemDelete,
  systemPaste,
  systemClearAndType,
  systemTypeViaPaste,
  systemScroll,
  setClipboardVerified,
  setClipboardImage,
} from '../input/system-input.js';
import { planClipGeneration } from './clip-plan.js';
import { extractLastFrame } from '../research/media/frames.js';
import {
  DEFAULT_PROFILE_DIR,
  FLOW_HOME_URL,
  RISK_RETRY_ATTEMPTS,
  RISK_RETRY_DELAY_MIN_SEC,
  RISK_RETRY_DELAY_MAX_SEC,
  getFlowConfig,
} from './config.js';
import { isRiskControlError, isTransientGenerationError } from './dom.js';
import { ensureFileDownloaded } from './download.js';
import { canonicalFlowVideoId } from './observer.js';
import { ClipDuplicateGuard, MEDIA_UUID_RE, canonicalMediaTokens, hashMediaFile, mediaUuidFromSrc, resolveMediaKey } from './duplicate-guard.js';
import type {
  BatchClipResult,
  BatchOptions,
  BatchResult,
  FlowProject,
  FlowProjectItem,
  GenerateOptions,
  GenerationResult,
  QuotaSnapshot,
} from './contracts.js';
import { assertSufficientCredits, buildCreditSnapshot } from './quota.js';
import { sanitizeVisualPromptForVideoEngine } from '../research/script/shot-transition.js';

// Utilities
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function randomDelay(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Formats a signed credit delta, e.g. "-15" / "+0". */
function formatCreditDelta(delta: number): string {
  return `${delta > 0 ? '+' : ''}${delta}`;
}

/** Result of one Phase-1 keyframe image generation step. */
interface ClipImageResult {
  mediaKey: string | null;
  mediaId: string | null;
  imageUrl: string | null;
  imageOutputPath: string | null;
}

export class FlowClientExt {
  private readonly config = getFlowConfig();
  private session: RealChromeSession | null = null;

  /**
   * Ensure a Chrome session is running with the extension loaded.
   */
  async ensureSession(options?: {
    profileDir?: string;
    url?: string;
  }): Promise<RealChromeSession> {
    if (this.session?.bridge.isConnected) {
      return this.session;
    }

    const profileDir = options?.profileDir
      ? path.resolve(options.profileDir)
      : this.config.profileDir;

    this.session = await launchRealChrome({
      profileDir,
      url: options?.url || FLOW_HOME_URL,
      reuseExisting: true,
    });

    return this.session;
  }

  /**
   * Wait for a DOM condition via the extension bridge.
   */
  private async waitForCondition(
    bridge: NativeBridge,
    check: (state: DOMState) => boolean,
    timeoutMs: number,
    errorMsg: string
  ): Promise<DOMState> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await bridge.queryDOM();
      if (check(state)) return state;
      await sleep(1000);
    }
    throw new Error(errorMsg);
  }

  /**
   * Check for errors in the DOM state.
   *
   * `errorBaseline` lists error-tile texts that already existed before the attempt
   * started: only failures that appear AFTER submission abort it — stale risk tiles
   * must never kill a healthy generation (see plan-fix-risk-control-refresh-retry.md).
   */
  private checkForErrors(state: DOMState, errorBaseline: string[] = []): void {
    if (state.chatErrors.length > 0) {
      const error = state.chatErrors.join('; ');
      if (/something went wrong/i.test(error)) {
        throw new Error(`Google Flow generation rejected: ${error}`);
      }
    }
    const freshTiles = state.errorTiles.filter((t) => !errorBaseline.includes(t.text));
    if (freshTiles.length > 0) {
      throw new Error(`Google Flow error tile: ${freshTiles[0].text}`);
    }
  }

  /**
   * Runs one generation attempt with Google risk-control recovery, exactly the way
   * the user verified manually: every attempt starts with a page refresh that makes
   * the risk-control tile disappear, then re-runs the click input box → Ctrl+V →
   * Enter gesture. A risk-control rejection is retried after a human-like randomized
   * pause until it passes or the attempt budget (FLOW_RISK_RETRY_ATTEMPTS) is spent.
   * Non-risk errors are never retried.
   */
  private async withRiskControlRetry<T>(
    bridge: NativeBridge,
    refreshUrl: string,
    label: string,
    attempt: (attemptNo: number) => Promise<T>
  ): Promise<T> {
    const maxAttempts = Math.max(1, RISK_RETRY_ATTEMPTS);
    const minSec = RISK_RETRY_DELAY_MIN_SEC;
    const maxSec = Math.max(RISK_RETRY_DELAY_MAX_SEC, RISK_RETRY_DELAY_MIN_SEC);

    let lastError: unknown = null;
    for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo++) {
      console.log(
        pc.gray(
          `[flow-ext] ${label}: refreshing page before attempt ${attemptNo}/${maxAttempts} (clears the risk-control tile)`
        )
      );
      await bridge.navigate(refreshUrl).catch(() => {});
      await sleep(2500);
      await this.waitForEditor(bridge, 30_000);

      try {
        return await attempt(attemptNo);
      } catch (err: any) {
        lastError = err;
        const msg = err?.message || String(err);
        const retryable = isRiskControlError(msg) || isTransientGenerationError(msg);
        if (!retryable || attemptNo >= maxAttempts) throw err;

        const delaySec = minSec + Math.random() * Math.max(maxSec - minSec, 0);
        console.warn(
          pc.yellow(
            `[flow-ext] ${label}: ${isRiskControlError(msg) ? 'Google risk control' : 'transient generation error'} on attempt ${attemptNo}/${maxAttempts} — ` +
              `refreshing and retrying the click → Ctrl+V → Enter gesture in ${delaySec.toFixed(0)}s. ` +
              `Cause: ${(err?.message || '').slice(0, 160)}`
          )
        );
        await sleep(delaySec * 1000);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * Click an element identified by selector using system-level input.
   */
  private async clickBySelector(bridge: NativeBridge, selector: string, options?: {
    rightClick?: boolean;
    timeoutMs?: number;
    scrollIntoView?: boolean;
  }): Promise<ElementRect> {
    const timeoutMs = options?.timeoutMs ?? 10_000;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const result = options?.scrollIntoView
        ? await bridge.request({ type: 'scroll_into_view', selector })
        : await bridge.getElementRect(selector);

      if (result.found && result.rect) {
        const rect = result.rect;
        const x = rect.x + rect.width / 2;
        const y = rect.y + rect.height / 2;

        if (options?.rightClick) {
          await systemRightClick(x, y);
        } else {
          await systemClick(x, y);
        }
        await sleep(randomDelay(200, 500));
        return rect;
      }
      await sleep(500);
    }

    throw new Error(`Element not found: ${selector} (waited ${timeoutMs}ms)`);
  }

  /**
   * Focus an input element and type text using system-level keyboard.
   */
  private async focusAndType(bridge: NativeBridge, selector: string, text: string): Promise<void> {
    // Focus the element via extension
    const result = await bridge.focusElement(selector);
    if (!result.ok || !result.rect) {
      throw new Error(`Could not focus element: ${selector}`);
    }

    // Click the element to ensure OS-level focus
    const x = result.rect.x + result.rect.width / 2;
    const y = result.rect.y + result.rect.height / 2;
    await systemClick(x, y);
    await sleep(300);

    // Clear existing content and type new text
    await systemClearAndType(text, { usePaste: text.length > 50 });
  }

  /**
   * Login to Google Flow — opens browser for manual authentication.
   */
  async login(options?: {
    profileDir?: string;
    headed?: boolean;
    viewport?: unknown;
  }): Promise<{ loggedIn: boolean }> {
    const session = await this.ensureSession({
      profileDir: options?.profileDir,
      url: FLOW_HOME_URL,
    });

    console.log(pc.yellow(`\n[flow-ext] Browser opened at flow.google.com`));
    console.log(pc.yellow(`[flow-ext] Please sign in to Google if prompted.`));
    console.log(pc.yellow(`[flow-ext] The session will be saved to the persistent profile.\n`));

    // Wait for user to sign in (poll page URL)
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      try {
        const info = await session.bridge.getPageInfo();
        if (
          info.url.includes('flow.google.com') &&
          !info.url.includes('ServiceLogin') &&
          !info.url.includes('/signin') &&
          !/sign in to google|choose an account/i.test(info.bodyText)
        ) {
          console.log(pc.green(`\n✓ Google Flow authentication verified!`));
          await this.scrollToBottom(session.bridge);
          return { loggedIn: true };
        }
      } catch {}
      await sleep(3000);
    }

    throw new Error('Google Flow sign-in was not completed within 5 minutes.');
  }

  /**
   * Opens flow.google.com via the extension bridge, scrolls to the very bottom
   * to load all dynamic project cards, and returns the full list of discovered projects.
   */
  async listProjects(options?: {
    profileDir?: string;
    headed?: boolean;
    maxScrolls?: number;
  }): Promise<FlowProjectItem[]> {
    const session = await this.ensureSession({
      profileDir: options?.profileDir,
      url: FLOW_HOME_URL,
    });
    const bridge = session.bridge;

    await sleep(2000);

    const info = await bridge.getPageInfo();
    if (!info.url.includes('flow.google.com')) {
      await bridge.navigate(FLOW_HOME_URL);
      await sleep(3000);
    }

    const pageInfo = await bridge.getPageInfo();
    if (/sign in to google|choose an account|use your google account/i.test(pageInfo.bodyText)) {
      throw new Error('Not signed in to Google Flow. Run "flow-ext login" first to authenticate.');
    }

    console.log(pc.cyan(`[flow-ext] Scrolling to the bottom of flow.google.com to load all projects...`));
    const projects = await bridge.listProjects({
      maxScrolls: options?.maxScrolls ?? 50,
      stepPx: 800,
      delayMs: 300,
    });

    console.log(pc.green(`[flow-ext] Discovered ${projects.length} project(s)`));
    return projects;
  }

  /**
   * Check or create a Flow project.
   */
  async checkOrCreateProject(
    projectId?: string,
    options?: { profileDir?: string; headed?: boolean; viewport?: unknown }
  ): Promise<FlowProject> {
    const url = projectId
      ? `${FLOW_HOME_URL}/project/${projectId}`
      : FLOW_HOME_URL;

    const session = await this.ensureSession({
      profileDir: options?.profileDir,
      url,
    });
    const bridge = session.bridge;

    await sleep(3000); // Wait for page load

    // Check current page
    const info = await bridge.getPageInfo();

    // If already on a project page, extract project ID
    const uuidMatch = info.url.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i
    );
    if (uuidMatch) {
      return { projectId: uuidMatch[0], url: info.url };
    }

    // Scroll to the bottom of flow.google.com to load all projects and dynamic content
    if (info.url.includes('flow.google.com')) {
      await this.scrollToBottom(bridge);
      if (projectId) {
        const existingProjects = await bridge.getProjects();
        const matched = existingProjects.find(
          (p) => p.projectId.toLowerCase() === projectId.toLowerCase()
        );
        if (matched) {
          await bridge.navigate(matched.url);
          await sleep(3000);
          return { projectId: matched.projectId, url: matched.url };
        }
      }
    }

    // Try to create a new project
    console.log(pc.cyan(`[flow-ext] Creating new project...`));
    const result = await bridge.waitForSelector(
      'button, [role="button"], a',
      10_000
    );

    // Find and click the real "New project" card. The home page also shows a
    // promotional "Start Creating" button that navigates to the broken route
    // /404?reason=project, so filter to visible enabled elements and prefer
    // exact "new project" text (see dom.ts createNewProject).
    const createBtnRect = await bridge.request({
      type: 'evaluate',
      code: `
        const btns = Array.from(document.querySelectorAll('button, [role="button"], a'));
        let best = null;
        let bestScore = -1;
        for (const b of btns) {
          const text = (b.textContent || b.getAttribute('aria-label') || '').trim();
          if (!/new project|create project|start creating/i.test(text)) continue;
          const r = b.getBoundingClientRect();
          const s = window.getComputedStyle(b);
          if (!(r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden')) continue;
          if (b.hasAttribute('disabled')) continue;
          let score = 0;
          if (/new project/i.test(text)) score = 3;
          else if (/create project/i.test(text)) score = 2;
          else score = 1;
          if (score > bestScore) { bestScore = score; best = b; }
        }
        if (!best) return null;
        best.scrollIntoView({ block: 'center' });
        const r = best.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
      `,
    });

    if (createBtnRect?.result) {
      const coords = JSON.parse(createBtnRect.result);
      // Add window offset
      const winInfo = await bridge.getWindowInfo();
      const offsetX = (winInfo.window?.left || 0);
      const offsetY = (winInfo.window?.top || 0);
      // Note: getAbsoluteRect in content.js already includes screen offsets
      await systemClick(coords.x, coords.y);
      await sleep(5000);
    }

    // Re-check URL for project UUID
    const newInfo = await bridge.getPageInfo();
    const newMatch = newInfo.url.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i
    );

    return {
      projectId: newMatch?.[0] || null,
      url: newInfo.url,
    };
  }

  /**
   * Disable agent mode if active.
   */
  private async disableAgentMode(bridge: NativeBridge): Promise<void> {
    const state = await bridge.queryDOM();
    if (state.agentModeActive) {
      console.log(pc.cyan(`[flow-ext] Disabling Agent mode...`));
      await this.clickBySelector(bridge, 'button.agent-mode-chip, flow-agent-mode-toggle-chip button');
      await sleep(500);
    }
  }

  /**
   * Configure direct generation settings (mode, count, duration).
   */
  private async configureSettings(
    bridge: NativeBridge,
    mode: 'image' | 'video',
    options?: { count?: number; durationSec?: number; modelSuffix?: string; aspectRatio?: string }
  ): Promise<void> {
    const targetModelSuffix = options?.modelSuffix ?? 'lite';
    // Click settings trigger button
    try {
      await this.clickBySelector(bridge,
        '.settings-trigger-button, button[aria-label="Settings trigger"]',
        { timeoutMs: 5000 }
      );
      await sleep(500);

      // Select mode toggle (image or video)
      const modeText = mode === 'image' ? 'image' : 'video';
      const isFramesTarget = targetModelSuffix.toLowerCase().includes('frames');
      await bridge.request({
        type: 'evaluate',
        code: `
          const overlay = document.querySelector('.settings-content-overlay, flow-prompt-box-settings, .cdk-overlay-pane');
          if (overlay) {
            const toggles = overlay.querySelectorAll('mat-button-toggle, [role="radio"], button');
            for (const t of toggles) {
              if (t.textContent.toLowerCase().includes('${modeText}')) {
                const btn = t.querySelector('button') || t;
                btn.click();
                break;
              }
            }
            ${isFramesTarget ? `
            // Check for direct Frames mode toggle in settings overlay
            for (const t of toggles) {
              if (t.textContent.toLowerCase().includes('frames')) {
                const btn = t.querySelector('button') || t;
                btn.click();
                break;
              }
            }
            ` : ''}
            // Select x1 count
            for (const t of toggles) {
              if (t.textContent.trim().toLowerCase() === 'x${options?.count || 1}') {
                const btn = t.querySelector('button') || t;
                btn.click();
                break;
              }
            }
            ${options?.durationSec ? `
            for (const t of toggles) {
              if (t.textContent.trim().toLowerCase() === '${options.durationSec}s') {
                const btn = t.querySelector('button') || t;
                btn.click();
                break;
              }
            }
            ` : ''}
          }
        `,
      });
      await sleep(300);

      // Select model (when in Frames mode, select lite model)
      const effectiveModelSuffix = isFramesTarget ? 'lite' : targetModelSuffix;
      if (effectiveModelSuffix) {
        await bridge.request({
          type: 'evaluate',
          code: `
            const modelBtn = document.querySelector('button[aria-label="Select model family"], button[aria-label*="model" i], .model-select-trigger-content, button:has(.model-select-trigger-content)');
            if (modelBtn) modelBtn.click();
          `,
        });
        await sleep(400);
        await bridge.request({
          type: 'evaluate',
          code: `
            const items = Array.from(document.querySelectorAll('.cdk-overlay-pane button, [role="menu"] button, [role="menuitem"], .mat-mdc-menu-item, mat-option, [role="option"]'));
            const regexEnd = new RegExp('(?:^|[\\\\s_-])${effectiveModelSuffix}\\\\s*$', 'i');
            let chosen = items.find(item => regexEnd.test((item.textContent || '').trim()));
            if (!chosen) {
              const regexContains = new RegExp('${effectiveModelSuffix}', 'i');
              chosen = items.find(item => regexContains.test((item.textContent || '').trim()));
            }
            if (chosen) chosen.click();
          `,
        });
        await sleep(300);
      }

      // Select aspect ratio if specified
      if (options?.aspectRatio) {
        await bridge.request({
          type: 'evaluate',
          code: `
            const overlay = document.querySelector('.settings-content-overlay, flow-prompt-box-settings, .cdk-overlay-pane');
            if (overlay) {
              const toggles = Array.from(overlay.querySelectorAll('mat-button-toggle, button, [role="radio"], [role="menuitem"]'));
              const target = '${options.aspectRatio}'.toLowerCase();
              let prefs = [];
              if (target === 'portrait' || target === '9:16') {
                prefs = ['9:16', '3:4', 'portrait'];
              } else if (target === '3:4') {
                prefs = ['3:4', '9:16', 'portrait'];
              } else if (target === 'landscape' || target === '16:9') {
                prefs = ['16:9', '4:3', 'landscape'];
              } else if (target === '4:3') {
                prefs = ['4:3', '16:9', 'landscape'];
              } else {
                prefs = [target];
              }
              for (const pref of prefs) {
                const found = toggles.find(t => {
                  const text = (t.textContent || '').toLowerCase();
                  const aria = (t.getAttribute('aria-label') || '').toLowerCase();
                  return text.includes(pref) || aria.includes(pref);
                });
                if (found) {
                  const btn = found.querySelector('button') || found;
                  btn.click();
                  break;
                }
              }
            }
          `,
        });
        await sleep(300);
      }

      // Dismiss overlay
      await systemEscape();
      await sleep(300);
    } catch (e: any) {
      console.warn(pc.yellow(`[flow-ext] Settings configuration notice: ${e.message}`));
    }
  }

  /**
   * Wait for the prompt editor to be ready.
   */
  private async waitForEditor(bridge: NativeBridge, timeoutMs: number = 30_000): Promise<void> {
    await this.waitForCondition(
      bridge,
      (state) => state.editorReady,
      timeoutMs,
      'Flow prompt editor did not become ready.'
    );
  }

  /**
   * Fill the prompt input using pre-copied clipboard + direct click + Ctrl+V paste.
   */
  private async fillPrompt(bridge: NativeBridge, text: string): Promise<void> {
    const editorSelector =
      'textarea, [contenteditable="true"].ProseMirror, [contenteditable="true"]';

    // 1. Pre-copy prompt to the OS clipboard before focusing editor. The in-page
    //    clipboard write silently no-ops in this browser build, so the verified
    //    OS-level write (xsel/xclip) is the primary path.
    await setClipboardVerified(text).catch(async (err: any) => {
      console.warn(
        pc.yellow(`[flow-ext] OS clipboard write unavailable (${(err?.message || '').slice(0, 100)}) — trying in-page copy`)
      );
      await bridge.request({ type: 'copy_to_clipboard', text }).catch(() => {});
    });

    // 2. Direct click to focus the editor
    await this.clickBySelector(bridge, editorSelector, { timeoutMs: 10_000, scrollIntoView: true });
    await sleep(200);

    // Explicitly focus via extension as well
    await bridge.focusElement(editorSelector).catch(() => {});
    await sleep(100);

    // 3. Select all and clear
    await systemSelectAll();
    await sleep(randomDelay(30, 80));
    await systemDelete();
    await sleep(randomDelay(50, 150));

    // 4. Directly paste via Ctrl+V
    await systemPaste();
  }

  /**
   * Click the Generate button using system-level click.
   */
  private async clickGenerate(bridge: NativeBridge): Promise<void> {
    await this.clickBySelector(bridge,
      'button.generate-icon-button, button[aria-label*="generation" i]',
      { timeoutMs: 10_000, scrollIntoView: true }
    );
  }

  /**
   * Handle the approval modal if it appears.
   */
  private async handleApprovalModal(bridge: NativeBridge): Promise<void> {
    await sleep(2000);
    try {
      // Check for approval button
      const result = await bridge.request({
        type: 'evaluate',
        code: `
          const btns = document.querySelectorAll('button, [role="button"]');
          for (const b of btns) {
            if (/approve/i.test(b.textContent || '') && !/reject/i.test(b.textContent || '')) {
              b.scrollIntoView({ block: 'center' });
              const r = b.getBoundingClientRect();
              return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 });
            }
          }
          // Also check for "Never" confirm-before-generating radio
          const radios = document.querySelectorAll('[role="radio"]');
          for (const r of radios) {
            if (/never|always approve/i.test(r.getAttribute('aria-label') || '')) {
              r.click();
            }
          }
          return null;
        `,
      });

      if (result?.result) {
        const coords = JSON.parse(result.result);
        await systemClick(coords.x, coords.y);
        await sleep(1000);
      }
    } catch {}
  }

  /**
   * Wait for a new IMAGE card to appear after generation (by card identity).
   * Video cards are never returned — a right-click on a video card is impossible.
   */
  private async waitForNewImageTile(
    bridge: NativeBridge,
    baseline: number | Set<string>,
    timeoutMs: number = 120_000,
    errorBaseline: string[] = []
  ): Promise<{ src: string | null; rect: ElementRect; key: string | null; mediaId: string | null }> {
    const deadline = Date.now() + timeoutMs;

    // Canonical-token baseline: the virtualized canvas recycles tile elements,
    // so a stale wrapper key must not disqualify an old card from being recognized
    // (freshness is judged by uuid / origin+path tokens of key AND src).
    const baselineTokens = new Set<string>();
    if (baseline instanceof Set) {
      for (const k of baseline) {
        for (const t of canonicalMediaTokens(k)) baselineTokens.add(t.toLowerCase());
      }
    }

    while (Date.now() < deadline) {
      const state = await bridge.queryDOM();

      // Check for errors
      this.checkForErrors(state, errorBaseline);

      const imageTiles = state.imageTiles;
      const fresh = imageTiles.filter((t) => {
        if (baseline instanceof Set) {
          const src = t.src;
          if (src && !src.startsWith('blob:') && !src.startsWith('data:')) {
            const m = src.match(MEDIA_UUID_RE);
            if (m) return !baselineTokens.has(m[0].toLowerCase());
            try {
              const p = new URL(src);
              if (baselineTokens.has((p.origin + p.pathname).toLowerCase())) return false;
            } catch {}
            if (baselineTokens.has(src.split('?')[0].toLowerCase())) return false;
            return true;
          }
          if (t.key) {
            const m = String(t.key).match(MEDIA_UUID_RE);
            if (m) return !baselineTokens.has(m[0].toLowerCase());
            if (baselineTokens.has(String(t.key).toLowerCase())) return false;
          }
          if (t.mediaId && baselineTokens.has(t.mediaId.toLowerCase())) return false;
          return !baseline.has(t.key ?? '');
        }
        return imageTiles.length > baseline;
      });

      if (state.pendingTiles === 0) {
        const ready = fresh.find((t) => t.src && t.src.startsWith('http')) || null;
        if (ready) {
          return {
            src: ready.src,
            rect: ready.rect,
            key: ready.key ?? null,
            mediaId: ready.mediaId ?? null,
          };
        }
      }

      await sleep(2000);
    }

    throw new Error(
      `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for new image tile. ` +
      `Baseline: ${
        baseline instanceof Set
          ? `${baseline.size} known image card(s)`
          : `${baseline} image card(s)`
      }.`
    );
  }

  /**
   * Wait for a video URL to appear in DOM state.
   */
  private async waitForVideoUrl(
    bridge: NativeBridge,
    baselineUrls: Set<string>,
    timeoutMs: number = 600_000,
    errorBaseline: string[] = []
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let lastRefresh = Date.now();
    const REFRESH_INTERVAL_MS = 60_000;

    // Baseline by CANONICAL video identity (host+path, no signed query): page
    // reloads re-sign old video URLs, and a full-URL compare would accept a
    // stale duplicate as "new" (run viral-1791900784598-797ux0).
    const baselineIds = new Set([...baselineUrls].map(canonicalFlowVideoId));

    // Listen for API errors
    let upstreamError: string | null = null;
    bridge.onApiError((err) => {
      if (err.statusCode >= 400) {
        upstreamError = `Flow API error: HTTP ${err.statusCode} on ${err.url}`;
      }
    });

    while (Date.now() < deadline) {
      if (upstreamError) throw new Error(upstreamError);

      const state = await bridge.queryDOM();
      this.checkForErrors(state, errorBaseline);

      // Check for new video URLs (canonical identity — re-signed old URLs never qualify)
      for (const url of state.videoUrls) {
        if (!baselineIds.has(canonicalFlowVideoId(url)) && this.isFlowVideoUrl(url)) {
          return url;
        }
      }

      // Periodic force-refresh to sync server-side video generation status
      if (Date.now() - lastRefresh >= REFRESH_INTERVAL_MS && Date.now() + 10_000 < deadline) {
        lastRefresh = Date.now();
        const pageInfo = await bridge.getPageInfo().catch(() => null);
        if (pageInfo?.url && pageInfo.url.includes('/project/')) {
          console.log(
            `[flow-ext] Waiting for video URL: refreshing page to sync server-side generation status...`
          );
          await bridge.navigate(pageInfo.url).catch(() => {});
          await sleep(3000);
          continue;
        }
      }

      await sleep(2000);
    }

    throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for Flow video URL.`);
  }

  private isFlowVideoUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') return false;
      if (/\.mp4(?:$|\?)/i.test(parsed.pathname + parsed.search)) return true;
      if (/gstatic\.com/i.test(parsed.hostname)) return false; // demo
      return (
        (parsed.hostname === 'storage.googleapis.com' &&
          /ai-sandbox-videofx|flow-content/i.test(parsed.pathname)) ||
        /^flow-content\.google/i.test(parsed.hostname)
      );
    } catch {
      return false;
    }
  }

  /**
   * Right-click a classified canvas card with aim verification.
   *
   * The centre point of the resolved card is hit-tested (via the extension) before
   * the click, so the right-click can never silently land on a video card — or on
   * the wrong image card — when referencing the previous image or triggering
   * "Animate".
   */
  private async rightClickTile(
    bridge: NativeBridge,
    opts: {
      expect?: 'image' | 'video';
      matchKey?: string | null;
      matchSrc?: string | null;
      label?: string;
    }
  ): Promise<ElementRect> {
    const expectKind = opts.expect ?? 'image';
    const desc = opts.label ?? `latest ${expectKind} card`;

    // Dismiss any open menus or overlays first
    await systemEscape().catch(() => {});
    await sleep(300);

    let lastProblem = 'target card not found on the canvas';
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await bridge.getImageTileRect({
        expect: expectKind,
        matchKey: opts.matchKey ?? undefined,
        matchSrc: opts.matchSrc ?? undefined,
      });

      if (!res.found || !res.rect) {
        lastProblem = res.reason || `no ${desc} found on the canvas`;
        // A card missing from this DOM may still exist server-side: a freshly
        // generated card can take a moment to persist into the project media
        // list this page loaded, and a virtualized canvas only mounts the
        // visible window. Scroll the canvas through, reload the project page
        // to re-sync server-side media, then retry before declaring absence.
        if (attempt < 3) {
          await bridge.scrollToBottom({ maxScrolls: 8 }).catch(() => ({ ok: false }));
          await sleep(1_500);
          const pageInfo = await bridge.getPageInfo().catch(() => null);
          if (pageInfo?.url) {
            await bridge.navigate(pageInfo.url).catch(() => {});
            await sleep(3_000);
          }
          continue;
        }
        break;
      }

      if (res.aimOk === false) {
        lastProblem =
          `aim check failed: no clickable point inside ${desc} — ` +
          (res.reason || `centre hit ${res.hitKind} card "${res.hitKey ?? 'unknown'}" instead`);
        await sleep(500);
        continue;
      }

      // Click the VERIFIED aim point when provided (screen coords, same space as
      // the rect); the rect centre only as a legacy fallback.
      const clickPoint = res.aimPoint ?? {
        x: (res.rect?.x ?? 0) + (res.rect?.width ?? 0) / 2,
        y: (res.rect?.y ?? 0) + (res.rect?.height ?? 0) / 2,
      };
      await systemRightClick(clickPoint.x, clickPoint.y);
      await sleep(800);
      return res.rect as ElementRect;
    }

    throw new Error(
      `Refusing to right-click the wrong card: could not aim at ${desc} — ${lastProblem}.`
    );
  }

  /**
   * Click an entry of the currently open card context menu (e.g. "Add to prompt",
   * "Animate"). Only real menu containers are scanned so a card button can never be
   * mistaken for a menu entry.
   */
  private async clickContextMenuItem(
    bridge: NativeBridge,
    matcher: RegExp,
    icon: string,
    label: string
  ): Promise<void> {
    const result = await bridge.request({
      type: 'evaluate',
      code: `
        const items = document.querySelectorAll(
          '.cdk-overlay-pane button, [role="menu"] button, [role="menu"] [role="menuitem"], .mat-mdc-menu-item, button[role="menuitem"]'
        );
        for (const item of items) {
          const text = (item.textContent || '').trim();
          const icon = item.querySelector('mat-icon, [data-icon], i')?.textContent?.trim() || '';
          if ((${matcher.toString()}).test(text) || icon === '${icon}') {
            item.click();
            return 'clicked';
          }
        }
        return null;
      `,
    });

    if (!result?.result) {
      throw new Error(`"${label}" menu item not found in the card context menu`);
    }
  }

  /**
   * PHASE 1 step — generate one keyframe image card on the Flow canvas.
   *
   * Character consistency: when a previous IMAGE card exists it is right-clicked
   * (aim-verified — never a video card) and "Add to prompt" attaches it as a visual
   * reference before the prompt is submitted. The reference card is the previous
   * clip's recorded image card (referenceKey) when it is still an image card.
   * referenceMode: 'required' (连续/continuous) warns loudly when the reference is
   * missing, 'optional' (切分镜/cut) only notes it.
   */
  private async generateClipImage(opts: {
    label: string;
    imagePrompt: string;
    imageOutputPath?: string;
    projectId?: string;
    aspect: 'landscape' | 'portrait';
    profileDir?: string;
    timeoutMs?: number;
    referencePreviousImage?: boolean;
    referenceKey?: string | null;
    referenceMode?: 'required' | 'optional';
  }): Promise<ClipImageResult> {
    console.log(pc.cyan(`[flow-ext] ${opts.label}: generating keyframe image...`));
    console.log(pc.gray(`Image Prompt: "${opts.imagePrompt.slice(0, 80)}..."`));

    const profileDir = opts.profileDir ? path.resolve(opts.profileDir) : this.config.profileDir;
    const session = await this.ensureSession({ profileDir });
    const bridge = session.bridge;

    // Navigate to project if needed
    const targetUrl = opts.projectId ? `${FLOW_HOME_URL}/project/${opts.projectId}` : FLOW_HOME_URL;
    const currentInfo = await bridge.getPageInfo();
    if (!currentInfo.url.includes('flow.google.com/project/')) {
      await bridge.navigate(targetUrl);
      await sleep(5000);
    }

    // Risk-control retry loop (plan-fix-risk-control-refresh-retry.md): every attempt
    // starts with a page refresh that clears the risk tile, then re-runs the
    // click input box → Ctrl+V → Enter gesture.
    return await this.withRiskControlRetry(bridge, targetUrl, `${opts.label} image`, async () => {
    // Failure baseline: only error tiles that appear AFTER this attempt abort it.
    const errorBaseline = (await bridge.queryDOM()).errorTiles.map((t) => t.text);

    await this.waitForEditor(bridge, 30_000);
    await this.disableAgentMode(bridge);

    // Baseline by identity: every image card currently on the canvas.
    const baselineState = await bridge.queryDOM();
    const knownImageKeys = new Set(
      baselineState.imageTiles.flatMap((t) => [t.key, t.src, t.mediaId]).filter((k): k is string => !!k)
    );
    console.log(pc.gray(`[flow-ext] ${opts.label}: baseline image cards on canvas: ${baselineState.imageTiles.length}`));

    // Reference the previous IMAGE card: right-click → "Add to prompt".
    const referenceMode = opts.referenceMode ?? 'optional';
    if (opts.referencePreviousImage !== false) {
      if (knownImageKeys.size === 0) {
        const msg =
          referenceMode === 'required'
            ? `${opts.label}: [连续/continuous] no image card is available to reference — the seamless continuation with the previous shot CANNOT be guaranteed`
            : `${opts.label}: [切分镜/cut] no previous image card to reference — generating the new shot without a visual reference`;
        if (referenceMode === 'required') {
          console.warn(pc.yellow(`⚠ ${msg}`));
        } else {
          console.log(pc.gray(msg));
        }
      } else {
        const matchKey =
          opts.referenceKey && knownImageKeys.has(opts.referenceKey) ? opts.referenceKey : null;
        if (opts.referenceKey && !matchKey) {
          console.warn(
            pc.yellow(
              `${opts.label}: recorded image card "${opts.referenceKey}" is no longer an image card on the canvas (likely animated to video) — falling back to the latest image card`
            )
          );
        }
        console.log(
          pc.cyan(
            `[flow-ext] ${opts.label}: referencing ${matchKey ? `image card "${matchKey}"` : 'the latest image card'} via "Add to prompt" for consistency...`
          )
        );
        await this.rightClickTile(bridge, {
          expect: 'image',
          matchKey,
          label: matchKey ? `image card "${matchKey}"` : 'latest image card',
        });
        await this.clickContextMenuItem(bridge, /add to prompt/i, 'add_2', 'Add to prompt');
        await sleep(800);
      }
    }

    // Configure for image generation with lite model & aspect ratio
    await this.configureSettings(bridge, 'image', {
      count: 1,
      modelSuffix: 'lite',
      aspectRatio: opts.aspect === 'portrait' ? '9:16' : '16:9',
    });

    // Fill prompt and generate
    await this.fillPrompt(bridge, opts.imagePrompt);
    await sleep(randomDelay(1500, 3000)); // Human-like review pause before clicking Generate
    await this.clickGenerate(bridge);
    await this.handleApprovalModal(bridge);
    console.log(pc.green(`✓ ${opts.label}: image generation submitted`));

    // Wait for the NEW image card by identity (video cards are never returned)
    const newTile = await this.waitForNewImageTile(bridge, knownImageKeys, opts.timeoutMs ?? 120_000, errorBaseline);
    console.log(pc.green(`✓ ${opts.label}: new image card created`));

    // Download keyframe image if requested (verified; never record a missing file)
    let finalImagePath: string | null = null;
    if (opts.imageOutputPath && newTile.src) {
      const target = path.resolve(opts.imageOutputPath);
      try {
        const downloaded = await ensureFileDownloaded({
          url: newTile.src,
          outputPath: target,
          download: (u, p) => this.downloadUrl(u, p),
        });
        finalImagePath = downloaded.outputPath;
        console.log(
          pc.green(
            `✓ ${opts.label}: keyframe image ${downloaded.alreadyPresent ? 'already downloaded once — skipping re-download' : 'downloaded once'} → ${downloaded.outputPath} (${downloaded.bytes} bytes)`
          )
        );
      } catch (e: any) {
        console.warn(pc.yellow(`[flow-ext] Warning: Could not download keyframe image: ${e.message}`));
      }
    }

    return {
      mediaKey: newTile.key,
      mediaId: newTile.mediaId,
      imageUrl: newTile.src,
      imageOutputPath: finalImagePath,
    };
    });
  }

  /**
   * PHASE 2 step — right-click ONE specific image card (matched by card identity
   * and aim-verified before the click, so a video card can never be hit) →
   * "Animate" → video prompt → MP4 synthesis → download.
   */
  private async animateClipImage(opts: {
    label: string;
    mediaKey: string | null;
    mediaSrc?: string | null;
    visualPrompt: string;
    duration: number;
    outputPath?: string;
    projectId?: string;
    aspect: 'landscape' | 'portrait';
    profileDir?: string;
    timeoutMs?: number;
  }): Promise<{ videoUrl: string; outputPath: string | null; downloadError?: string | null; quota: QuotaSnapshot }> {
    const profileDir = opts.profileDir ? path.resolve(opts.profileDir) : this.config.profileDir;

    let preflightPassed = false;
    try {
      const session = await this.ensureSession({ profileDir });
      const bridge = session.bridge;

      // Navigate to project if needed
      const targetUrl = opts.projectId ? `${FLOW_HOME_URL}/project/${opts.projectId}` : FLOW_HOME_URL;
      const currentInfo = await bridge.getPageInfo();
      if (!currentInfo.url.includes('flow.google.com/project/')) {
        await bridge.navigate(targetUrl);
        await sleep(5000);
      }

      // Real-credit pre-flight: live balance via the top-right avatar panel
      // (Account details → credits-count). Below VIDEO_CREDIT_COST → abort
      // before anything is submitted. See plan-flow-real-credits-limit.md.
      const creditsBefore = await bridge.getFlowCredits();
      console.log(pc.cyan(`[flow-ext] ${opts.label}: Flow credits before task: ${creditsBefore}`));
      assertSufficientCredits(creditsBefore, opts.label);
      preflightPassed = true;

      // Risk-control retry loop (plan-fix-risk-control-refresh-retry.md): every attempt
      // starts with a page refresh that clears the risk tile, then re-runs the
      // click input box → Ctrl+V → Enter gesture.
      const result = await this.withRiskControlRetry(bridge, targetUrl, `${opts.label} video`, async () => {
      // Failure baseline: only error tiles that appear AFTER this attempt abort it.
      const errorBaseline = (await bridge.queryDOM()).errorTiles.map((t) => t.text);

      await this.waitForEditor(bridge, 30_000);
      await this.disableAgentMode(bridge);

      if (!opts.mediaKey && !opts.mediaSrc) {
        throw new Error(
          `Cannot animate ${opts.label}: no image card identity (key/src) was recorded. ` +
          `Re-run the image phase first.`
        );
      }

      // ── Right-click the exact image card of this clip → Animate ──
      console.log(pc.cyan(`[flow-ext] ${opts.label}: right-clicking image card "${opts.mediaKey || opts.mediaSrc}" to animate video...`));
      await this.rightClickTile(bridge, {
        expect: 'image',
        matchKey: opts.mediaKey,
        matchSrc: opts.mediaSrc,
        label: `image card "${opts.mediaKey || opts.mediaSrc}"`,
      });

      await this.clickContextMenuItem(bridge, /animate/i, 'motion_blur', 'Animate');
      await sleep(2000);

      // Wait for video editor to appear
      await this.waitForEditor(bridge, 15_000);
      console.log(pc.green(`✓ ${opts.label}: video animation editor ready`));

      // Configure video settings with lite model & aspect ratio
      const targetAspect = opts.aspect === 'portrait' ? '9:16' : '16:9';
      await this.configureSettings(bridge, 'video', {
        count: 1,
        durationSec: opts.duration,
        modelSuffix: 'lite',
        aspectRatio: targetAspect,
      });

      // Record baseline video URLs
      const baselineVideoState = await bridge.queryDOM();
      const baselineVideoUrls = new Set(baselineVideoState.videoUrls);

      // Fill video prompt and generate
      const cleanVisualPrompt = sanitizeVisualPromptForVideoEngine(opts.visualPrompt);
      console.log(pc.gray(`Video Prompt: "${cleanVisualPrompt.slice(0, 80)}..."`));
      await this.fillPrompt(bridge, cleanVisualPrompt);
      await sleep(randomDelay(1500, 3000)); // Human-like review pause before clicking Generate
      await this.clickGenerate(bridge);
      await this.handleApprovalModal(bridge);

      // Only a genuinely accepted request (no fresh risk-control rejection)
      // counts as submitted.
      this.checkForErrors(await bridge.queryDOM(), errorBaseline);
      console.log(pc.green(`✓ ${opts.label}: video generation submitted. Awaiting synthesis...`));

      // Wait for video URL
      const videoUrl = await this.waitForVideoUrl(
        bridge,
        baselineVideoUrls,
        opts.timeoutMs ?? this.config.timeoutMs,
        errorBaseline
      );
      console.log(pc.green(`✓ ${opts.label}: video URL: ${videoUrl.slice(0, 90)}...`));

      // 每生成一个视频就下载一次：download the freshly synthesized MP4 immediately,
      // exactly once (a verified file on disk is never fetched again) and verified.
      let finalOutputPath: string | null = null;
      let downloadError: string | null = null;
      if (opts.outputPath) {
        const target = path.resolve(opts.outputPath);
        try {
          const downloaded = await ensureFileDownloaded({
            url: videoUrl,
            outputPath: target,
            download: (u, p) => this.downloadUrl(u, p),
          });
          finalOutputPath = downloaded.outputPath;
          if (downloaded.alreadyPresent) {
            console.log(pc.green(`✓ ${opts.label}: video already downloaded once — skipping re-download (${downloaded.bytes} bytes)`));
          } else {
            console.log(pc.green(`✓ ${opts.label}: video downloaded once → ${downloaded.outputPath} (${downloaded.bytes} bytes)`));
          }
        } catch (e: any) {
          // The video WAS generated — keep its URL, never pretend the file exists.
          downloadError = e.message;
          console.error(pc.red(`✗ ${opts.label}: video generated but download failed: ${e.message}`));
        }
      }

      return { videoUrl, outputPath: finalOutputPath, downloadError };
      });

      // Real-credit post-check: log the live balance after the task.
      const creditsAfter = await bridge.getFlowCredits();
      console.log(
        pc.green(`✓ ${opts.label}: Flow credits after task: ${creditsAfter} (Δ ${formatCreditDelta(creditsAfter - creditsBefore)})`)
      );
      return {
        ...result,
        quota: buildCreditSnapshot({ actualCredits: creditsAfter, creditsBefore, creditsAfter }),
      };
    } catch (err: any) {
      // Best-effort after-failure credit log — must never mask the original error.
      const bridge = this.session?.bridge;
      if (preflightPassed && bridge) {
        try {
          const creditsAfterFailure = await bridge.getFlowCredits();
          console.log(pc.yellow(`[flow-ext] ${opts.label}: Flow credits after failed task: ${creditsAfterFailure}`));
        } catch (readErr: any) {
          console.warn(pc.yellow(`[flow-ext] ${opts.label}: could not read credits after failure: ${readErr.message}`));
        }
      }
      throw err;
    }
  }

  /**
   * Counts the image/video attachments currently in the prompt box (in-page duplicate
   * of `readPromptAttachmentKinds` in src/flow/dom.ts for the extension path).
   */
  private async readPromptAttachments(bridge: NativeBridge): Promise<{ image: number; video: number; total: number }> {
    const res = await bridge.request({
      type: 'evaluate',
      code: `(() => {
        const chips = new Set();
        for (const el of Array.from(document.querySelectorAll(
          'flow-ingredient-chip, button[aria-label*="ingredient" i], [class*="chip-container"]'
        ))) chips.add(el.closest('flow-ingredient-chip') || el);
        for (const el of Array.from(document.querySelectorAll('[contenteditable="true"] img'))) chips.add(el);
        let image = 0, video = 0;
        for (const chip of chips) {
          if (chip.querySelector('video')) video++; else image++;
        }
        return { image, video, total: chips.size };
      })()`,
    });
    return (res?.result as { image: number; video: number; total: number }) || { image: 0, video: 0, total: 0 };
  }

  private async countPromptAttachments(bridge: NativeBridge): Promise<number> {
    return (await this.readPromptAttachments(bridge)).total;
  }

  /**
   * 连续/continuous continuation: attach the extracted LAST frame to the prompt box
   * as the starting frame. Success is verified by the attachment count increasing.
   */
  private async attachStartFrame(
    bridge: NativeBridge,
    imagePath: string
  ): Promise<{
    method: 'file-input' | 'clipboard-paste';
    attachmentsBefore: number;
    attachmentsAfter: number;
    imageChips: number;
    videoChips: number;
  }> {
    const bytes = await readFile(imagePath);
    if (!bytes || bytes.length === 0) {
      throw new Error(`Cannot attach starting frame: image file missing or empty: ${imagePath}`);
    }
    const before = await this.countPromptAttachments(bridge);

    // 1. File input injection with a real File payload (triggers the app's change handler).
    await bridge
      .request({
        type: 'evaluate',
        code: `(() => {
          try {
            const b64 = ${JSON.stringify(bytes.toString('base64'))};
            const bin = atob(b64);
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            const file = new File([arr], 'start-frame.jpg', { type: 'image/jpeg' });
            const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
            for (const input of inputs) {
              const dt = new DataTransfer();
              dt.items.add(file);
              input.files = dt.files;
              input.dispatchEvent(new Event('change', { bubbles: true }));
            }
            return inputs.length;
          } catch (e) {
            return 0;
          }
        })()`,
      })
      .catch(() => null);
    await sleep(1500);
    let kinds = await this.readPromptAttachments(bridge);
    if (kinds.total > before) {
      return {
        method: 'file-input',
        attachmentsBefore: before,
        attachmentsAfter: kinds.total,
        imageChips: kinds.image,
        videoChips: kinds.video,
      };
    }

    // 2. Clipboard image paste (xclip image/png target) + Ctrl+V.
    await setClipboardImage(imagePath);
    await systemPaste();
    await sleep(2000);
    kinds = await this.readPromptAttachments(bridge);
    if (kinds.total > before) {
      return {
        method: 'clipboard-paste',
        attachmentsBefore: before,
        attachmentsAfter: kinds.total,
        imageChips: kinds.image,
        videoChips: kinds.video,
      };
    }

    throw new Error(
      `Could not attach starting frame "${imagePath}" to the Flow prompt box (attachments before: ${before}). ` +
        `Inspect the Flow UI with --headed to find the upload control.`
    );
  }

  /**
   * 连续 (continuous, non-cut) step — continue the SAME shot WITHOUT generating an
   * image: extract the LAST frame of the previous clip's downloaded video, upload it
   * as the starting frame of the next generation, then synthesize → download.
   *
   * No image-generation fallback exists (plan-continuous-last-frame-video.md).
   */
  private async generateContinuationVideo(opts: {
    label: string;
    startFrameSourceVideo: string;
    startFramePath: string;
    visualPrompt: string;
    duration: number;
    outputPath?: string;
    projectId?: string;
    aspect: 'landscape' | 'portrait';
    profileDir?: string;
    timeoutMs?: number;
  }): Promise<{
    videoUrl: string;
    outputPath: string | null;
    downloadError?: string | null;
    startFramePath: string;
    quota: QuotaSnapshot;
  }> {
    const profileDir = opts.profileDir ? path.resolve(opts.profileDir) : this.config.profileDir;

    // 1. The previous clip's final frame becomes this clip's starting frame.
    console.log(
      pc.cyan(`[flow-ext] ${opts.label}: 连续/continuous — extracting the LAST frame of ${opts.startFrameSourceVideo}`)
    );
    const frame = await extractLastFrame(opts.startFrameSourceVideo, opts.startFramePath);
    console.log(
      pc.green(
        `✓ ${opts.label}: starting frame extracted → ${opts.startFramePath} (@ ${frame.timestampSec.toFixed(2)}s, ${frame.width}x${frame.height})`
      )
    );

    let preflightPassed = false;
    try {
      const session = await this.ensureSession({ profileDir });
      const bridge = session.bridge;

      const targetUrl = opts.projectId ? `${FLOW_HOME_URL}/project/${opts.projectId}` : FLOW_HOME_URL;
      const currentInfo = await bridge.getPageInfo();
      if (!currentInfo.url.includes('flow.google.com/project/')) {
        await bridge.navigate(targetUrl);
        await sleep(5000);
      }

      // Real-credit pre-flight: live balance via the top-right avatar panel
      // (Account details → credits-count). Below VIDEO_CREDIT_COST → abort
      // before anything is submitted. See plan-flow-real-credits-limit.md.
      const creditsBefore = await bridge.getFlowCredits();
      console.log(pc.cyan(`[flow-ext] ${opts.label}: Flow credits before task: ${creditsBefore}`));
      assertSufficientCredits(creditsBefore, opts.label);
      preflightPassed = true;

      const result = await this.withRiskControlRetry(bridge, targetUrl, `${opts.label} video`, async () => {
        const errorBaseline = (await bridge.queryDOM()).errorTiles.map((t) => t.text);
        await this.waitForEditor(bridge, 30_000);
        await this.disableAgentMode(bridge);

        // Direct video mode — no image card exists to Animate.
        await this.configureSettings(bridge, 'video', {
          count: 1,
          durationSec: opts.duration,
          modelSuffix: 'lite',
          aspectRatio: opts.aspect === 'portrait' ? '9:16' : '16:9',
        });

        // Text first — fillPrompt clears the editor and must not wipe the frame.
        const cleanVisualPrompt = sanitizeVisualPromptForVideoEngine(opts.visualPrompt);
        console.log(pc.gray(`Video Prompt: "${cleanVisualPrompt.slice(0, 80)}..."`));
        await this.fillPrompt(bridge, cleanVisualPrompt);
        await sleep(randomDelay(1000, 2000));

        // 2. Upload the extracted last frame as the starting frame (verified attach).
        const attached = await this.attachStartFrame(bridge, opts.startFramePath);
        if (attached.imageChips === 0) {
          throw new Error(
            `${opts.label}: the starting frame did not land as an IMAGE ingredient ` +
              `(image chips: ${attached.imageChips}, video chips: ${attached.videoChips}) — ` +
              `refusing to generate without a proper start frame`
          );
        }
        console.log(
          pc.green(
            `✓ ${opts.label}: starting frame attached via ${attached.method} (attachments ${attached.attachmentsBefore} → ${attached.attachmentsAfter}, image chips: ${attached.imageChips})`
          )
        );
        await sleep(randomDelay(1000, 2000));

        const baselineVideoState = await bridge.queryDOM();
        const baselineVideoUrls = new Set(baselineVideoState.videoUrls);

        await this.clickGenerate(bridge);
        await this.handleApprovalModal(bridge);
        this.checkForErrors(await bridge.queryDOM(), errorBaseline);
        console.log(pc.green(`✓ ${opts.label}: video generation submitted. Awaiting synthesis...`));

        const videoUrl = await this.waitForVideoUrl(
          bridge,
          baselineVideoUrls,
          opts.timeoutMs ?? this.config.timeoutMs,
          errorBaseline
        );
        console.log(pc.green(`✓ ${opts.label}: video URL: ${videoUrl.slice(0, 90)}...`));

        // 每生成一个视频就下载一次 — immediately, exactly once, verified.
        let finalOutputPath: string | null = null;
        let downloadError: string | null = null;
        if (opts.outputPath) {
          const target = path.resolve(opts.outputPath);
          try {
            const downloaded = await ensureFileDownloaded({
              url: videoUrl,
              outputPath: target,
              download: (u, p) => this.downloadUrl(u, p),
            });
            finalOutputPath = downloaded.outputPath;
            if (downloaded.alreadyPresent) {
              console.log(pc.green(`✓ ${opts.label}: video already downloaded once — skipping re-download (${downloaded.bytes} bytes)`));
            } else {
              console.log(pc.green(`✓ ${opts.label}: video downloaded once → ${downloaded.outputPath} (${downloaded.bytes} bytes)`));
            }
          } catch (e: any) {
            downloadError = e.message;
            console.error(pc.red(`✗ ${opts.label}: video generated but download failed: ${e.message}`));
          }
        }

        return {
          videoUrl,
          outputPath: finalOutputPath,
          downloadError,
          startFramePath: opts.startFramePath,
        };
      });

      // Real-credit post-check: log the live balance after the task.
      const creditsAfter = await bridge.getFlowCredits();
      console.log(
        pc.green(`✓ ${opts.label}: Flow credits after task: ${creditsAfter} (Δ ${formatCreditDelta(creditsAfter - creditsBefore)})`)
      );
      return {
        ...result,
        quota: buildCreditSnapshot({ actualCredits: creditsAfter, creditsBefore, creditsAfter }),
      };
    } catch (err: any) {
      // Best-effort after-failure credit log — must never mask the original error.
      const bridge = this.session?.bridge;
      if (preflightPassed && bridge) {
        try {
          const creditsAfterFailure = await bridge.getFlowCredits();
          console.log(pc.yellow(`[flow-ext] ${opts.label}: Flow credits after failed task: ${creditsAfterFailure}`));
        } catch (readErr: any) {
          console.warn(pc.yellow(`[flow-ext] ${opts.label}: could not read credits after failure: ${readErr.message}`));
        }
      }
      throw err;
    }
  }

  /**
   * Select an image asset from the project for the Start or End frame slot in Frames mode.
   * Clicks the slot trigger, waits for the asset picker overlay (.cdk-overlay-pane),
   * finds and clicks the matching generated image card, and verifies slot binding.
   */
  private async selectProjectFrameAsset(
    bridge: NativeBridge,
    slot: 'start' | 'end',
    match: {
      prompt?: string;
      mediaKey?: string | null;
      mediaId?: string | null;
      indexFromTop?: number;
    }
  ): Promise<void> {
    console.log(pc.cyan(`[flow-ext] Selecting ${slot} frame image from project...`));

    // 0. Ensure Agent mode is deactivated
    await this.disableAgentMode(bridge);

    // 0b. If slot already contains an image, clear it first so it becomes an empty button
    await bridge.request({
      type: 'evaluate',
      code: `(() => {
        const frameTriggers = Array.from(document.querySelectorAll('.frame-trigger'));
        const idx = '${slot}'.toLowerCase() === 'start' ? 0 : 1;
        const trigger = frameTriggers[idx];
        if (trigger && trigger.querySelector('img')) {
          const cancelBtn = trigger.querySelector('.hover-icon-overlay, mat-icon, button[aria-label*="cancel" i], button');
          if (cancelBtn) cancelBtn.click();
        }
      })()`,
    });
    await sleep(600);

    // 1. Locate and click the Start or End frame trigger in the prompt box with polling wait
    let triggerRes: any = null;
    const findDeadline = Date.now() + 10_000;
    while (Date.now() < findDeadline) {
      triggerRes = await bridge.request({
        type: 'evaluate',
        code: `(() => {
          const target = '${slot}'.toLowerCase();
          // Pass 1: text match
          const triggers = Array.from(document.querySelectorAll('.frame-trigger button, .frame-trigger, button.empty-chip'));
          for (const t of triggers) {
            const text = (t.textContent || '').trim().toLowerCase();
            if (text === target || (target === 'start' && text.includes('start')) || (target === 'end' && text.includes('end'))) {
              t.scrollIntoView({ block: 'center' });
              const r = t.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) {
                return { found: true, x: r.x + r.width / 2, y: r.y + r.height / 2 };
              }
            }
          }
          // Pass 2: positional order (first is start, second is end)
          const frameTriggers = Array.from(document.querySelectorAll('.frame-trigger'));
          const idx = target === 'start' ? 0 : 1;
          if (frameTriggers[idx]) {
            const el = frameTriggers[idx].querySelector('button') || frameTriggers[idx];
            el.scrollIntoView({ block: 'center' });
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              return { found: true, x: r.x + r.width / 2, y: r.y + r.height / 2 };
            }
          }
          // Pass 3: within flow-ingredient-bar
          const bar = document.querySelector('flow-ingredient-bar');
          if (bar) {
            const barBtns = Array.from(bar.querySelectorAll('button.empty-chip, button'));
            const candidate = target === 'start' ? barBtns[0] : barBtns[barBtns.length - 1];
            if (candidate) {
              const r = candidate.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) {
                return { found: true, x: r.x + r.width / 2, y: r.y + r.height / 2 };
              }
            }
          }
          return { found: false };
        })()`,
      });

      if (triggerRes?.result?.found) break;
      await sleep(400);
    }

    if (!triggerRes?.result?.found) {
      throw new Error(`Could not find "${slot}" frame button in prompt box.`);
    }

    await systemClick(triggerRes.result.x, triggerRes.result.y);
    await sleep(1500);

    // 2. Wait for project asset overlay (.cdk-overlay-pane)
    const deadline = Date.now() + 10_000;
    let overlayReady = false;
    while (Date.now() < deadline) {
      const check = await bridge.request({
        type: 'evaluate',
        code: `Boolean(document.querySelector('.cdk-overlay-pane:not(:has(mat-snack-bar-container))'))`,
      });
      if (check?.result) {
        overlayReady = true;
        break;
      }
      await sleep(400);
    }
    if (!overlayReady) {
      throw new Error(`Project asset picker overlay did not open for ${slot} frame.`);
    }

    // 3. Search and click the asset item matching the generated image
    const promptSnippet = (match.prompt || '').slice(0, 30).trim().toLowerCase();
    const selectRes = await bridge.request({
      type: 'evaluate',
      code: `(() => {
        const overlay = document.querySelector('.cdk-overlay-pane:not(:has(mat-snack-bar-container))');
        if (!overlay) return { success: false, reason: 'no-overlay' };

        const items = Array.from(overlay.querySelectorAll('button.asset-item, .asset-item, flow-add-menu-asset-item'));
        if (items.length === 0) return { success: false, reason: 'no-items' };

        // Priority 1: Match by prompt text snippet
        const snippet = ${JSON.stringify(promptSnippet)};
        if (snippet.length >= 6) {
          for (const item of items) {
            const text = (item.textContent || '').toLowerCase();
            if (text.includes(snippet)) {
              item.scrollIntoView({ block: 'center' });
              const r = item.getBoundingClientRect();
              return { success: true, x: r.x + r.width / 2, y: r.y + r.height / 2, matched: 'prompt' };
            }
          }
        }

        // Priority 2: Match by mediaKey / mediaId if in data attributes
        const key = ${JSON.stringify(match.mediaKey || '')};
        const id = ${JSON.stringify(match.mediaId || '')};
        if (key || id) {
          for (const item of items) {
            if ((key && item.getAttribute('data-media-id') === key) || (id && item.getAttribute('data-id') === id)) {
              item.scrollIntoView({ block: 'center' });
              const r = item.getBoundingClientRect();
              return { success: true, x: r.x + r.width / 2, y: r.y + r.height / 2, matched: 'id' };
            }
          }
        }

        // Priority 3: Positional selection (recent assets)
        const targetIdx = Math.min(${match.indexFromTop ?? 0}, items.length - 1);
        const fallbackItem = items[targetIdx];
        if (fallbackItem) {
          fallbackItem.scrollIntoView({ block: 'center' });
          const r = fallbackItem.getBoundingClientRect();
          return { success: true, x: r.x + r.width / 2, y: r.y + r.height / 2, matched: 'index' };
        }

        return { success: false, reason: 'not-found' };
      })()`,
    });

    if (!selectRes?.result?.success) {
      throw new Error(`Could not find generated image in project asset picker for ${slot} frame.`);
    }
    if (selectRes.result.matched === 'index') {
      console.warn(
        pc.yellow(
          `[flow-ext] ⚠ ${slot} frame: asset picked by POSITIONAL fallback (index ${match.indexFromTop ?? 0}) — ` +
            `no media-key/prompt identity match. Verify the attached frame before submitting.`
        )
      );
    }

    await systemClick(selectRes.result.x, selectRes.result.y);
    await sleep(1000);

    // Check if an "Add to prompt" confirm button exists in the overlay
    await bridge.request({
      type: 'evaluate',
      code: `(() => {
        const btns = Array.from(document.querySelectorAll('.cdk-overlay-pane button, [role="menu"] button'));
        for (const b of btns) {
          if (/add to prompt/i.test(b.textContent || '')) {
            b.click();
            return true;
          }
        }
        return false;
      })()`,
    });
    await sleep(800);

    // Dismiss overlay if still open
    await systemEscape();
    await sleep(500);

    // 4. Verify slot is filled with image
    const verifyRes = await bridge.request({
      type: 'evaluate',
      code: `(() => {
        const triggers = Array.from(document.querySelectorAll('.frame-trigger'));
        const idx = '${slot}' === 'start' ? 0 : 1;
        const targetTrigger = triggers[idx] || document.querySelector('.frame-trigger:has(img)');
        return Boolean(targetTrigger && targetTrigger.querySelector('img'));
      })()`,
    });

    console.log(pc.green(`✓ [flow-ext] ${slot} frame image selected and attached (verified: ${verifyRes?.result})`));
  }

  /**
   * 切分镜/cut step: generate video using Frames mode (Start Frame + End Frame).
   * NO right-click animate.
   * 1. Configures video settings with Frames mode.
   * 2. Clicks Start frame trigger, selects the project start image.
   * 3. Clicks End frame trigger, selects the project end image.
   * 4. Fills visualPrompt, submits video generation, and downloads MP4.
   */
  private async generateFramesVideo(opts: {
    label: string;
    startImage: { prompt: string; mediaKey: string | null; mediaId?: string | null };
    endImage: { prompt: string; mediaKey: string | null; mediaId?: string | null };
    visualPrompt: string;
    duration: number;
    outputPath?: string;
    projectId?: string;
    aspect: 'landscape' | 'portrait';
    profileDir?: string;
    timeoutMs?: number;
  }): Promise<{ videoUrl: string; outputPath: string | null; downloadError?: string | null; quota: QuotaSnapshot }> {
    const profileDir = opts.profileDir ? path.resolve(opts.profileDir) : this.config.profileDir;

    let preflightPassed = false;
    try {
      const session = await this.ensureSession({ profileDir });
      const bridge = session.bridge;

      const targetUrl = opts.projectId ? `${FLOW_HOME_URL}/project/${opts.projectId}` : FLOW_HOME_URL;
      const currentInfo = await bridge.getPageInfo();
      if (!currentInfo.url.includes('flow.google.com/project/')) {
        await bridge.navigate(targetUrl);
        await sleep(5000);
      }

      // Real-credit pre-flight
      const creditsBefore = await bridge.getFlowCredits();
      console.log(pc.cyan(`[flow-ext] ${opts.label}: Flow credits before task: ${creditsBefore}`));
      assertSufficientCredits(creditsBefore, opts.label);
      preflightPassed = true;

      const result = await this.withRiskControlRetry(bridge, targetUrl, `${opts.label} frames-video`, async () => {
        const errorBaseline = (await bridge.queryDOM()).errorTiles.map((t) => t.text);

        await this.waitForEditor(bridge, 30_000);
        await this.disableAgentMode(bridge);

        // 1. Configure settings for video with Frames mode
        console.log(pc.cyan(`[flow-ext] ${opts.label}: Configuring video settings (Frames mode, duration: ${opts.duration}s)...`));
        await this.configureSettings(bridge, 'video', {
          count: 1,
          durationSec: opts.duration,
          modelSuffix: 'frames',
          aspectRatio: opts.aspect === 'portrait' ? '9:16' : '16:9',
        });
        // Fail fast (retryably) when the Frames controls never mounted — the
        // selector would otherwise fail with a cryptic DOM error.
        await this.waitForFramesControls(bridge, opts.label);

        // 2. Select start frame image from project
        await this.selectProjectFrameAsset(bridge, 'start', {
          prompt: opts.startImage.prompt,
          mediaKey: opts.startImage.mediaKey,
          mediaId: opts.startImage.mediaId,
          indexFromTop: 1,
        });
        await sleep(randomDelay(800, 1500));

        // 3. Select end frame image from project
        await this.selectProjectFrameAsset(bridge, 'end', {
          prompt: opts.endImage.prompt,
          mediaKey: opts.endImage.mediaKey,
          mediaId: opts.endImage.mediaId,
          indexFromTop: 0,
        });
        await sleep(randomDelay(800, 1500));

        // 4. Fill companion video prompt
        const cleanVisualPrompt = sanitizeVisualPromptForVideoEngine(opts.visualPrompt);
        console.log(pc.gray(`Video Prompt: "${cleanVisualPrompt.slice(0, 80)}..."`));
        await this.fillPrompt(bridge, cleanVisualPrompt);
        await sleep(randomDelay(1500, 3000));

        // 5. Submit generation
        const baselineVideoState = await bridge.queryDOM();
        const baselineVideoUrls = new Set(baselineVideoState.videoUrls);

        await this.clickGenerate(bridge);
        await this.handleApprovalModal(bridge);
        this.checkForErrors(await bridge.queryDOM(), errorBaseline);
        console.log(pc.green(`✓ ${opts.label}: Frames video generation submitted. Awaiting synthesis...`));

        // 6. Wait for video URL
        const videoUrl = await this.waitForVideoUrl(
          bridge,
          baselineVideoUrls,
          opts.timeoutMs ?? this.config.timeoutMs,
          errorBaseline
        );
        console.log(pc.green(`✓ ${opts.label}: video URL: ${videoUrl.slice(0, 90)}...`));

        // Download synthesized MP4
        let finalOutputPath: string | null = null;
        let downloadError: string | null = null;
        if (opts.outputPath) {
          const target = path.resolve(opts.outputPath);
          try {
            const downloaded = await ensureFileDownloaded({
              url: videoUrl,
              outputPath: target,
              download: (u, p) => this.downloadUrl(u, p),
            });
            finalOutputPath = downloaded.outputPath;
            if (downloaded.alreadyPresent) {
              console.log(pc.green(`✓ ${opts.label}: video already downloaded once — skipping re-download (${downloaded.bytes} bytes)`));
            } else {
              console.log(pc.green(`✓ ${opts.label}: video downloaded once → ${downloaded.outputPath} (${downloaded.bytes} bytes)`));
            }
          } catch (e: any) {
            downloadError = e.message;
            console.error(pc.red(`✗ ${opts.label}: video generated but download failed: ${e.message}`));
          }
        }

        return { videoUrl, outputPath: finalOutputPath, downloadError };
      });

      const creditsAfter = await bridge.getFlowCredits();
      console.log(
        pc.green(`✓ ${opts.label}: Flow credits after task: ${creditsAfter} (Δ ${formatCreditDelta(creditsAfter - creditsBefore)})`)
      );
      return {
        ...result,
        quota: buildCreditSnapshot({ actualCredits: creditsAfter, creditsBefore, creditsAfter }),
      };
    } catch (err: any) {
      const bridge = this.session?.bridge;
      if (preflightPassed && bridge) {
        try {
          const creditsAfterFailure = await bridge.getFlowCredits();
          console.log(pc.yellow(`[flow-ext] ${opts.label}: Flow credits after failed task: ${creditsAfterFailure}`));
        } catch {}
      }
      throw err;
    }
  }

  /**
   * Generate a video using the full image-first → Animate → video pipeline
   * (single-clip convenience wrapper around the two-phase steps:
   * keyframe image → Animate → video).
   */
  async generateVideo(rawOptions: GenerateOptions): Promise<GenerationResult> {
    const profileDir = rawOptions.profileDir
      ? path.resolve(rawOptions.profileDir)
      : this.config.profileDir;
    const effectiveImagePrompt = rawOptions.imagePrompt?.trim() || rawOptions.prompt.trim();
    const aspect = (rawOptions.aspect as 'landscape' | 'portrait') || 'landscape';

    if (rawOptions.endImagePrompt?.trim()) {
      console.log(pc.cyan(`[flow-ext] Step 1/3: Generating Start keyframe image...`));
      const startImage = await this.generateClipImage({
        label: 'clip-start',
        imagePrompt: effectiveImagePrompt,
        imageOutputPath: rawOptions.imageOutputPath,
        projectId: rawOptions.projectId,
        aspect,
        profileDir,
        referencePreviousImage: false,
      });

      console.log(pc.cyan(`[flow-ext] Step 2/3: Generating End keyframe image...`));
      const endImage = await this.generateClipImage({
        label: 'clip-end',
        imagePrompt: rawOptions.endImagePrompt.trim(),
        imageOutputPath: rawOptions.endImageOutputPath,
        projectId: rawOptions.projectId,
        aspect,
        profileDir,
        referencePreviousImage: true,
        referenceKey: startImage.mediaKey,
      });

      console.log(pc.cyan(`[flow-ext] Step 3/3: Generating Frames video (NO right-click animate)...`));
      const video = await this.generateFramesVideo({
        label: 'clip',
        startImage: { prompt: effectiveImagePrompt, mediaKey: startImage.mediaKey, mediaId: startImage.mediaId },
        endImage: { prompt: rawOptions.endImagePrompt.trim(), mediaKey: endImage.mediaKey, mediaId: endImage.mediaId },
        visualPrompt: rawOptions.prompt,
        duration: (rawOptions.duration as number) || 4,
        outputPath: rawOptions.outputPath,
        projectId: rawOptions.projectId,
        aspect,
        profileDir,
        timeoutMs: rawOptions.timeoutMs,
      });

      if (video.downloadError) {
        throw new Error(
          `Video was generated (${video.videoUrl}) but could not be downloaded: ${video.downloadError}`
        );
      }

      return {
        project: { projectId: null, url: '' },
        quota: video.quota,
        videoUrl: video.videoUrl,
        outputPath: video.outputPath,
        imageUrl: startImage.imageUrl,
        imageOutputPath: startImage.imageOutputPath,
        durationSec: rawOptions.duration,
        prompt: rawOptions.prompt,
        model: 'frames',
        createdAt: new Date().toISOString(),
      };
    }

    console.log(pc.cyan(`[flow-ext] Step 1/2: Generating keyframe image...`));
    const image = await this.generateClipImage({
      label: 'clip',
      imagePrompt: effectiveImagePrompt,
      imageOutputPath: rawOptions.imageOutputPath,
      projectId: rawOptions.projectId,
      aspect,
      profileDir,
      referencePreviousImage: true,
    });

    console.log(pc.cyan(`[flow-ext] Step 2/2: Animating to video...`));
    const video = await this.animateClipImage({
      label: 'clip',
      mediaKey: image.mediaKey,
      mediaSrc: image.imageUrl,
      visualPrompt: rawOptions.prompt,
      duration: (rawOptions.duration as number) || 4,
      outputPath: rawOptions.outputPath,
      projectId: rawOptions.projectId,
      aspect,
      profileDir,
      timeoutMs: rawOptions.timeoutMs,
    });

    if (video.downloadError) {
      throw new Error(
        `Video was generated (${video.videoUrl}) but could not be downloaded: ${video.downloadError}`
      );
    }

    return {
      project: { projectId: null, url: '' },
      quota: video.quota,
      videoUrl: video.videoUrl,
      outputPath: video.outputPath,
      imageUrl: image.imageUrl,
      imageOutputPath: image.imageOutputPath,
      durationSec: rawOptions.duration,
      prompt: rawOptions.prompt,
      model: rawOptions.model,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Batch generate clips from a script file in an ALTERNATING rhythm
   * (see plan-shot-continuity-and-alternating-flow.md):
   *
   *   clip-001 image → clip-001 video → clip-002 image → clip-002 video → …
   *
   * i.e. exactly one keyframe image and one video per clip, clip by clip. Every
   * right-click is aim-verified so it can only land on an image card. Each clip's
   * shot-transition annotation (切分镜 "cut" / 连续 "continuous") drives the visual
   * reference behaviour: "continuous" clips REQUIRE the previous clip's image card as
   * reference (seamless continuation) and warn loudly when it is gone, "cut" clips use
   * it only for character/style consistency.
   */
  async batchGenerate(rawOptions: BatchOptions, run?: RunContext): Promise<BatchResult> {
    const scriptPath = path.resolve(rawOptions.scriptPath);
    const outDir = path.resolve(rawOptions.outDir);

    const scriptContent = await readFile(scriptPath, 'utf8');
    const script = JSON.parse(scriptContent) as {
      aspectRatio?: 'landscape' | 'portrait';
      clips: Array<{
        clipIndex: number;
        sceneId?: string;
        title?: string;
        imagePrompt?: string;
        imageUrl?: string;
        localImagePath?: string;
        imageTileKey?: string | null;
        endImagePrompt?: string;
        endImageUrl?: string;
        localEndImagePath?: string;
        endImageTileKey?: string | null;
        visualPrompt: string;
        transition?: string;
        transitionNote?: string;
        planMode?: string;
        startFrameSourceVideo?: string;
        startFramePath?: string;
        durationSec?: number;
        status?: string;
        videoUrl?: string;
        localVideoPath?: string;
        error?: string;
      }>;
    };

    if (!Array.isArray(script.clips) || script.clips.length === 0) {
      throw new Error(`Invalid or empty script: ${scriptPath}`);
    }

    const eligible = script.clips.filter(
      (c) => c.status !== 'completed' && (!rawOptions.maxClips || c.clipIndex <= rawOptions.maxClips)
    );

    console.log(pc.cyan(`\n=== Flow Batch Video Generation (Extension Mode, alternating rhythm: image → video per clip) ===`));
    console.log(pc.gray(`Script: ${scriptPath}`));
    console.log(pc.gray(`Clips: ${script.clips.length} total, ${eligible.length} pending`));

    const clipAspect =
      (script.aspectRatio as 'landscape' | 'portrait') || rawOptions.aspect || 'landscape';

    const work = eligible.map((clip) => {
      const label = `clip-${String(clip.clipIndex).padStart(3, '0')}`;
      return {
        clip,
        label,
        clipVideo: path.join(outDir, `${label}.mp4`),
        clipImage: path.join(outDir, `${label}-start.jpg`),
        clipEndImage: path.join(outDir, `${label}-end.jpg`),
        imagePrompt: clip.imagePrompt?.trim() || clip.visualPrompt.trim(),
        endImagePrompt: clip.endImagePrompt?.trim() || `${clip.imagePrompt?.trim() || clip.visualPrompt.trim()} Concluding settled pose.`,
      };
    });

    // Dry-run: report the planned alternating work (image → video per clip) without
    // touching the canvas.
    if (rawOptions.dryRun) {
      const results: BatchClipResult[] = work.map((item) => {
        const transition = item.clip.transition === 'continuous' ? 'continuous' : 'cut';
        console.log(
          pc.yellow(
            `[DRY RUN] [${item.label}] (${transition === 'continuous' ? '连续/continuous' : '切分镜/cut'})${
              item.clip.transitionNote ? ` 备注: ${item.clip.transitionNote}` : ''
            }`
          )
        );
        console.log(
          pc.yellow(
            `[DRY RUN]   ${transition === 'continuous' ? 'start-frame: last frame of the previous clip video (no image)' : `image: "${item.imagePrompt.slice(0, 80)}..."`}`
          )
        );
        console.log(pc.yellow(`[DRY RUN]   video: "${item.clip.visualPrompt.slice(0, 80)}..."`));
        return {
          clipIndex: item.clip.clipIndex,
          status: 'skipped',
          imagePrompt: item.imagePrompt,
          visualPrompt: item.clip.visualPrompt,
          transition,
          transitionNote: item.clip.transitionNote,
        };
      });
      return {
        totalClips: eligible.length,
        completedClips: 0,
        failedClips: 0,
        skippedClips: results.length,
        outDir,
        results,
      };
    }

    const results: BatchClipResult[] = [];
    let completed = 0;
    let failed = 0;
    let latestCredits: number | undefined;

    const persistScript = async () => {
      if (run) await run.write('script', FlowVideoScriptSchema.parse(script));
      else await writeFile(scriptPath, JSON.stringify(script, null, 2) + '\n', 'utf8');
    };

    // ── Alternating rhythm: one video per clip, clip by clip ──
    // (see plan-shot-continuity-and-alternating-flow.md + plan-continuous-last-frame-video.md)
    //   切分镜/cut       → clip-00N: 文生图关键帧 → 图生视频 (Animate) → 下载
    //   连续/continuous  → clip-00N: 不生图，取上一片段视频末帧上传作为起始帧 → 生视频 → 下载
    // Right-clicks stay aimed and identity-verified, so they can only land on image
    // cards. The visual reference is the previous clip's recorded image card when it is
    // still an image card; if it was animated into a video card the reference is skipped
    // and the warning severity follows this clip's shot-transition annotation
    // (连续/continuous = required, 切分镜/cut = optional).
    console.log(pc.cyan(`\n=== Generating ${work.length} clip(s) in alternating rhythm: image → video → image → video … ===`));

    let previousImageKey: string | null = null;
    /** Downloaded MP4 of the immediately preceding clip — the 连续/continuous continuation source. */
    let previousVideo: { clipIndex: number; path: string } | null = null;

    const orderedClips = [...script.clips].sort((a, b) => a.clipIndex - b.clipIndex);
    // Reject stale/duplicate Flow results loudly: seed with every clip already
    // completed (this session or a prior one), then check each new clip by
    // canonical video ID + file content hash before it can be marked completed.
    const duplicateGuard = await ClipDuplicateGuard.seed(
      orderedClips
        .filter((c) => c.status === 'completed')
        .map((c) => ({
          label: `clip-${String(c.clipIndex).padStart(3, '0')}`,
          videoUrl: c.videoUrl,
          localVideoPath: c.localVideoPath,
        }))
    );
    const rejectDuplicateClip = async (
      item: { label: string },
      video: { videoUrl: string; outputPath: string | null }
    ): Promise<string | null> => {
      const dupe = await duplicateGuard.register({
        label: item.label,
        videoUrl: video.videoUrl,
        localVideoPath: video.outputPath,
      });
      if (!dupe) return null;
      return `${item.label}: Flow returned a duplicate video (${dupe}) — refusing to stitch stale content into the final video`;
    };
    const resolvePreviousVideo = async (
      clipIndex: number
    ): Promise<{ path: string | null; clipIndex: number | null }> => {
      const idx = orderedClips.findIndex((c) => c.clipIndex === clipIndex);
      const prev = idx > 0 ? orderedClips[idx - 1] : undefined;
      if (!prev) return { path: null, clipIndex: null };
      const candidates = [
        previousVideo && previousVideo.clipIndex === prev.clipIndex ? previousVideo.path : null,
        prev.localVideoPath,
      ];
      for (const candidate of candidates) {
        if (!candidate) continue;
        const info = await stat(candidate).catch(() => null);
        if (info && info.isFile() && info.size > 0) return { path: candidate, clipIndex: prev.clipIndex };
      }
      return { path: null, clipIndex: prev.clipIndex };
    };

    for (const item of work) {
      const { clip } = item;
      const transition: 'cut' | 'continuous' = clip.transition === 'continuous' ? 'continuous' : 'cut';
      console.log(
        pc.cyan(
          `\n--- [Clip ${clip.clipIndex}/${script.clips.length}] ${clip.title || item.label} ` +
            `(${transition === 'continuous' ? '连续/continuous' : '切分镜/cut'}) ---`
        )
      );
      if (clip.transitionNote) {
        console.log(pc.gray(`  备注: ${clip.transitionNote}`));
      }

      // ── Generation mode from the shot-transition annotation ──
      //   切分镜/cut       → 文生图关键帧 → 图生视频 (Animate)
      //   连续/continuous  → 不生图，取上一片段视频末帧上传作为起始帧续生视频
      const previous = await resolvePreviousVideo(clip.clipIndex);
      const plan = planClipGeneration({
        clipIndex: clip.clipIndex,
        transition,
        previousVideoPath: previous.path,
        previousClipIndex: previous.clipIndex,
      });
      console.log(pc.gray(`  生成方式: ${plan.reason}`));

      if (plan.mode === 'frame-continue') {
        const startFrameFile = path.join(outDir, `${item.label}-start-frame.jpg`);
        clip.planMode = plan.mode;
        clip.startFrameSourceVideo = plan.startFrameSourceVideo!;
        clip.startFramePath = startFrameFile;
        await persistScript();

        try {
          const video = await this.generateContinuationVideo({
            label: item.label,
            startFrameSourceVideo: plan.startFrameSourceVideo!,
            startFramePath: startFrameFile,
            visualPrompt: clip.visualPrompt,
            duration: (clip.durationSec as number) || 4,
            outputPath: item.clipVideo,
            projectId: rawOptions.projectId,
            aspect: clipAspect as 'landscape' | 'portrait',
            profileDir: rawOptions.profileDir,
          });

          if (video.downloadError) {
            clip.status = 'failed';
            clip.videoUrl = video.videoUrl;
            clip.error = `video generated (${video.videoUrl}) but download failed: ${video.downloadError}`;
            delete clip.localVideoPath;
            await persistScript();
            results.push({
              clipIndex: clip.clipIndex,
              status: 'failed',
              imagePrompt: item.imagePrompt,
              visualPrompt: clip.visualPrompt,
              transition,
              transitionNote: clip.transitionNote,
              videoUrl: video.videoUrl,
              error: clip.error,
            });
            failed++;
            console.warn(pc.yellow(`[flow-ext] Stopping batch run due to clip failure: ${clip.error}`));
            break;
          }

          const duplicateError = await rejectDuplicateClip(item, video);
          if (duplicateError) {
            clip.status = 'failed';
            clip.videoUrl = video.videoUrl;
            clip.error = duplicateError;
            delete clip.localVideoPath;
            await persistScript();
            results.push({
              clipIndex: clip.clipIndex,
              status: 'failed',
              imagePrompt: item.imagePrompt,
              visualPrompt: clip.visualPrompt,
              transition,
              transitionNote: clip.transitionNote,
              videoUrl: video.videoUrl,
              error: duplicateError,
            });
            failed++;
            console.warn(pc.yellow(`[flow-ext] Stopping batch run due to clip failure: ${duplicateError}`));
            break;
          }

          clip.status = 'completed';
          clip.videoUrl = video.videoUrl;
          clip.localVideoPath = video.outputPath ?? undefined;
          delete clip.error;
          await persistScript();
          results.push({
            clipIndex: clip.clipIndex,
            status: 'completed',
            imagePrompt: item.imagePrompt,
            imageUrl: clip.imageUrl,
            localImagePath: clip.localImagePath,
            visualPrompt: clip.visualPrompt,
            transition,
            transitionNote: clip.transitionNote,
            videoUrl: video.videoUrl,
            outputPath: video.outputPath ?? undefined,
          });
          completed++;
          if (video.quota?.actualCredits !== undefined) latestCredits = video.quota.actualCredits;
          if (video.outputPath) previousVideo = { clipIndex: clip.clipIndex, path: video.outputPath };
        } catch (err: any) {
          console.error(pc.red(`✗ ${item.label} continuation from last frame failed: ${err.message}`));
          clip.status = 'failed';
          clip.error = err.message;
          await persistScript();
          results.push({
            clipIndex: clip.clipIndex,
            status: 'failed',
            imagePrompt: item.imagePrompt,
            visualPrompt: clip.visualPrompt,
            transition,
            transitionNote: clip.transitionNote,
            error: err.message,
          });
          failed++;
          console.warn(pc.yellow(`[flow-ext] Stopping batch run due to clip failure: ${err.message}`));
          break;
        }

        continue;
      }

      // ── 切分镜/cut — Step 1/3 & 2/3: generate Start image & End image ──
      // (NO right-click animate; Frames mode interpolates between Start and End images)
      clip.planMode = 'frames-cut';
      const hasStartImage = Boolean((clip.imageUrl || clip.localImagePath) && (clip.imageTileKey || clip.imageUrl));
      const hasEndImage = Boolean((clip.endImageUrl || clip.localEndImagePath) && (clip.endImageTileKey || clip.endImageUrl));

      // 1. Generate Start image if not already present
      if (hasStartImage) {
        console.log(pc.yellow(`[flow-ext] ${item.label}: Start keyframe image already generated — reusing`));
      } else {
        try {
          const startImg = await this.generateClipImage({
            label: `${item.label} start-image`,
            imagePrompt: item.imagePrompt,
            imageOutputPath: item.clipImage,
            projectId: rawOptions.projectId,
            aspect: clipAspect as 'landscape' | 'portrait',
            profileDir: rawOptions.profileDir,
            referencePreviousImage: true,
            referenceKey: previousImageKey,
            referenceMode: 'optional',
          });

          clip.imageUrl = startImg.imageUrl || undefined;
          clip.localImagePath = startImg.imageOutputPath || undefined;
          // Truthful identity: src UUID, else content hash of the downloaded file
          // (recycled tiles carry stale attribute keys; asb srcs carry no UUID).
          clip.imageTileKey = await resolveMediaKey(startImg.imageUrl, startImg.imageOutputPath, startImg.mediaKey);
          delete clip.error;
          await persistScript();
          console.log(pc.green(`✓ ${item.label}: Start keyframe image ready`));
        } catch (err: any) {
          console.error(pc.red(`✗ ${item.label} start image failed: ${err.message}`));
          clip.status = 'failed';
          clip.error = err.message;
          await persistScript();
          results.push({
            clipIndex: clip.clipIndex,
            status: 'failed',
            imagePrompt: item.imagePrompt,
            visualPrompt: clip.visualPrompt,
            transition,
            transitionNote: clip.transitionNote,
            error: err.message,
          });
          failed++;
          console.warn(pc.yellow(`[flow-ext] Stopping batch run due to clip failure: ${err.message}`));
          break;
        }
      }

      // 2. Generate End image if not already present
      if (hasEndImage) {
        console.log(pc.yellow(`[flow-ext] ${item.label}: End keyframe image already generated — reusing`));
      } else {
        try {
          const endImg = await this.generateClipImage({
            label: `${item.label} end-image`,
            imagePrompt: item.endImagePrompt,
            imageOutputPath: item.clipEndImage,
            projectId: rawOptions.projectId,
            aspect: clipAspect as 'landscape' | 'portrait',
            profileDir: rawOptions.profileDir,
            referencePreviousImage: true,
            referenceKey: clip.imageTileKey ?? null,
            referenceMode: 'optional',
          });

          clip.endImageUrl = endImg.imageUrl || undefined;
          clip.localEndImagePath = endImg.imageOutputPath || undefined;
          // Truthful identity: src UUID, else content hash of the downloaded file
          // (recycled tiles carry stale attribute keys; asb srcs carry no UUID).
          clip.endImageTileKey = await resolveMediaKey(endImg.imageUrl, endImg.imageOutputPath, endImg.mediaKey);
          delete clip.error;
          await persistScript();
          console.log(pc.green(`✓ ${item.label}: End keyframe image ready`));
        } catch (err: any) {
          console.error(pc.red(`✗ ${item.label} end image failed: ${err.message}`));
          clip.status = 'failed';
          clip.error = err.message;
          await persistScript();
          results.push({
            clipIndex: clip.clipIndex,
            status: 'failed',
            imagePrompt: item.imagePrompt,
            endImagePrompt: item.endImagePrompt,
            visualPrompt: clip.visualPrompt,
            transition,
            transitionNote: clip.transitionNote,
            error: err.message,
          });
          failed++;
          console.warn(pc.yellow(`[flow-ext] Stopping batch run due to clip failure: ${err.message}`));
          break;
        }
      }

      if (!clip.imageUrl && !clip.localImagePath) {
        console.warn(pc.yellow(`[flow-ext] ${item.label}: no start image recorded — cannot proceed to video`));
        continue;
      }

      // ── Step 3/3: Frames mode video (select Start and End frame buttons, NO right-click animate) ──
      // Degenerate Frames input guard: identical image CONTENT in both slots yields
      // a static or backend-deduped video (observed: run viral-1791900784598-797ux0).
      // Tile KEYS are unreliable on the recycled virtualized canvas — they may be
      // stale while the content differs — so the hard check is content-hash based.
      const startFrameHash = clip.localImagePath ? await hashMediaFile(clip.localImagePath) : null;
      const endFrameHash = clip.localEndImagePath ? await hashMediaFile(clip.localEndImagePath) : null;
      if (startFrameHash && endFrameHash && startFrameHash === endFrameHash) {
        const msg = `${item.label}: start and end keyframes are the same image content — refusing to submit a degenerate Frames video`;
        console.error(pc.red(`✗ ${msg}`));
        clip.status = 'failed';
        clip.error = msg;
        await persistScript();
        results.push({
          clipIndex: clip.clipIndex,
          status: 'failed',
          imagePrompt: item.imagePrompt,
          imageUrl: clip.imageUrl,
          localImagePath: clip.localImagePath,
          endImagePrompt: item.endImagePrompt,
          endImageUrl: clip.endImageUrl,
          localEndImagePath: clip.localEndImagePath,
          visualPrompt: clip.visualPrompt,
          transition,
          transitionNote: clip.transitionNote,
          error: msg,
        });
        failed++;
        console.warn(pc.yellow(`[flow-ext] Stopping batch run due to clip failure: ${msg}`));
        break;
      }
      if (clip.imageTileKey && clip.imageTileKey === clip.endImageTileKey) {
        console.warn(
          pc.yellow(
            `[flow-ext] ⚠ ${item.label}: start/end tile keys are identical (${clip.imageTileKey}) but keyframe content differs — ` +
              `the canvas recycled a stale tile key; proceeding with content-verified frames.`
          )
        );
      }

      try {
        const video = await this.generateFramesVideo({
          label: item.label,
          startImage: {
            prompt: item.imagePrompt,
            mediaKey: clip.imageTileKey ?? null,
          },
          endImage: {
            prompt: item.endImagePrompt,
            mediaKey: clip.endImageTileKey ?? null,
          },
          visualPrompt: clip.visualPrompt,
          duration: (clip.durationSec as number) || 4,
          outputPath: item.clipVideo,
          projectId: rawOptions.projectId,
          aspect: clipAspect as 'landscape' | 'portrait',
          profileDir: rawOptions.profileDir,
        });

        if (video.downloadError) {
          clip.status = 'failed';
          clip.videoUrl = video.videoUrl;
          clip.error = `video generated (${video.videoUrl}) but download failed: ${video.downloadError}`;
          delete clip.localVideoPath;
          await persistScript();
          results.push({
            clipIndex: clip.clipIndex,
            status: 'failed',
            imagePrompt: item.imagePrompt,
            imageUrl: clip.imageUrl,
            localImagePath: clip.localImagePath,
            endImagePrompt: item.endImagePrompt,
            endImageUrl: clip.endImageUrl,
            localEndImagePath: clip.localEndImagePath,
            visualPrompt: clip.visualPrompt,
            transition,
            transitionNote: clip.transitionNote,
            videoUrl: video.videoUrl,
            error: clip.error,
          });
          failed++;
          console.warn(pc.yellow(`[flow-ext] Stopping batch run due to clip failure: ${clip.error}`));
          break;
        }

        const duplicateError = await rejectDuplicateClip(item, video);
        if (duplicateError) {
          clip.status = 'failed';
          clip.videoUrl = video.videoUrl;
          clip.error = duplicateError;
          delete clip.localVideoPath;
          await persistScript();
          results.push({
            clipIndex: clip.clipIndex,
            status: 'failed',
            imagePrompt: item.imagePrompt,
            imageUrl: clip.imageUrl,
            localImagePath: clip.localImagePath,
            endImagePrompt: item.endImagePrompt,
            endImageUrl: clip.endImageUrl,
            localEndImagePath: clip.localEndImagePath,
            visualPrompt: clip.visualPrompt,
            transition,
            transitionNote: clip.transitionNote,
            videoUrl: video.videoUrl,
            error: duplicateError,
          });
          failed++;
          console.warn(pc.yellow(`[flow-ext] Stopping batch run due to clip failure: ${duplicateError}`));
          break;
        }

        clip.status = 'completed';
        clip.videoUrl = video.videoUrl;
        clip.localVideoPath = video.outputPath ?? undefined;
        delete clip.error;
        await persistScript();
        results.push({
          clipIndex: clip.clipIndex,
          status: 'completed',
          imagePrompt: item.imagePrompt,
          imageUrl: clip.imageUrl,
          localImagePath: clip.localImagePath,
          endImagePrompt: item.endImagePrompt,
          endImageUrl: clip.endImageUrl,
          localEndImagePath: clip.localEndImagePath,
          visualPrompt: clip.visualPrompt,
          transition,
          transitionNote: clip.transitionNote,
          videoUrl: video.videoUrl,
          outputPath: video.outputPath ?? undefined,
        });
        completed++;
        if (video.quota?.actualCredits !== undefined) latestCredits = video.quota.actualCredits;
      } catch (err: any) {
        console.error(pc.red(`✗ ${item.label} Frames video failed: ${err.message}`));
        clip.status = 'failed';
        clip.error = err.message;
        await persistScript();
        results.push({
          clipIndex: clip.clipIndex,
          status: 'failed',
          imagePrompt: item.imagePrompt,
          imageUrl: clip.imageUrl,
          localImagePath: clip.localImagePath,
          endImagePrompt: item.endImagePrompt,
          endImageUrl: clip.endImageUrl,
          localEndImagePath: clip.localEndImagePath,
          visualPrompt: clip.visualPrompt,
          transition,
          transitionNote: clip.transitionNote,
          error: err.message,
        });
        failed++;
        console.warn(pc.yellow(`[flow-ext] Stopping batch run due to clip failure: ${err.message}`));
        break;
      }

      // Candidate for reference
      previousImageKey = clip.endImageTileKey ?? clip.imageTileKey ?? null;
      if (clip.localVideoPath) previousVideo = { clipIndex: clip.clipIndex, path: clip.localVideoPath };
      if (clip.localVideoPath) previousVideo = { clipIndex: clip.clipIndex, path: clip.localVideoPath };
    }

    return {
      totalClips: eligible.length,
      completedClips: completed,
      failedClips: failed,
      skippedClips: 0,
      outDir,
      finalCredits: latestCredits,
      results,
    };
  }

  /**
   * Waits for the Frames-mode Start/End triggers to mount in the prompt box.
   */
  private async waitForFramesControls(bridge: NativeBridge, label: string, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await bridge
        .request({
          type: 'evaluate',
          code: `document.querySelectorAll('.frame-trigger').length > 0`,
        })
        .catch(() => null);
      if (res?.result === true) return;
      await sleep(400);
    }
    throw new Error(`${label}: video mode controls did not render (.frame-trigger missing after settings)`);
  }

  /**
   * Download a URL to a local file.
   */
  private async downloadUrl(url: string, outputPath: string): Promise<void> {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        Accept: '*/*',
        Referer: 'https://flow.google.com/',
      },
    });

    if (!response.ok) {
      throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 100) {
      throw new Error(`Downloaded file is too small (${buffer.length} bytes)`);
    }

    const resolved = path.resolve(outputPath);
    await mkdir(path.dirname(resolved), { recursive: true });
    const tmp = `${resolved}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, buffer, { mode: 0o600 });
    await rename(tmp, resolved);
  }

  /**
   * Scroll to the bottom of the page to load all dynamic content (e.g. projects, cards).
   */
  async scrollToBottom(bridge?: NativeBridge): Promise<void> {
    const b = bridge || this.session?.bridge;
    if (!b) return;
    try {
      console.log(pc.cyan(`[flow-ext] Scrolling to the bottom of flow.google.com...`));
      await b.scrollToBottom();
      await sleep(1000); // Allow lazy content to finish rendering
    } catch (err: any) {
      console.warn(pc.yellow(`[flow-ext] Scroll to bottom warning: ${err.message}`));
    }
  }

  /**
   * Release the session (keep browser running).
   */
  async release(): Promise<void> {
    if (this.session) {
      this.session.bridge.disconnect();
      this.session = null;
    }
  }

  /**
   * Exits the running Chromium browser process and cleans up session.
   */
  async close(options?: { profileDir?: string }): Promise<void> {
    if (this.session) {
      await this.session.close().catch(() => {});
      this.session = null;
    }
    if (options?.profileDir) {
      await closeBrowserSession({ profileDir: options.profileDir }).catch(() => {});
    }
  }
}
