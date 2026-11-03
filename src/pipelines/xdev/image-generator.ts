import fs from 'node:fs/promises';
import path from 'node:path';
import pc from 'picocolors';
import { getEnvConfig } from '../../utils/env.js';

export interface ImageGenerationOptions {
  prompt: string;
  outputPath: string;
  size?: string;
}

export interface ImageGenerationResult {
  outputPath: string;
}

/** An HTTP-level refusal from the gateway: the request reached the provider. */
class GatewayRejection extends Error {}

/**
 * Socket-level failures worth another attempt.
 *
 * The provider closes connections without a byte of response when the egress
 * chain rotates (`UND_ERR_SOCKET: other side closed`, bytesRead 0). That is a
 * transport accident, not a rejection: the same request succeeds a moment later.
 * A 4xx is never in this list - the gateway has spoken and retrying would only
 * hide the reason.
 */
const TRANSIENT_CODES = new Set([
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
]);

const IMAGE_REQUEST_TIMEOUT_MS = 180_000;
const IMAGE_TRANSPORT_ATTEMPTS = 3;

function retryBackoff(): number[] {
  const raw = process.env.IMAGE_RETRY_BACKOFF_MS;
  if (!raw) return [2_000, 6_000];
  const parsed = raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0);
  return parsed.length ? parsed : [2_000, 6_000];
}

function transportCode(error: unknown): string | undefined {
  const outer = error as { code?: string; cause?: { code?: string } };
  return outer?.cause?.code ?? outer?.code;
}

function describeTransportError(error: unknown): string {
  const outer = error as { message?: string; cause?: { code?: string; message?: string } };
  const code = transportCode(error);
  const cause = outer?.cause?.message;
  const detail = [code, cause].filter(Boolean).join(': ');
  return detail || outer?.message || String(error);
}

function isTransportFailure(error: unknown): boolean {
  if (error instanceof GatewayRejection) return false;
  if ((error as { name?: string })?.name === 'TimeoutError') return true;
  const code = transportCode(error);
  return !!code && TRANSIENT_CODES.has(code);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs one HTTP exchange, retrying only transport-level failures.
 *
 * "No fallbacks to hide problems" still holds: a gateway rejection propagates
 * untouched, and when every attempt dies on the socket the thrown error names
 * the attempts and the underlying cause instead of a bare `fetch failed`.
 */
async function withTransportRetry<T>(label: string, run: () => Promise<T>): Promise<T> {
  const backoff = retryBackoff();
  let lastError: unknown;

  for (let attempt = 1; attempt <= IMAGE_TRANSPORT_ATTEMPTS; attempt++) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (!isTransportFailure(error) || attempt === IMAGE_TRANSPORT_ATTEMPTS) break;
      const wait = backoff[Math.min(attempt - 1, backoff.length - 1)]!;
      console.log(
        pc.yellow(
          `[image-generator] ${label} failed at the transport layer (${describeTransportError(error)}) — ` +
            `retry ${attempt}/${IMAGE_TRANSPORT_ATTEMPTS - 1} in ${wait / 1000}s`
        )
      );
      await sleep(wait);
    }
  }

  if (isTransportFailure(lastError)) {
    throw new Error(
      `[image-generator] ${label} failed after ${IMAGE_TRANSPORT_ATTEMPTS} transport attempt(s): ${describeTransportError(lastError)}`,
      { cause: lastError }
    );
  }
  throw lastError;
}

/**
 * Generates an image using the IMAGE_MODEL specified in .env via the OpenAI-compatible endpoint.
 * Follows the "No fallbacks to hide problems" principle: if the gateway returns an error,
 * it immediately throws an explicit error and halts the pipeline.
 */
export async function generateImageFromEnv(
  options: ImageGenerationOptions
): Promise<ImageGenerationResult> {
  const cjkChars = (options.prompt.match(/[\u4e00-\u9fff]/g) || []).length;
  if (cjkChars > 0) {
    throw new Error(
      `[image-generator] Prompt contains Chinese characters (${cjkChars} CJK found). Prompts must be 100% English to prevent generated images from rendering Chinese text.`
    );
  }

  const config = getEnvConfig();
  const imageModel = config.imageModel || process.env.IMAGE_MODEL || 'sensenova-u1.5-fast';
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const url = `${baseUrl}/images/generations`;

  console.log(pc.cyan(`[image-generator] Generating real header image via env model: ${imageModel}...`));
  console.log(pc.dim(`  Prompt: "${options.prompt.slice(0, 100)}..."`));

  const started = Date.now();
  const data: any = await withTransportRetry(`image generation via ${imageModel}`, async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: imageModel,
        prompt: options.prompt,
        n: 1,
        size: options.size || '1024x1024',
      }),
      signal: AbortSignal.timeout(IMAGE_REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const errText = await res.text();
      let errorMsg = `HTTP ${res.status}: ${res.statusText}`;
      try {
        const parsed = JSON.parse(errText);
        errorMsg = parsed?.error?.message || errorMsg;
      } catch {
        errorMsg = errText || errorMsg;
      }
      console.error(pc.red(`[image-generator] FATAL: Gateway image generation failed with ${imageModel}: ${errorMsg}`));
      throw new GatewayRejection(`[image-generator] Failed to generate image using ${imageModel}: ${errorMsg}`);
    }

    return await res.json();
  });

  const item = data?.data?.[0];

  if (!item) {
    throw new Error(`[image-generator] Empty response from ${imageModel}`);
  }

  let buf: Buffer;
  if (item.b64_json) {
    buf = Buffer.from(item.b64_json, 'base64');
  } else if (item.url) {
    buf = await withTransportRetry('image download from provider', async () => {
      const imgRes = await fetch(item.url, { signal: AbortSignal.timeout(IMAGE_REQUEST_TIMEOUT_MS) });
      if (!imgRes.ok) {
        throw new GatewayRejection(
          `[image-generator] Failed to fetch image url from provider: ${imgRes.status} ${imgRes.statusText}`
        );
      }
      return Buffer.from(await imgRes.arrayBuffer());
    });
  } else {
    throw new Error(`[image-generator] Neither b64_json nor url found in ${imageModel} generation response`);
  }

  await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
  await fs.writeFile(options.outputPath, buf);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    pc.green(`[image-generator] ✔ Real header image successfully generated: ${options.outputPath} (${seconds}s)`)
  );
  return { outputPath: options.outputPath };
}
