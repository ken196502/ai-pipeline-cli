/**
 * Shared pipeline stage utilities.
 *
 * Extracted from orchestrator.ts to break the circular dependency:
 *   orchestrator → registry → pipelines/* → orchestrator
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveChromiumPath } from '../../browser/installer.js';
import { refreshCookiesViaBrowser } from '../../browser.js';
import { saveCookiesToFile } from '../../cookie-formatter.js';
import { getEnvConfig } from '../../utils/env.js';
import { verifyEnvConfigWithCurl, printEnvVerification, maskApiKey } from '../../libs/llm/verify.js';
import type { EvaluationStandard } from '../../research/contracts.js';
import { verifyStandardHash } from '../../research/evaluation/standard.js';
import {
  type RunLogger,
  ensureProfileDir,
  checkProfileReady,
} from '../../utils/index.js';
import { verifyCookies } from '../../utils/cookies.js';
import { ensureYtDlp } from '../../utils/ytdlp.js';
import { resolveFfmpegBin } from '../../research/youtube/ytdlp.js';
import { notifyLlmUnavailableAndExit } from '../../utils/send_msg.js';
import {
  assertFlowCreditsThreshold,
} from '../../flow/quota.js';
import { getFlowReservedCredits } from '../../flow/config.js';
import { getPipelineStorage } from './storage.js';

export interface EnvCheckSummary {
  flowCreditsRecorded?: number;
  flowReservedCredits?: number;
  llmConfigured: boolean;
  llmEndpoint?: string;
  llmModel?: string;
  chromiumInstalled: boolean;
  chromiumPath?: string;
  chromiumVersion?: string;
  ytDlpInstalled: boolean;
  ytDlpPath?: string;
  ffmpegInstalled: boolean;
  flowProfileExists: boolean;
  profileDir: string;
}

export interface YtbCheckSummary {
  cookieFileExists: boolean;
  valid: boolean;
  stage: string;
  refreshedViaBrowser: boolean;
  cookiePath: string;
  foundAuthTokens?: string[];
  missingAuthTokens?: string[];
  expiredTokens?: string[];
}

const execFileAsync = promisify(execFile);

/**
 * Normalizes any topic or query into a filesystem-safe slug for standard reuse.
 */
export function slugifyTopic(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 64);
}

/**
 * Stage 1: check-env
 * Verifies LLM credentials, Ungoogled Chromium binary, yt-dlp executable,
 * ffmpeg availability, and the persistent Chromium profile directory.
 */
