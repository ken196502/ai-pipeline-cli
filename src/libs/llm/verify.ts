/**
 * Public curl connectivity and authentication testing utilities for OpenAI-compatible LLM gateways.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pc from 'picocolors';
import { type EnvConfig, getEnvConfig } from '../../utils/env.js';
import type { EnvVerificationResult } from './types.js';

export { type EnvVerificationResult };

const execFileAsync = promisify(execFile);

/**
 * Masks an API key for safe terminal display
 */
export function maskApiKey(key: string): string {
  if (!key || key.length < 8) return '****';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

/**
 * Checks connectivity and authentication to the configured AI endpoint using curl.
 */
export async function verifyEnvConfigWithCurl(
  customConfig?: EnvConfig,
): Promise<EnvVerificationResult> {
  const config = customConfig || getEnvConfig();

  if (!config.apiKey) {
    return {
      valid: false,
      reason: 'API_KEY is missing or empty in .env configuration.',
      baseUrl: config.baseUrl,
    };
  }

  const endpointUrl = `${config.baseUrl.replace(/\/+$/, '')}/models`;
  const startTime = Date.now();
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  try {
    const args = [
      '-s',
      '-S',
      '-w',
      '\n%{http_code}',
      '--connect-timeout',
      '10',
      '--max-time',
      '15',
      '-H',
      `Authorization: Bearer ${config.apiKey}`,
      '-H',
      'Content-Type: application/json',
      endpointUrl,
    ];

    const { stdout } = await execFileAsync('curl', args);
    const latencyMs = Date.now() - startTime;

    const trimmed = stdout.trim();
    const lines = trimmed.split('\n');
    const statusCodeStr = lines[lines.length - 1];
    const statusCode = parseInt(statusCodeStr, 10);
    const responseBody = lines.slice(0, -1).join('\n').trim();

    if (statusCode === 200) {
      let modelsFound: string[] = [];
      try {
        const json = JSON.parse(responseBody);
        if (Array.isArray(json.data)) {
          modelsFound = json.data.map((m: any) => m.id).filter(Boolean);
        }
      } catch {
        // Body was not JSON but status was 200 OK
      }

      return {
        valid: true,
        reason: `Successfully connected to ${config.baseUrl} (${latencyMs}ms)`,
        statusCode: 200,
        baseUrl: config.baseUrl,
        modelsFound,
        latencyMs,
      };
    }

    if (statusCode === 401 || statusCode === 403) {
      return {
        valid: false,
        reason: `Authentication failed (HTTP ${statusCode}): API key invalid or unauthorized for ${config.baseUrl}`,
        statusCode,
        baseUrl: config.baseUrl,
        latencyMs,
      };
    }

    // If /models returns 404, try a minimal chat completion probe
    if (statusCode === 404) {
      const chatProbe = await probeChatEndpointWithCurl(config);
      if (chatProbe.valid) {
        return chatProbe;
      }
    }

    return {
      valid: false,
      reason: `Endpoint returned HTTP ${statusCode}: ${responseBody.slice(0, 150)}`,
      statusCode,
      baseUrl: config.baseUrl,
      latencyMs,
    };
  } catch (err: any) {
    const message = err?.message || String(err);
    // Retry only CONNECTION-level failures (DNS/timeout/refused/reset). Auth and
    // HTTP-status failures are deterministic and must fail fast — no masking.
    const transient = /timed out|timeout|could not resolve|connection refused|connection reset|recv failure|empty reply|\((?:6|7|28|35|56)\)/i.test(
      message
    );
    if (transient && attempt < MAX_ATTEMPTS) {
      console.warn(
        pc.yellow(
          `[Env Check] LLM gateway curl attempt ${attempt}/${MAX_ATTEMPTS} failed transiently (${
            message.split('\n')[0].slice(0, 120)
          }); retrying in ${attempt * 2}s...`
        )
      );
      await new Promise((r) => setTimeout(r, attempt * 2_000));
      continue;
    }
    return {
      valid: false,
      reason: `curl execution failed: ${message}`,
      baseUrl: config.baseUrl,
    };
  }
  }

  // Unreachable: every loop path returns. Kept for the type checker.
  return { valid: false, reason: 'curl execution failed after retries', baseUrl: config.baseUrl };
}

/**
 * Fallback probe to /chat/completions if /models is not implemented on custom gateway
 */
export async function probeChatEndpointWithCurl(config: EnvConfig): Promise<EnvVerificationResult> {
  const chatUrl = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const probePayload = JSON.stringify({
    model: config.llmModel,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
  });

  try {
    const args = [
      '-s',
      '-S',
      '-w',
      '\n%{http_code}',
      '--connect-timeout',
      '10',
      '--max-time',
      '15',
      '-X',
      'POST',
      '-H',
      `Authorization: Bearer ${config.apiKey}`,
      '-H',
      'Content-Type: application/json',
      '-d',
      probePayload,
      chatUrl,
    ];

    const { stdout } = await execFileAsync('curl', args);
    const lines = stdout.trim().split('\n');
    const statusCode = parseInt(lines[lines.length - 1], 10);

    if (statusCode === 200) {
      return {
        valid: true,
        reason: `Chat endpoint reachable and authenticated on ${config.baseUrl}`,
        statusCode: 200,
        baseUrl: config.baseUrl,
      };
    }

    return {
      valid: false,
      reason: `Endpoint returned HTTP ${statusCode}`,
      statusCode,
      baseUrl: config.baseUrl,
    };
  } catch (err: any) {
    return {
      valid: false,
      reason: `Fallback curl chat probe failed: ${err.message}`,
      baseUrl: config.baseUrl,
    };
  }
}

/**
 * Formats and prints verification results cleanly to the terminal
 */
export function printEnvVerification(
  config: EnvConfig,
  result: EnvVerificationResult,
): void {
  console.log(pc.bold('\n[Env Check] Validating environment configuration via curl...'));
  console.log(pc.dim(`  Base URL:    ${config.baseUrl}`));
  console.log(pc.dim(`  API Key:     ${maskApiKey(config.apiKey)}`));
  console.log(pc.dim(`  LLM Model:   ${config.llmModel}`));
  console.log(pc.dim(`  VL Model:    ${config.vlModel}`));
  console.log(pc.dim(`  Image Model: ${config.imageModel}`));

  if (result.valid) {
    console.log(pc.green(`✓ ${result.reason}`));
    if (result.modelsFound && result.modelsFound.length > 0) {
      const match = result.modelsFound.includes(config.llmModel);
      console.log(
        pc.dim(
          `  Gateway models: ${result.modelsFound.length} available ${
            match ? pc.green(`(includes ${config.llmModel})`) : ''
          }`,
        ),
      );
    }
  } else {
    console.log(pc.red(`✗ Environment check failed: ${result.reason}`));
  }
}
