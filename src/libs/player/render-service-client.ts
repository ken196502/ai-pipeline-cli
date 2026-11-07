/**
 * Client for the host-side GPU render service.
 *
 * The VM cannot render the explainer frame-by-frame (software GL, ~773 ms/frame),
 * so a resident service on the macOS host performs the render and writes the
 * artifacts back into the shared directory. See
 * `Docs/plan-explainer-host-render-service.md`.
 *
 * Contract highlights:
 *   - `GET /healthz` is unauthenticated and probed with a short timeout.
 *   - Every other endpoint requires `Authorization: Bearer <token>`.
 *   - Progress arrives over SSE (`/jobs/:id/events`); if SSE is unavailable the
 *     client polls `GET /jobs/:id` instead. A job that reports `error` is a real
 *     render failure and is never retried.
 *   - Artifacts are verified in the shared directory (existence, non-zero size,
 *     ffprobe duration). Verification failures throw — there is no silent local
 *     fallback.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pc from 'picocolors';
import type { RenderExplainerVideoResult } from './render.js';

const execFileAsync = promisify(execFile);

/** GPU mode understood by the host service (`metal` is a host-only alias). */
export type RenderServiceGpuMode = 'default' | 'gpu' | 'metal' | 'vulkan' | 'swiftshader';

const RENDER_SERVICE_GPU_MODES: readonly RenderServiceGpuMode[] = [
  'default',
  'gpu',
  'metal',
  'vulkan',
  'swiftshader',
];

/** Parses/validates a GPU mode string; unknown values fail loudly. */
export function resolveRenderServiceGpuMode(raw?: string | null): RenderServiceGpuMode {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return 'default';
  if ((RENDER_SERVICE_GPU_MODES as readonly string[]).includes(value)) {
    return value as RenderServiceGpuMode;
  }
  if (value === 'gl' || value === 'angle-gl') return 'gpu';
  if (value === 'angle-metal') return 'metal';
  if (value === 'angle-vulkan') return 'vulkan';
  if (value === 'cpu') return 'swiftshader';
  throw new Error(
    `unknown render service GPU mode "${raw}" — use default | gpu | metal | vulkan | swiftshader`
  );
}

export interface RenderServiceOptions {
  /** e.g. http://192.168.64.1:8790 */
  baseUrl: string;
  token?: string;
  gpu?: RenderServiceGpuMode;
  /** /healthz probe timeout (default 1500 ms). */
  probeTimeoutMs?: number;
  /** Status poll interval when SSE is unavailable (default 2000 ms). */
  pollIntervalMs?: number;
  /** Per-request timeout for submit/status/cancel (default 15000 ms). */
  requestTimeoutMs?: number;
  /** Retries for probe/status on network errors (default 3). */
  retries?: number;
  /** Base backoff delay between retries (default 250 ms, exponential). */
  retryBaseDelayMs?: number;
  signal?: AbortSignal;
}

export interface RenderServiceTimeline {
  resolution: { width: number; height: number };
  fps: number;
  totalDurationSec: number;
}

export interface RenderViaServiceParams extends RenderServiceOptions {
  /** Absolute path of the explainer bundle inside the shared directory. */
  explainerDir: string;
  timeline: RenderServiceTimeline;
  /** Destination MP4 path on the VM side. */
  outVideoPath: string;
  crf?: number;
  preset?: string;
  fps?: number;
  onProgress?: (rendered: number, total: number) => void;
}

export type RenderServiceJobState = 'queued' | 'running' | 'done' | 'error' | 'canceled';

export interface RenderServiceJobSnapshot {
  jobId: string;
  state: RenderServiceJobState;
  framesRendered: number;
  totalFrames: number;
  fps: number;
  message?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  outputs?: { video?: string; grid?: string };
  engine?: string;
  gpu?: string;
}

export interface RenderServiceHealth {
  ok: boolean;
  version: string;
  gpu: string;
  browser: string;
  busy: boolean;
  queueLen: number;
  uptimeSec: number;
}

/** An explicit, actionable failure from the render service (never swallowed). */
export class RenderServiceError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'RenderServiceError';
    this.status = status;
  }
}

const DEFAULT_PROBE_TIMEOUT_MS = 1_500;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;

/** Duration tolerance when checking the rendered video against the timeline. */
const DURATION_ABS_TOLERANCE_SEC = 1.5;
const DURATION_REL_TOLERANCE = 0.02;