export async function checkEnvStage(
  options: { profileDir?: string; storageDir?: string; pipelineId?: string },
  logger?: RunLogger
): Promise<EnvCheckSummary> {
  // 0. Flow Credit Threshold Pre-Check (first step of every run)
  const reservedThreshold = getFlowReservedCredits();
  const pipelineId = options.pipelineId || 'viral-video-maker';
  const storage = getPipelineStorage(pipelineId, options.storageDir);
  const flowCredits = await storage.getFlowCredits();

  if (flowCredits !== null) {
    logger?.info(
      `Stage 1: Verified [${pipelineId}] local Flow credit record: ${flowCredits.actualCredits} credits (reserved threshold: ${reservedThreshold})`
    );
  } else if (reservedThreshold > 0) {
    logger?.warn(
      `Stage 1: No [${pipelineId}] local Flow credit record found in ${storage.getConfigPath()} (reserved threshold: ${reservedThreshold})`
    );
  }

  // Abort immediately if the locally recorded credits are below the threshold
  assertFlowCreditsThreshold(flowCredits?.actualCredits, reservedThreshold, pipelineId);

  const profileDir = await ensureProfileDir(options.profileDir);
  const envConfig = getEnvConfig();

  // 1. LLM Verification via curl (mandatory — pipeline cannot proceed without working LLM)
  logger?.info('Stage 1: Verifying LLM gateway connectivity via curl...');
  const llmResult = await verifyEnvConfigWithCurl(envConfig);
  printEnvVerification(envConfig, llmResult);

  if (!llmResult.valid) {
    const errorMsg =
      `LLM gateway check failed: ${llmResult.reason}\n` +
      `  Base URL: ${envConfig.baseUrl}\n` +
      `  API Key:  ${maskApiKey(envConfig.apiKey)}\n` +
      `Pipeline cannot proceed without a working LLM endpoint. Fix your .env configuration.`;
    await notifyLlmUnavailableAndExit(new Error(errorMsg), {
      stage: 'check-env',
      task: 'verify-llm',
      context: 'Environment Pre-check',
    });
  }
  const llmConfigured = true;

  // 2. Chromium verification
  let chromiumInstalled = false;
  let chromiumPath: string | undefined;
  let chromiumVersion: string | undefined;
  try {
    chromiumPath = await resolveChromiumPath();
    chromiumInstalled = true;
    if (chromiumPath) {
      try {
        const { stdout } = await execFileAsync(chromiumPath, ['--version']);
        chromiumVersion = stdout.trim();
      } catch {
        chromiumVersion = 'Available (custom build)';
      }
    }
  } catch {
    chromiumInstalled = false;
  }

  // 3. yt-dlp verification
  let ytDlpInstalled = false;
  let ytDlpPath: string | undefined;
  try {
    ytDlpPath = await ensureYtDlp();
    ytDlpInstalled = true;
  } catch {
    ytDlpInstalled = false;
  }

  // 4. ffmpeg verification
  let ffmpegInstalled = false;
  try {
    const ffmpegBin = resolveFfmpegBin();
    await execFileAsync(ffmpegBin, ['-version']);
    ffmpegInstalled = true;
  } catch {
    ffmpegInstalled = false;
  }

  // 5. Flow/YouTube persistent profile check
  let flowProfileExists = false;
  try {
    const profileCheck = await checkProfileReady(profileDir);
    flowProfileExists = profileCheck.exists;
  } catch {
    flowProfileExists = false;
  }

  const summary: EnvCheckSummary = {
    flowCreditsRecorded: flowCredits?.actualCredits,
    flowReservedCredits: reservedThreshold,
    llmConfigured,
    llmEndpoint: envConfig.baseUrl,
    llmModel: envConfig.llmModel,
    chromiumInstalled,
    chromiumPath,
    chromiumVersion,
    ytDlpInstalled,
    ytDlpPath,
    ffmpegInstalled,
    flowProfileExists,
    profileDir,
  };

  logger?.info('Environment check completed', summary as unknown as Record<string, unknown>);
  return summary;
}

/**
 * Stage 2: check-ytb
 * Validates YouTube Netscape cookies statically and dynamically via live yt-dlp verification.
 */
export async function checkYtbStage(
  cookiePath: string,
  options?: { skipLiveTest?: boolean; testUrl?: string; proxyUrl?: string },
  logger?: RunLogger
): Promise<YtbCheckSummary> {
  const resolvedCookiePath = path.resolve(cookiePath);
  let cookieFileExists = false;

  try {
    const stat = await fs.stat(resolvedCookiePath);
    cookieFileExists = stat.size > 0;
  } catch {
    cookieFileExists = false;
  }

  if (!cookieFileExists) {
    return {
      cookieFileExists: false,
      valid: false,
      stage: 'file_check',
      refreshedViaBrowser: false,
      cookiePath: resolvedCookiePath,
      missingAuthTokens: ['LOGIN_INFO', 'SAPISID'],
    };
  }

  const verification = await verifyCookies(resolvedCookiePath, {
    skipLiveTest: options?.skipLiveTest,
    testUrl: options?.testUrl,
    proxyUrl: options?.proxyUrl,
  });

  const summary: YtbCheckSummary = {
    cookieFileExists: true,
    valid: verification.valid,
    stage: verification.stage,
    refreshedViaBrowser: false,
    cookiePath: resolvedCookiePath,
    foundAuthTokens: verification.foundAuthTokens,
    missingAuthTokens: verification.missingAuthTokens,
    expiredTokens: verification.expiredTokens,
  };

  logger?.info('YouTube cookie verification completed', summary as unknown as Record<string, unknown>);
  return summary;
}

/**
 * Stage 3: use browser if needed
 * Launches Ungoogled Chromium with persistent ./.chromium-profile to refresh YouTube cookies.
 */
