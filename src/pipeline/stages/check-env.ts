import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pc from 'picocolors';
import { resolveChromiumPath } from '../../browser/installer.js';
import { getEnvConfig } from '../../env.js';
import { verifyEnvConfigWithCurl, printEnvVerification, maskApiKey } from '../../llm/verify.js';
import { ensureProfileDir } from '../../utils/browser.js';
import { ensureYtDlp } from '../../utils/ytdlp.js';
import { resolveFfmpegBin } from '../../utils/media/frames.js';
import { notifyLlmUnavailableAndExit } from '../../utils/send_msg.js';
import type { EnvCheckSummary } from '../contracts.js';
import type { RunLogger } from '../../utils/logger.js';

const execFileAsync = promisify(execFile);

export async function checkEnvStage(
  options: { profileDir?: string },
  logger?: RunLogger
): Promise<EnvCheckSummary> {
  const profileDir = await ensureProfileDir(options.profileDir);
  const envConfig = getEnvConfig();

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
  };
}
