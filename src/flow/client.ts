/**
 * Flow Client: Orchestrates Browser Automation, Project Management,
 * Prompt Submission, Queue Monitoring, and Video Downloads for Google Flow.
 */
import path from 'node:path';
import type { Page } from 'playwright-core';
import { closeBrowserSession } from '../browser/index.js';
import type { RunContext } from '../run/index.js';
import { getFlowConfig } from './config.js';
import {
  type BatchOptions,
  type BatchResult,
  type FlowProject,
  type FlowProjectItem,
  type GenerateImageOptions,
  type GenerateImageResult,
  type GenerateOptions,
  type GenerationResult,
  type QuotaSnapshot,
} from './contracts.js';

// Submodules
import { login as runLogin } from './client/auth.js';
import {
  checkOrCreateProject as runCheckOrCreateProject,
  checkQuota as runCheckQuota,
  listProjects as runListProjects,
  paceByGenerationProgress as runPaceByGenerationProgress,
  withProjectPage as runWithProjectPage,
} from './client/project.js';
import { generateClipImage as runGenerateClipImage } from './client/clip-image.js';
import { animateClipImage as runAnimateClipImage } from './client/clip-animate.js';
import { generateContinuationVideo as runGenerateContinuationVideo } from './client/clip-continuation.js';
import { generateFramesVideo as runGenerateFramesVideo } from './client/clip-frames.js';
import { generateImage as runGenerateImage, generateVideo as runGenerateVideo } from './client/single.js';
import { batchGenerate as runBatchGenerate } from './client/batch.js';
import type { ClientContext, ClipImageResult } from './client/types.js';

export { isAntiAbuseError } from './client/utils.js';

export class FlowClient {
  private readonly config = getFlowConfig();
  private readonly ctx: ClientContext = { config: this.config };

  /**
   * Interactive login session to establish Google authentication cookies.
   */
  async login(options?: {
    profileDir?: string;
    headed?: boolean;
    viewport?: { width: number; height: number } | null;
  }): Promise<{ loggedIn: boolean }> {
    return runLogin(this.ctx, options);
  }

  /**
   * Reads the live credit balance from flow.google.com (top-right avatar panel).
   * The real balance is the ONLY quota — reading it must succeed.
   */
  async checkQuota(options?: {
    profileDir?: string;
    headed?: boolean;
    viewport?: { width: number; height: number } | null;
  }): Promise<QuotaSnapshot> {
    return runCheckQuota(this.ctx, options);
  }

  /**
   * Opens or creates a Flow project.
   */
  async checkOrCreateProject(
    requestedProjectId?: string,
    options?: {
      profileDir?: string;
      headed?: boolean;
      viewport?: { width: number; height: number } | null;
    }
  ): Promise<FlowProject> {
    return runCheckOrCreateProject(this.ctx, requestedProjectId, options);
  }

  /**
   * Opens flow.google.com via CDP, scrolls to the very bottom to display all projects,
   * and returns the full list of discovered projects.
   */
  async listProjects(options?: {
    profileDir?: string;
    headed?: boolean;
    maxScrolls?: number;
    viewport?: { width: number; height: number } | null;
  }): Promise<FlowProjectItem[]> {
    return runListProjects(this.ctx, options);
  }

  /**
   * Ensures a live browser page on a Flow project and runs `fn` with it.
   * The browser session is kept alive between calls so two-phase batch runs
   * (all images first, then all animations) share one canvas.
   */
  private async withProjectPage<T>(
    options: {
      projectId?: string;
      headed?: boolean;
      viewport?: { width: number; height: number } | null;
      profileDir?: string;
      dataDir?: string;
      riskRetryLabel?: string;
    },
    fn: (callCtx: { page: Page; projectId: string }) => Promise<T>
  ): Promise<T> {
    return runWithProjectPage(this.ctx, options, fn);
  }

  /**
   * Progress-driven inter-step pacing (replaces the old fixed 75-150s cooldown).
   */
  private async paceByGenerationProgress(
    label: string,
    options: {
      projectId?: string;
      headed?: boolean;
      viewport?: { width: number; height: number } | null;
      profileDir?: string;
      dataDir?: string;
    }
  ): Promise<void> {
    return runPaceByGenerationProgress(this.ctx, label, options);
  }