export async function refreshYtbCookiesIfNeeded(
  cookiePath: string,
  profileDir: string,
  browserPath?: string,
  logger?: RunLogger,
  viewport?: { width: number; height: number } | null
): Promise<YtbCheckSummary> {
  const resolvedCookiePath = path.resolve(cookiePath);
  const resolvedProfileDir = path.resolve(profileDir);

  logger?.info('Launching Ungoogled Chromium with persistent profile to refresh YouTube cookies', {
    cookiePath: resolvedCookiePath,
    profileDir: resolvedProfileDir,
    viewport: viewport ?? 'auto-detect',
  });

  const cookies = await refreshCookiesViaBrowser({
    profileDir: resolvedProfileDir,
    executablePath: browserPath,
    url: 'https://www.youtube.com',
    viewport,
  });

  await saveCookiesToFile(resolvedCookiePath, cookies);

  // Re-verify after browser export
  const recheck = await verifyCookies(resolvedCookiePath, { skipLiveTest: false });

  const summary: YtbCheckSummary = {
    cookieFileExists: true,
    valid: recheck.valid,
    stage: recheck.stage,
    refreshedViaBrowser: true,
    cookiePath: resolvedCookiePath,
    foundAuthTokens: recheck.foundAuthTokens,
    missingAuthTokens: recheck.missingAuthTokens,
    expiredTokens: recheck.expiredTokens,
  };

  logger?.info('Cookie browser refresh finished', summary as unknown as Record<string, unknown>);
  return summary;
}

/**
 * Stage 5: gen evaluation standard if needed & Standard Reuse Resolution
 * Inspects options.standardPath and reusable standardsDir for an existing standard with valid SHA-256 hash.
 */
export async function resolveReusableStandard(
  topicSlug: string,
  options: {
    standardPath?: string;
    standardsDir?: string;
    fallbackStandardsDir?: string;
    reuseStandard?: boolean;
    forceNewStandard?: boolean;
    removeExistingStandard?: boolean;
    removeStandard?: boolean;
    removeAllStandards?: boolean;
  },
  logger?: RunLogger
): Promise<{
  standard?: EvaluationStandard;
  reused: boolean;
  sourcePath?: string;
  targetSavePath: string;
  removedPaths?: string[];
}> {
  const standardsDir = path.resolve(
    options.standardsDir || path.join(process.env.PIPELINE_STORAGE_DIR || './storage', 'standards')
  );
  const candidateSavePaths = [
    path.join(standardsDir, `${topicSlug}.json`),
    path.join(standardsDir, `${topicSlug}-standard.json`),
  ];
  const targetSavePath = candidateSavePaths[0];

  // If removeAllStandards is requested, purge all json standards in the directory
  if (options.removeAllStandards) {
    const removedPaths: string[] = [];
    try {
      const files = await fs.readdir(standardsDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(standardsDir, file);
          await fs.rm(filePath, { force: true });
          removedPaths.push(filePath);
          logger?.info('Removed evaluation standard file from directory', { path: filePath });
        }
      }
    } catch (err: any) {
      logger?.warn(`Failed to read standards directory ${standardsDir}: ${err.message}`);
    }
    if (options.standardPath) {
      const customPath = path.resolve(options.standardPath);
      try {
        await fs.rm(customPath, { force: true });
        removedPaths.push(customPath);
        logger?.info('Removed custom evaluation standard from disk', { path: customPath });
      } catch (err: any) {
        logger?.warn(`Failed to delete custom standard at ${customPath}: ${err.message}`);
      }
    }
    return { reused: false, targetSavePath, removedPaths };
  }

  // If removeExistingStandard is requested, delete matching standard files from disk
  if (options.removeExistingStandard || options.removeStandard) {
    const removedPaths: string[] = [];
    for (const candidatePath of candidateSavePaths) {
      try {
        await fs.rm(candidatePath, { force: true });
        removedPaths.push(candidatePath);
        logger?.info('Removed existing evaluation standard from disk', { path: candidatePath });
      } catch (err: any) {
        logger?.warn(`Failed to delete existing standard at ${candidatePath}: ${err.message}`);
      }
    }
    if (options.standardPath) {
      const customPath = path.resolve(options.standardPath);
      try {
        await fs.rm(customPath, { force: true });
        removedPaths.push(customPath);
        logger?.info('Removed custom evaluation standard from disk', { path: customPath });
      } catch (err: any) {
        logger?.warn(`Failed to delete custom standard at ${customPath}: ${err.message}`);
      }
    }
    return { reused: false, targetSavePath, removedPaths };
  }

  if (options.forceNewStandard || options.reuseStandard === false) {
    logger?.info('Standard reuse disabled or forced new; will generate new standard via LLM distillation');
    return { reused: false, targetSavePath };
  }

  // Priority 1: User explicitly specified standardPath
  if (options.standardPath) {
    const customPath = path.resolve(options.standardPath);
    try {
      const content = await fs.readFile(customPath, 'utf8');
      const standard = JSON.parse(content) as EvaluationStandard;
      const valid = verifyStandardHash(standard);
      if (valid) {
        logger?.info('Adopted verified evaluation standard from explicit path', {
          sourcePath: customPath,
          standardHash: standard.meta.standardHash,
        });
        return { standard, reused: true, sourcePath: customPath, targetSavePath };
      }
      logger?.warn('Explicit evaluation standard failed SHA-256 hash check; generating new standard', {
        sourcePath: customPath,
      });
    } catch (err: any) {
      logger?.warn(`Failed to read explicit standard at ${customPath}: ${err.message}`);
    }
  }

  // Priority 2: Reusable standards directory by topic slug
  for (const candidatePath of candidateSavePaths) {
    try {
      const content = await fs.readFile(candidatePath, 'utf8');
      const standard = JSON.parse(content) as EvaluationStandard;
      const valid = verifyStandardHash(standard);
      if (valid) {
        logger?.info('Adopted verified evaluation standard from reusable standards directory', {
          sourcePath: candidatePath,
          standardHash: standard.meta.standardHash,
        });
        return { standard, reused: true, sourcePath: candidatePath, targetSavePath: candidatePath };
      }
      logger?.warn('Standard in reusable directory failed SHA-256 hash check; generating fresh standard', {
        sourcePath: candidatePath,
      });
    } catch {
      // File doesn't exist, try next candidate
    }
  }

  // Priority 3: Fallback standards directory (e.g. legacy ./standards)
  const fallbackDir = options.fallbackStandardsDir ? path.resolve(options.fallbackStandardsDir) : null;
  if (fallbackDir && fallbackDir !== standardsDir) {
    const fallbackPaths = [
      path.join(fallbackDir, `${topicSlug}.json`),
      path.join(fallbackDir, `${topicSlug}-standard.json`),
    ];
    for (const fbPath of fallbackPaths) {
      try {
        const content = await fs.readFile(fbPath, 'utf8');
        const standard = JSON.parse(content) as EvaluationStandard;
        const valid = verifyStandardHash(standard);
        if (valid) {
          logger?.info('Adopted verified evaluation standard from legacy fallback standards directory', {
            sourcePath: fbPath,
            standardHash: standard.meta.standardHash,
            targetSavePath,
          });
          return { standard, reused: true, sourcePath: fbPath, targetSavePath };
        }
      } catch {
        // Try next fallback path
      }
    }
  }

  return { reused: false, targetSavePath };
}