function abortError(): Error {
  const err = new Error('[render-service] request aborted by caller');
  err.name = 'AbortError';
  return err;
}

function isTimeoutError(err: unknown): boolean {
  const name = (err as { name?: string } | undefined)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/** Network-level failures worth retrying (never HTTP 4xx/5xx or job errors). */
function isRetryableNetworkError(err: unknown): boolean {
  const e = err as { name?: string; code?: string; message?: string; cause?: { code?: string } } | undefined;
  if (!e) return false;
  if (e.name === 'AbortError') return true; // our own timeout abort
  const code = e.cause?.code ?? e.code ?? '';
  if (
    [
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EPIPE',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'EAI_AGAIN',
      'UND_ERR_SOCKET',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
    ].includes(code)
  ) {
    return true;
  }
  return /fetch failed|socket hang up|network|other side closed/i.test(String(e.message ?? ''));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** ffprobe duration in seconds; 0 when the file is unreadable. */
export async function probeVideoDurationSec(filePath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    const value = Number(stdout.trim());
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

/**
 * Waits until the file exists with a non-zero size that stays constant across two
 * consecutive polls. Guards against NFS/9p exposing a partially written artifact
 * (see plan §9).
 */
export async function waitForStableFile(
  filePath: string,
  options: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {}
): Promise<number> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 250;
  const startedAt = Date.now();
  let previousSize = -1;

  while (Date.now() - startedAt < timeoutMs) {
    if (options.signal?.aborted) throw abortError();
    let size = 0;
    try {
      const stat = await fsp.stat(filePath);
      size = stat.isFile() ? stat.size : 0;
    } catch {
      size = 0;
    }
    if (size > 0 && size === previousSize) return size;
    previousSize = size;
    await sleep(intervalMs, options.signal);
  }
  throw new RenderServiceError(
    `[render-service] artifact did not become stable within ${Math.round(timeoutMs / 1000)}s: ${filePath}`
  );
}

/**
 * Verifies a rendered video: exists, non-zero size, and ffprobe duration close to
 * the timeline duration. Throws `RenderServiceError` on any mismatch.
 */
export async function verifyRenderedVideo(params: {
  videoPath: string;
  totalDurationSec: number;
  signal?: AbortSignal;
}): Promise<{ size: number; durationSec: number }> {
  const size = await waitForStableFile(params.videoPath, { signal: params.signal });
  const durationSec = await probeVideoDurationSec(params.videoPath);
  if (!durationSec) {
    throw new RenderServiceError(
      `[render-service] rendered video is unreadable (ffprobe returned no duration): ${params.videoPath}`
    );
  }
  const tolerance = Math.max(
    DURATION_ABS_TOLERANCE_SEC,
    params.totalDurationSec * DURATION_REL_TOLERANCE
  );
  if (Math.abs(durationSec - params.totalDurationSec) > tolerance) {
    throw new RenderServiceError(
      `[render-service] rendered video duration ${durationSec.toFixed(2)}s does not match the timeline ` +
        `${params.totalDurationSec.toFixed(2)}s (±${tolerance.toFixed(2)}s): ${params.videoPath}`
    );
  }
  return { size, durationSec };
}

interface SseEvent {
  event: string;
  data: string;
}

function parseSseBlock(block: string): SseEvent | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trim());
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

export class RenderServiceClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly probeTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly retries: number;
  private readonly retryBaseDelayMs: number;
  private readonly signal?: AbortSignal;

  constructor(options: RenderServiceOptions) {
    const baseUrl = (options.baseUrl || '').trim().replace(/\/+$/, '');
    if (!baseUrl) {
      throw new RenderServiceError('[render-service] baseUrl is required');
    }
    if (!/^https?:\/\//i.test(baseUrl)) {
      throw new RenderServiceError(
        `[render-service] baseUrl must start with http:// or https:// (got "${options.baseUrl}")`
      );
    }
    this.baseUrl = baseUrl;
    this.token = options.token ?? process.env.EXPLAINER_RENDER_SERVICE_TOKEN ?? '';
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.signal = options.signal;
  }

  private url(pathname: string): string {
    return `${this.baseUrl}${pathname}`;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    useCallerSignal = true
  ): Promise<Response> {
    if (useCallerSignal && this.signal?.aborted) throw abortError();
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const outerSignal = useCallerSignal ? this.signal : undefined;
    const signal = outerSignal ? AbortSignal.any([outerSignal, timeoutSignal]) : timeoutSignal;
    try {
      return await fetch(url, { ...init, signal });
    } catch (err) {
      if (outerSignal?.aborted) throw abortError();
      throw err;
    }
  }

  /** Runs `fn` with bounded exponential-backoff retries on network errors only. */
  private async withRetry<T>(fn: () => Promise<T>, retries = this.retries): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        if (this.signal?.aborted) throw abortError();
        if (err instanceof RenderServiceError) throw err;
        if (!isRetryableNetworkError(err) || attempt >= retries) throw err;
        attempt += 1;
        const delay = this.retryBaseDelayMs * 2 ** (attempt - 1);
        await sleep(delay, this.signal);
      }
    }
  }

  /** GET /healthz (no auth on the server; token sent anyway when present). */
  async health(timeoutMs = this.probeTimeoutMs): Promise<RenderServiceHealth> {
    const response = await this.withRetry(() =>
      this.fetchWithTimeout(
        this.url('/healthz'),
        { method: 'GET', headers: this.headers() },
        timeoutMs
      )
    );
    if (!response.ok) {
      throw new RenderServiceError(
        `[render-service] /healthz returned HTTP ${response.status}`,
        response.status
      );
    }
    return (await response.json()) as RenderServiceHealth;
  }

  /** Probe used for routing. Any failure (timeout, connection, non-200) = false. */
  async probe(): Promise<boolean> {
    try {
      const health = await this.health(this.probeTimeoutMs);
      return health?.ok === true;
    } catch (err) {
      if ((err as Error)?.name === 'AbortError' && this.signal?.aborted) throw err;
      return false;
    }
  }

  /** POST /jobs */
  async submit(params: {
    explainerDir: string;
    engine?: string;
    gpu?: RenderServiceGpuMode;
    crf?: number;
    preset?: string;
    fps?: number;
  }): Promise<string> {
    const body = JSON.stringify({
      explainerDir: params.explainerDir,
      engine: params.engine,
      gpu: params.gpu,
      crf: params.crf,
      preset: params.preset,
      fps: params.fps,
    });
    const response = await this.fetchWithTimeout(
      this.url('/jobs'),
      {
        method: 'POST',
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body,
      },
      this.requestTimeoutMs
    );
    if (!response.ok) {
      throw await this.httpError(response, 'POST /jobs');
    }
    const payload = (await response.json()) as { jobId?: string };
    if (!payload?.jobId) {
      throw new RenderServiceError('[render-service] POST /jobs returned no jobId');
    }
    return payload.jobId;
  }

  /** GET /jobs/:id (network-retried). */
  async getJob(jobId: string): Promise<RenderServiceJobSnapshot> {
    const response = await this.withRetry(() =>
      this.fetchWithTimeout(
        this.url(`/jobs/${encodeURIComponent(jobId)}`),
        { method: 'GET', headers: this.headers() },
        this.requestTimeoutMs
      )
    );
    if (!response.ok) {
      throw await this.httpError(response, `GET /jobs/${jobId}`);
    }
    return (await response.json()) as RenderServiceJobSnapshot;
  }

  /** POST /jobs/:id/cancel (deliberately ignores the caller's abort signal). */
  async cancel(jobId: string): Promise<void> {
    const response = await this.fetchWithTimeout(
      this.url(`/jobs/${encodeURIComponent(jobId)}/cancel`),
      { method: 'POST', headers: this.headers() },
      this.requestTimeoutMs,
      false
    );
    if (!response.ok) {
      throw await this.httpError(response, `POST /jobs/${jobId}/cancel`);
    }
  }

  /** GET /jobs/:id/result/:kind → local file. */
  async downloadResult(jobId: string, kind: 'video' | 'grid', outPath: string): Promise<void> {
    const response = await this.fetchWithTimeout(
      this.url(`/jobs/${encodeURIComponent(jobId)}/result/${kind}`),
      { method: 'GET', headers: this.headers() },
      Math.max(this.requestTimeoutMs, 120_000)
    );
    if (!response.ok) {
      throw await this.httpError(response, `GET /jobs/${jobId}/result/${kind}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      throw new RenderServiceError(`[render-service] empty ${kind} download for job ${jobId}`);
    }
    await fsp.mkdir(path.dirname(outPath), { recursive: true });
    await fsp.writeFile(outPath, buffer);
  }

  private async httpError(response: Response, label: string): Promise<RenderServiceError> {
    let detail = '';
    try {
      const body = (await response.json()) as { error?: string };
      detail = body?.error ? ` — ${body.error}` : '';
    } catch {
      detail = '';
    }
    if (response.status === 401) {
      return new RenderServiceError(
        `[render-service] ${label} failed: 401 unauthorized — the host render service rejected the token. ` +
          'Fix EXPLAINER_RENDER_SERVICE_TOKEN (or --render-service-token).',
        401
      );
    }
    if (response.status === 400) {
      return new RenderServiceError(
        `[render-service] ${label} failed: 400 bad request${detail}. ` +
          'The explainerDir must be an absolute path under the shared artifacts root and contain explainer.json + assets/narration.wav.',
        400
      );
    }
    if (response.status === 429) {
      return new RenderServiceError(
        `[render-service] ${label} failed: 429 queue full${detail}. ` +
          'The host render service is already rendering and its queue is full — retry once it is idle.',
        429
      );
    }
    return new RenderServiceError(
      `[render-service] ${label} failed: HTTP ${response.status}${detail}`,
      response.status
    );
  }

  /**
   * Subscribes to `/jobs/:id/events` (SSE). Returns the terminal snapshot, or
   * `null` when SSE is unavailable so the caller can fall back to polling.
   * A job `error` event is a real failure and is thrown.
   */
  private async tryStream(
    jobId: string,
    onProgress?: (rendered: number, total: number) => void
  ): Promise<RenderServiceJobSnapshot | null> {
    let response: Response;
    try {
      response = await this.fetchWithTimeout(
        this.url(`/jobs/${encodeURIComponent(jobId)}/events`),
        { method: 'GET', headers: { ...this.headers(), Accept: 'text/event-stream' } },
        // SSE is long-lived: only the caller's signal cancels it.
        24 * 60 * 60 * 1000
      );
    } catch {
      return null;
    }
    if (!response.ok || !response.body) return null;
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream')) return null;

    let buffer = '';
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += Buffer.from(chunk).toString('utf8');
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');
          const parsed = parseSseBlock(block);
          if (!parsed) continue;
          let payload: any;
          try {
            payload = JSON.parse(parsed.data);
          } catch {
            continue;
          }
          if (parsed.event === 'progress') {
            onProgress?.(Number(payload.framesRendered) || 0, Number(payload.totalFrames) || 0);
          } else if (parsed.event === 'log') {
            if (payload?.message) console.log(pc.dim(`[render-service] ${payload.message}`));
          } else if (parsed.event === 'done') {
            const snapshot = payload as RenderServiceJobSnapshot;
            onProgress?.(snapshot.framesRendered, snapshot.totalFrames);
            return snapshot;
          } else if (parsed.event === 'error') {
            const snapshot = payload as RenderServiceJobSnapshot;
            throw new RenderServiceError(
              `[render-service] job ${jobId} failed on the host: ${snapshot.error || 'unknown render error'}`
            );
          }
        }
      }
    } catch (err) {
      if (err instanceof RenderServiceError) throw err;
      if (this.signal?.aborted) throw abortError();
      // Stream dropped (host restart, proxy, idle TCP reset): fall back to polling.
      return null;
    }
    return null;
  }

  /** Polls GET /jobs/:id until a terminal state. */
  private async pollUntilDone(
    jobId: string,
    onProgress?: (rendered: number, total: number) => void
  ): Promise<RenderServiceJobSnapshot> {
    for (;;) {
      const snapshot = await this.getJob(jobId);
      if (snapshot.state === 'done') {
        onProgress?.(snapshot.framesRendered, snapshot.totalFrames);
        return snapshot;
      }
      if (snapshot.state === 'error') {
        throw new RenderServiceError(
          `[render-service] job ${jobId} failed on the host: ${snapshot.error || 'unknown render error'}`
        );
      }
      if (snapshot.state === 'canceled') {
        throw new RenderServiceError(`[render-service] job ${jobId} was canceled on the host`);
      }
      onProgress?.(snapshot.framesRendered, snapshot.totalFrames);
      await sleep(this.pollIntervalMs, this.signal);
    }
  }

  /** SSE first, status polling as the documented fallback. */
  async waitForCompletion(
    jobId: string,
    onProgress?: (rendered: number, total: number) => void
  ): Promise<RenderServiceJobSnapshot> {
    const streamed = await this.tryStream(jobId, onProgress);
    if (streamed) return streamed;
    return this.pollUntilDone(jobId, onProgress);
  }
}

/** Probes the service; `false` on any failure (timeout, connection, non-200). */
export async function probeRenderService(options: RenderServiceOptions): Promise<boolean> {
  const client = new RenderServiceClient(options);
  return client.probe();
}

/**
 * Renders an explainer bundle on the host service and verifies the artifacts in
 * the shared directory. Throws on any failure — never falls back to local render.
 */
export async function renderViaService(
  params: RenderViaServiceParams
): Promise<RenderExplainerVideoResult> {
  const client = new RenderServiceClient(params);
  const { explainerDir, timeline, outVideoPath, signal } = params;
  const totalFrames = Math.max(1, Math.round(timeline.totalDurationSec * timeline.fps));

  const jobId = await client.submit({
    explainerDir: path.resolve(explainerDir),
    gpu: params.gpu,
    crf: params.crf,
    preset: params.preset,
    fps: params.fps,
  });
  console.log(pc.cyan(`[render-service] job submitted: ${jobId} (${explainerDir})`));

  let cancelRequested = false;
  const onAbort = () => {
    cancelRequested = true;
    void client.cancel(jobId).catch((err) => {
      console.warn(pc.yellow(`[render-service] cancel failed for job ${jobId}: ${(err as Error).message}`));
    });
  };
  if (signal) {
    if (signal.aborted) {
      await client.cancel(jobId).catch(() => undefined);
      throw abortError();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const snapshot = await client.waitForCompletion(jobId, params.onProgress);

    if (cancelRequested || signal?.aborted) throw abortError();
    if (snapshot.state !== 'done') {
      throw new RenderServiceError(
        `[render-service] job ${jobId} finished in state "${snapshot.state}" (${snapshot.error || 'no error message'})`
      );
    }

    // The service writes artifacts straight into the shared explainerDir. Fall
    // back to the HTTP result endpoint only when the shared file is not visible
    // (e.g. the host and VM do not share the same path).
    const sharedVideo = path.resolve(
      snapshot.outputs?.video || path.join(explainerDir, 'explainer-video.mp4')
    );
    const resolvedOut = path.resolve(outVideoPath);
    let verifiedPath = sharedVideo;
    if (!fs.existsSync(sharedVideo)) {
      console.warn(
        pc.yellow(
          `[render-service] shared artifact not visible at ${sharedVideo} — downloading it over HTTP`
        )
      );
      await client.downloadResult(jobId, 'video', resolvedOut);
      verifiedPath = resolvedOut;
    }

    const verified = await verifyRenderedVideo({
      videoPath: verifiedPath,
      totalDurationSec: timeline.totalDurationSec,
      signal,
    });

    if (verifiedPath !== resolvedOut) {
      await fsp.mkdir(path.dirname(resolvedOut), { recursive: true });
      await fsp.copyFile(verifiedPath, resolvedOut);
    }

    const sharedGrid = path.resolve(
      snapshot.outputs?.grid || path.join(explainerDir, 'explainer-grid.jpg')
    );
    if (!fs.existsSync(sharedGrid) || (await fsp.stat(sharedGrid)).size === 0) {
      console.warn(
        pc.yellow('[render-service] grid preview missing from the host render (non-fatal)')
      );
    }

    console.log(
      pc.cyan(
        `[render-service] job ${jobId} done: ${snapshot.framesRendered}/${snapshot.totalFrames} frames, ` +
          `${verified.durationSec.toFixed(2)}s (${Math.round(verified.size / 1024)} KB)`
      )
    );

    const silentCandidate = path.join(explainerDir, 'explainer-silent.mp4');
    return {
      videoPath: resolvedOut,
      silentVideoPath: fs.existsSync(silentCandidate) ? silentCandidate : '',
      framesRendered: snapshot.framesRendered || totalFrames,
      totalFrames: snapshot.totalFrames || totalFrames,
      durationSec: verified.durationSec,
      engine: snapshot.engine === 'firefox' ? 'firefox' : 'chromium',
    };
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
