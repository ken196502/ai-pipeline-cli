import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveChromiumPath } from '../../../libs/browser/installer.js';
import { getEnvConfig } from '../../../utils/env.js';
import { verifyEnvConfigWithCurl, printEnvVerification, maskApiKey } from '../../../libs/llm/verify.js';
import { ensureProfileDir } from '../../../utils/browser.js';
import { ensureYtDlp } from '../../../libs/media/ytdlp.js';
import { resolveFfmpegBin } from '../../../libs/media/frames.js';
import { checkPuterAsrReady } from '../../../libs/asr/index.js';
import {
  isTestEnvironment,
  notifyLlmUnavailableAndExit,
  verifyNotificationConfig,
} from '../../../utils/send_msg.js';

import type { EnvCheckSummary } from '../contracts.js';
import type { RunLogger } from '../../../utils/logger.js';

const execFileAsync = promisify(execFile);

export async function checkEnvStage(
  options: { profileDir?: string },
  logger?: RunLogger
): Promise<EnvCheckSummary> {
  const profileDir = await ensureProfileDir(options.profileDir);
  const envConfig = getEnvConfig();

  // Notification channels first: fail fast instead of losing every alert later.
  // Test runs deliver no alerts, so the ambient bot/port config is irrelevant there.
  if (isTestEnvironment()) {
    logger?.info('Stage 1: Notification self-check skipped (test environment)');
  } else {
    const notifications = verifyNotificationConfig();
    logger?.info(
      `Stage 1: Verified notification channels: bot=${notifications.bot}, chat=${notifications.notifyTo}, ` +
        `webhook=${notifications.webhookUrl}, pi-inbound=${notifications.inboundUrl}`
    );
  }

  // 1. LLM Verification via curl (mandatory)
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

  // 5. Puter ASR status verification (optional speech-to-text)
  const puterAsrStatus = await checkPuterAsrReady();
  if (puterAsrStatus.configured) {
    logger?.info(`Puter ASR is configured via ${puterAsrStatus.tokenSource} (${puterAsrStatus.tokenPreview})`);
  } else {
    logger?.info('Puter ASR is not configured (optional; set PUTER_AUTH_TOKEN in .env to transcribe tweet videos)');
  }

  // 6. Hugging Face token verification (for Qwen3-TTS ZeroGPU quota)
  const hfToken = process.env.HF_TOKEN;
  if (hfToken) {
    const maskedHf = `${hfToken.slice(0, 4)}...${hfToken.slice(-4)}`;
    logger?.info(`Hugging Face token is configured for Qwen3-TTS (${maskedHf})`);
  } else {
    logger?.info('ℹ HF_TOKEN is not configured in .env (Qwen3-TTS will use unauthenticated ZeroGPU IP quota)');
  }

  return {
    llmConfigured: true,
    llmEndpoint: envConfig.baseUrl,
    llmModel: envConfig.llmModel,
    vlModel: envConfig.vlModel,
    chromiumInstalled,
    chromiumPath,
    chromiumVersion,
    ytDlpInstalled,
    ytDlpPath,
    ffmpegInstalled,
    profileDir,
    puterAsrConfigured: puterAsrStatus.configured,
  };

}