/**
 * Resolves or checks reusable standards for a given topic string.
 */
export async function resolveStandardForTopic(
  options: {
    topic: string;
    standardPath?: string;
    standardsDir?: string;
    fallbackStandardsDir?: string;
    reuseStandard?: boolean;
    forceNewStandard?: boolean;
    removeExistingStandard?: boolean;
    removeStandard?: boolean;
    removeAllStandards?: boolean;
  },
  logger?: RunLogger
): Promise<{
  standard: EvaluationStandard | null;
  reused: boolean;
  sourcePath?: string;
  targetSavePath: string;
  removedPaths?: string[];
}> {
  const topicSlug = slugifyTopic(options.topic);
  const result = await resolveReusableStandard(topicSlug, options, logger);
  return {
    ...result,
    standard: result.standard ?? null,
  };
}

/**
 * Stage 6: saved evaluation standard for reuse
 * Persists the validated standard to the reusable standards location and custom save path.
 */
export async function persistStandardForReuse(
  standard: EvaluationStandard,
  targetSavePath: string,
  customSavePath?: string,
  logger?: RunLogger
): Promise<string> {
  const primaryDir = path.dirname(targetSavePath);
  await fs.mkdir(primaryDir, { recursive: true });
  await fs.writeFile(targetSavePath, JSON.stringify(standard, null, 2), 'utf8');
  logger?.info('Persisted evaluation standard to reusable directory', {
    path: targetSavePath,
    hash: standard.meta.standardHash,
  });

  if (customSavePath) {
    const customResolved = path.resolve(customSavePath);
    await fs.mkdir(path.dirname(customResolved), { recursive: true });
    await fs.writeFile(customResolved, JSON.stringify(standard, null, 2), 'utf8');
    logger?.info('Persisted evaluation standard to custom save path', { path: customResolved });
  }

  return targetSavePath;
}