  /**
   * PHASE 1 step — generate one keyframe image card on the Flow canvas.
   */
  private async generateClipImage(opts: {
    label: string;
    imagePrompt: string;
    imageOutputPath?: string;
    projectId?: string;
    aspect: 'landscape' | 'portrait';
    model?: string;
    headed?: boolean;
    viewport?: { width: number; height: number } | null;
    profileDir?: string;
    dataDir?: string;
    timeoutMs?: number;
    referencePreviousImage?: boolean;
    referenceKey?: string | null;
    referenceSrc?: string | null;
    referenceMode?: 'required' | 'optional';
    excludeKeys?: Array<string | null | undefined> | Set<string>;
  }): Promise<ClipImageResult> {
    return runGenerateClipImage(this.ctx, opts);
  }

  /**
   * PHASE 2 step — right-click ONE specific image card → "Animate" → video prompt → MP4 synthesis.
   */
  private async animateClipImage(opts: {
    label: string;
    mediaKey: string | null;
    mediaSrc?: string | null;
    visualPrompt: string;
    duration: 4 | 6 | 8 | 10;
    outputPath?: string;
    projectId?: string;
    aspect: 'landscape' | 'portrait';
    model?: string;
    headed?: boolean;
    viewport?: { width: number; height: number } | null;
    profileDir?: string;
    dataDir?: string;
    timeoutMs?: number;
    knownVideoUrls?: string[];
  }): Promise<{ videoUrl: string; outputPath: string | null; downloadError?: string | null; quota: QuotaSnapshot; projectId: string }> {
    return runAnimateClipImage(this.ctx, opts);
  }

  /**
   * 连续 (continuous, non-cut) step — continue the SAME shot WITHOUT generating an image.
   */
  private async generateContinuationVideo(opts: {
    label: string;
    startFrameSourceVideo: string;
    startFramePath: string;
    visualPrompt: string;
    duration: 4 | 6 | 8 | 10;
    outputPath?: string;
    projectId?: string;
    aspect: 'landscape' | 'portrait';
    model?: string;
    headed?: boolean;
    viewport?: { width: number; height: number } | null;
    profileDir?: string;
    dataDir?: string;
    timeoutMs?: number;
    knownVideoUrls?: string[];
  }): Promise<{
    videoUrl: string;
    outputPath: string | null;
    downloadError?: string | null;
    startFramePath: string;
    quota: QuotaSnapshot;
    projectId: string;
  }> {
    return runGenerateContinuationVideo(this.ctx, opts);
  }

  /**
   * 切分镜/cut step: generate video using Frames mode (Start Frame + End Frame).
   */
  private async generateFramesVideo(opts: {
    label: string;
    startImage: { prompt: string; mediaKey: string | null };
    endImage: { prompt: string; mediaKey: string | null };
    visualPrompt: string;
    duration: 4 | 6 | 8 | 10;
    outputPath?: string;
    projectId?: string;
    aspect: 'landscape' | 'portrait';
    model?: string;
    headed?: boolean;
    viewport?: { width: number; height: number } | null;
    profileDir?: string;
    dataDir?: string;
    timeoutMs?: number;
    knownVideoUrls?: string[];
  }): Promise<{
    videoUrl: string;
    outputPath: string | null;
    downloadError?: string | null;
    quota: QuotaSnapshot;
    projectId: string;
  }> {
    return runGenerateFramesVideo(this.ctx, opts);
  }

  /**
   * Generates a video from a prompt on Google Flow (single-clip convenience wrapper
   * around the two-phase steps: keyframe image → Animate → video).
   */
  async generateVideo(rawOptions: GenerateOptions): Promise<GenerationResult> {
    return runGenerateVideo(this.ctx, rawOptions);
  }

  /**
   * Generates an image from a text prompt on Google Flow.
   * Returns the generated image URL and optional local download path.
   */
  async generateImage(rawOptions: GenerateImageOptions): Promise<GenerateImageResult> {
    return runGenerateImage(this.ctx, rawOptions);
  }

  /**
   * Iterates through a Flow video script and generates pending clips sequentially in
   * an ALTERNATING rhythm.
   */
  async batchGenerate(rawOptions: BatchOptions, run?: RunContext): Promise<BatchResult> {
    return runBatchGenerate(this.ctx, rawOptions, run);
  }

  /**
   * Exits the running Chromium browser process completely and cleans up session metadata.
   */
  async close(options?: { profileDir?: string }): Promise<void> {
    const profileDir = options?.profileDir ? path.resolve(options.profileDir) : this.config.profileDir;
    await closeBrowserSession({ profileDir });
  }
}
