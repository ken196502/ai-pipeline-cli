/**
 * Project lifecycle, page orchestration, and quota checking for FlowClient.
 */
import path from 'node:path';
import pc from 'picocolors';
import type { Page } from 'playwright-core';
import { launchBrowser, releaseBrowser } from '../../browser/index.js';
import { attemptGoogleAutoSignIn } from '../../browser/login-helper.js';
import { FLOW_HOME_URL } from '../config.js';
import type { FlowProject, FlowProjectItem, QuotaSnapshot } from '../contracts.js';
import {
  createNewProject,
  dismissCookieBanner,
  extractProjectId,
  hasSignInPrompt,
  isProjectNotFound,
  readActualFlowCredits,
  scrollToDisplayAllProjects,
  tryEnterWorkspaceFromAbout,
  waitForCanvasIdle,
  withRiskControlRetry,
} from '../dom.js';
import { buildCreditSnapshot } from '../quota.js';
import type { ClientContext } from './types.js';
import { randomDelay, sleepWithLog } from './utils.js';

/**
 * Reads the live credit balance from flow.google.com (top-right avatar panel).
 * The real balance is the ONLY quota — reading it must succeed.
 */
export async function checkQuota(
  ctx: ClientContext,
  options?: {
    profileDir?: string;
    headed?: boolean;
    viewport?: { width: number; height: number } | null;
  }
): Promise<QuotaSnapshot> {
  const profileDir = options?.profileDir ? path.resolve(options.profileDir) : ctx.config.profileDir;

  const { browser, page } = await launchBrowser({
    profileDir,
    headless: options?.headed !== undefined ? !options.headed : false,
    url: FLOW_HOME_URL,
    stealth: false,
    keepAlive: true,
    reuseSession: true,
    viewport: options?.viewport,
  });

  try {
    if (!page.url().includes('flow.google.com')) {
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {});
    }

    if (await hasSignInPrompt(page)) {
      throw new Error('Not signed in to Google Flow. Run "flow-cli login" first to authenticate.');
    }

    const actualCredits = await readActualFlowCredits(page);
    return buildCreditSnapshot({ actualCredits });
  } finally {
    await releaseBrowser(browser, { keepAlive: true, profileDir });
  }
}

/**
 * Opens or creates a Flow project.
 */
export async function checkOrCreateProject(
  ctx: ClientContext,
  requestedProjectId?: string,
  options?: {
    profileDir?: string;
    headed?: boolean;
    viewport?: { width: number; height: number } | null;
  }
): Promise<FlowProject> {
  const profileDir = options?.profileDir ? path.resolve(options.profileDir) : ctx.config.profileDir;
  const targetUrl = requestedProjectId
    ? `${FLOW_HOME_URL}/project/${requestedProjectId}`
    : FLOW_HOME_URL;

  const { browser, page } = await launchBrowser({
    profileDir,
    headless: options?.headed !== undefined ? !options.headed : false,
    url: targetUrl,
    stealth: false,
    keepAlive: true,
    reuseSession: true,
    viewport: options?.viewport,
  });

  try {
    if (!requestedProjectId && page.url().includes('/project/')) {
      // Reused browser session was left on a project page; return home to create a fresh project
      await page.goto(FLOW_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
    }

    if (!page.url().includes('flow.google.com')) {
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
    }

    if (await hasSignInPrompt(page)) {
      console.log(pc.yellow(`[flow-cli] Sign-in prompt detected on Flow home — attempting automated sign-in...`));
      await attemptGoogleAutoSignIn(page).catch(() => {});
      await dismissCookieBanner(page).catch(() => {});
      if (page.url().includes('/about')) {
        await tryEnterWorkspaceFromAbout(page).catch(() => {});
      }
      if (await hasSignInPrompt(page)) {
        throw new Error('Not signed in to Google Flow. Run "flow-cli login" first to authenticate.');
      }
    }

    const wantedProjectId = requestedProjectId;
    let projectId = wantedProjectId ? extractProjectId(page.url()) : undefined;

    if (wantedProjectId && (await isProjectNotFound(page))) {
      // A dead project URL would waste the whole generation stage on a 404 page.
      console.warn(
        pc.yellow(
          `[flow-cli] Project ${wantedProjectId} was not found on flow.google.com (deleted?) — creating a new project instead.`
        )
      );
      await createNewProject(page, 30_000, { homeUrl: FLOW_HOME_URL });
      projectId = extractProjectId(page.url());
    }

    if (!projectId) {
      // Scroll to the very bottom of flow.google.com to display all projects
      const displayedProjects = await scrollToDisplayAllProjects(page).catch((err: any) => {
        if (err?.message?.includes('session expired') || err?.message?.includes('401') || err?.message?.includes('403')) {
          throw err;
        }
        return [];
      });

      if (wantedProjectId) {
        const matched = displayedProjects.find(
          (p) => p.projectId.toLowerCase() === wantedProjectId.toLowerCase()
        );
        if (matched) {
          await page.goto(matched.url, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
          projectId = extractProjectId(page.url()) || matched.projectId;
        }
      }

      if (!projectId) {
        const created = await createNewProject(page, 30_000, { homeUrl: FLOW_HOME_URL });
        projectId = extractProjectId(page.url()) ?? undefined;
        if (!projectId && !created) {
          throw new Error(`Failed to create or open a Google Flow project. Current URL: ${page.url()}`);
        }
      }
    }

    if (!projectId) {
      throw new Error(`Google Flow project could not be allocated. Current URL: ${page.url()}`);
    }

    const finalUrl = page.url();
    return {
      projectId,
      url: finalUrl,
    };
  } finally {
    await releaseBrowser(browser, { keepAlive: true, profileDir });
  }
}

/**
 * Opens flow.google.com via CDP, scrolls to the very bottom to display all projects,
 * and returns the full list of discovered projects.
 */
export async function listProjects(
  ctx: ClientContext,
  options?: {
    profileDir?: string;
    headed?: boolean;
    maxScrolls?: number;
    viewport?: { width: number; height: number } | null;
  }
): Promise<FlowProjectItem[]> {
  const profileDir = options?.profileDir ? path.resolve(options.profileDir) : ctx.config.profileDir;

  const { browser, page } = await launchBrowser({
    profileDir,
    headless: options?.headed !== undefined ? !options.headed : false,
    url: FLOW_HOME_URL,
    stealth: false,
    keepAlive: true,
    reuseSession: true,
    viewport: options?.viewport,
  });

  try {
    if (!page.url().includes('flow.google.com')) {
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
    }

    if (await hasSignInPrompt(page)) {
      throw new Error('Not signed in to Google Flow. Run "flow-cli login" first to authenticate.');
    }

    return await scrollToDisplayAllProjects(page, {
      maxScrolls: options?.maxScrolls,
    });
  } finally {
    await releaseBrowser(browser, { keepAlive: true, profileDir });
  }
}

/**
 * Ensures a live browser page on a Flow project and runs `fn` with it.
 * The browser session is kept alive between calls so two-phase batch runs
 * (all images first, then all animations) share one canvas.
 */
export async function withProjectPage<T>(
  ctx: ClientContext,
  options: {
    projectId?: string;
    headed?: boolean;
    viewport?: { width: number; height: number } | null;
    profileDir?: string;
    dataDir?: string;
    /**
     * When set, `fn` runs under the risk-control retry loop: rejected attempts
     * refresh to clear the stale "unusual activity" tile, then re-run
     * the click input box → Ctrl+V → Enter gesture (see
     * plan-fix-risk-control-refresh-retry.md).
     */
    riskRetryLabel?: string;
  },
  fn: (callCtx: { page: Page; projectId: string }) => Promise<T>
): Promise<T> {
  const profileDir = options.profileDir ? path.resolve(options.profileDir) : ctx.config.profileDir;
  const targetUrl = options.projectId ? `${FLOW_HOME_URL}/project/${options.projectId}` : FLOW_HOME_URL;

  const { browser, page } = await launchBrowser({
    profileDir,
    headless: options.headed !== undefined ? !options.headed : false,
    url: targetUrl,
    stealth: false,
    keepAlive: true,
    reuseSession: true,
    viewport: options.viewport,
  });

  try {
    if (!page.url().includes('flow.google.com')) {
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
    }

    if (await hasSignInPrompt(page)) {
      console.log(pc.yellow(`[flow-cli] Sign-in prompt detected on Flow project page — attempting automated sign-in...`));
      await attemptGoogleAutoSignIn(page).catch(() => {});
      await dismissCookieBanner(page).catch(() => {});
      if (page.url().includes('/about')) {
        await tryEnterWorkspaceFromAbout(page).catch(() => {});
      }
      if (await hasSignInPrompt(page)) {
        throw new Error('Not signed in to Google Flow. Run "flow-cli login" first to authenticate.');
      }
    }

    if (options.projectId && (await isProjectNotFound(page))) {
      throw new Error(
        `Google Flow project not found: ${options.projectId}. ` +
          `The project may have been deleted — pass a valid project id or omit it to create a new project.`
      );
    }

    let projectId = extractProjectId(page.url());
    if (!projectId) {
      await scrollToDisplayAllProjects(page).catch(() => []);
      console.log(pc.gray(`Creating new Flow project...`));
      const created = await createNewProject(page, 30_000, { homeUrl: FLOW_HOME_URL });
      projectId = extractProjectId(page.url());
      if (!projectId) {
        throw new Error(`Google Flow project could not be created or loaded (URL: ${page.url()}). Ensure Flow authentication is active.`);
      }
    }

    await dismissCookieBanner(page).catch(() => {});

    return await withRiskControlRetry(
      page,
      { label: options.riskRetryLabel ?? `flow-${projectId || 'project'}`, refreshFirstAttempt: false },
      async () => fn({ page, projectId: projectId || options.projectId || '' })
    );
  } finally {
    await releaseBrowser(browser, { keepAlive: true, profileDir });
  }
}

/**
 * Progress-driven inter-step pacing (replaces the old fixed 75-150s cooldown).
 * Waits until the Flow canvas reports NO in-progress generation — i.e. the
 * previous step's image/video is truly settled — then applies a short human
 * settle. Pure DOM observation; no clicks, no reloads, no prompt interaction.
 * A failed idle check never blocks the batch: the next step re-verifies the
 * page itself and its risk-control retry reports real failures.
 */
export async function paceByGenerationProgress(
  ctx: ClientContext,
  label: string,
  options: {
    projectId?: string;
    headed?: boolean;
    viewport?: { width: number; height: number } | null;
    profileDir?: string;
    dataDir?: string;
  }
): Promise<void> {
  if (!options.projectId) {
    console.log(pc.gray(`[flow-cli] No project id — skipping generation-progress pacing before ${label}`));
  } else {
    try {
      await withProjectPage(
        ctx,
        { ...options, riskRetryLabel: `generation-progress pacing before ${label}` },
        async ({ page }) => {
          await waitForCanvasIdle(page, { label: `pacing before ${label}` });
        }
      );
    } catch (e: any) {
      console.warn(
        pc.yellow(`[flow-cli] Generation-progress pacing before ${label} could not run: ${e.message}`)
      );
    }
  }
  await sleepWithLog(randomDelay(2, 5), `Human settle before ${label}`);
}
