/**
 * Unit tests for the host render service client
 * (Docs/plan-explainer-host-render-service.md §8.1).
 *
 * Every fake server is created per test and closed in `finally`; sockets are
 * destroyed so a hanging health probe cannot keep the process alive.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  probeRenderService,
  RenderServiceClient,
  RenderServiceError,
  renderViaService,
} from '../src/libs/player/render-service-client.js';
import { renderExplainerVideo } from '../src/libs/player/render.js';

interface FakeServer {
  url: string;
  counts: Record<string, number>;
  close(): Promise<void>;
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<FakeServer> {
  const counts: Record<string, number> = {};
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    const key = `${req.method} ${req.url}`;
    counts[key] = (counts[key] ?? 0) + 1;
    handler(req, res);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    counts,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const HEALTHY = {
  ok: true,
  version: '1.0.0',
  gpu: 'metal',
  browser: 'chromium',
  busy: false,
  queueLen: 0,
  uptimeSec: 1,
};

test('probe: healthy /healthz returns true', async () => {
  const fake = await startServer((req, res) => {
    if (req.url === '/healthz') return json(res, 200, HEALTHY);
    json(res, 404, { error: 'not found' });
  });
  try {
    assert.equal(await probeRenderService({ baseUrl: fake.url, token: 'secret' }), true);
  } finally {
    await fake.close();
  }
});

test('probe: short timeout returns false', async () => {
  const fake = await startServer(() => {
    // Never respond: the client must give up on its own timeout.
  });
  try {
    const healthy = await probeRenderService({
      baseUrl: fake.url,
      token: 'secret',
      probeTimeoutMs: 120,
      retries: 1,
      retryBaseDelayMs: 10,
    });
    assert.equal(healthy, false);
  } finally {
    await fake.close();
  }
});

test('probe: non-200 returns false', async () => {
  const fake = await startServer((req, res) => {
    json(res, 503, { error: 'starting up' });
  });
  try {
    assert.equal(
      await probeRenderService({ baseUrl: fake.url, token: 'secret', retries: 0 }),
      false
    );
  } finally {
    await fake.close();
  }
});

test('probe: a single ECONNRESET is retried and then succeeds', async () => {
  let hits = 0;
  const fake = await startServer((req, res) => {
    hits += 1;
    if (hits === 1) {
      req.socket.destroy();
      return;
    }
    json(res, 200, HEALTHY);
  });
  try {
    const healthy = await probeRenderService({
      baseUrl: fake.url,
      token: 'secret',
      retries: 2,
      retryBaseDelayMs: 10,
    });
    assert.equal(healthy, true);
    assert.equal(hits, 2);
  } finally {
    await fake.close();
  }
});

test('submit + status polling: progress increases until done', async () => {
  let polls = 0;
  const fake = await startServer((req, res) => {
    if (req.method === 'POST' && req.url === '/jobs') {
      req.resume();
      return json(res, 202, { jobId: 'job-poll' });
    }
    if (req.url === '/jobs/job-poll/events') {
      // SSE not supported on this fake → the client must poll.
      res.writeHead(501);
      res.end();
      return;
    }
    if (req.url === '/jobs/job-poll') {
      polls += 1;
      if (polls < 3) {
        return json(res, 200, {
          jobId: 'job-poll',
          state: 'running',
          framesRendered: polls * 10,
          totalFrames: 30,
          fps: 30,
        });
      }
      return json(res, 200, {
        jobId: 'job-poll',
        state: 'done',
        framesRendered: 30,
        totalFrames: 30,
        fps: 30,
        outputs: { video: '/tmp/video.mp4' },
      });
    }
    json(res, 404, { error: 'not found' });
  });

  try {
    const client = new RenderServiceClient({
      baseUrl: fake.url,
      token: 'secret',
      pollIntervalMs: 10,
      retries: 0,
    });
    const jobId = await client.submit({ explainerDir: '/tmp/explainer' });
    assert.equal(jobId, 'job-poll');

    const progress: number[] = [];
    const snapshot = await client.waitForCompletion(jobId, (rendered) => progress.push(rendered));
    assert.equal(snapshot.state, 'done');
    assert.equal(snapshot.framesRendered, 30);
    assert.deepEqual(progress, [10, 20, 30]);
  } finally {
    await fake.close();
  }
});

test('SSE: progress events are forwarded and the terminal snapshot returned', async () => {
  let statusPolls = 0;
  const fake = await startServer((req, res) => {
    if (req.method === 'POST' && req.url === '/jobs') {
      req.resume();
      return json(res, 202, { jobId: 'job-sse' });
    }
    if (req.url === '/jobs/job-sse/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': connected\n\n');
      res.write('event: progress\ndata: {"framesRendered":10,"totalFrames":30,"fps":30}\n\n');
      res.write('event: progress\ndata: {"framesRendered":30,"totalFrames":30,"fps":30}\n\n');
      res.write(
        'event: done\ndata: {"jobId":"job-sse","state":"done","framesRendered":30,"totalFrames":30,"fps":30}\n\n'
      );
      res.end();
      return;
    }
    if (req.url === '/jobs/job-sse') {
      statusPolls += 1;
      return json(res, 200, { jobId: 'job-sse', state: 'running', framesRendered: 0, totalFrames: 30, fps: 30 });
    }
    json(res, 404, { error: 'not found' });
  });

  try {
    const client = new RenderServiceClient({ baseUrl: fake.url, token: 'secret', pollIntervalMs: 10 });
    const jobId = await client.submit({ explainerDir: '/tmp/explainer' });
    const progress: number[] = [];
    const snapshot = await client.waitForCompletion(jobId, (rendered) => progress.push(rendered));
    assert.equal(snapshot.state, 'done');
    assert.deepEqual(progress, [10, 30, 30]);
    assert.equal(statusPolls, 0, 'SSE success must not fall back to status polling');
  } finally {
    await fake.close();
  }
});

test('job error: thrown immediately and never retried', async () => {
  let polls = 0;
  const fake = await startServer((req, res) => {
    if (req.method === 'POST' && req.url === '/jobs') {
      req.resume();
      return json(res, 202, { jobId: 'job-error' });
    }
    if (req.url === '/jobs/job-error/events') {
      res.writeHead(501);
      res.end();
      return;
    }
    if (req.url === '/jobs/job-error') {
      polls += 1;
      return json(res, 200, {
        jobId: 'job-error',
        state: 'error',
        framesRendered: 3,
        totalFrames: 30,
        fps: 30,
        error: 'ffmpeg silent encode failed with exit code 1',
      });
    }
    json(res, 404, { error: 'not found' });
  });

  try {
    const client = new RenderServiceClient({
      baseUrl: fake.url,
      token: 'secret',
      pollIntervalMs: 10,
      retries: 3,
    });
    const jobId = await client.submit({ explainerDir: '/tmp/explainer' });
    await assert.rejects(
      () => client.waitForCompletion(jobId),
      (err: unknown) =>
        err instanceof RenderServiceError && /ffmpeg silent encode failed/.test((err as Error).message)
    );
    assert.equal(polls, 1, 'a failed job must not be polled again');
  } finally {
    await fake.close();
  }
});

test('HTTP 401 / 400 / 429 produce explicit errors', async () => {
  const statuses: Array<{ status: number; pattern: RegExp }> = [
    { status: 401, pattern: /401 unauthorized/ },
    { status: 400, pattern: /400 bad request/ },
    { status: 429, pattern: /429 queue full/ },
  ];

  for (const { status, pattern } of statuses) {
    const fake = await startServer((req, res) => {
      req.resume();
      json(res, status, { error: status === 429 ? 'queue full' : 'bad request' });
    });
    try {
      const client = new RenderServiceClient({ baseUrl: fake.url, token: 'wrong', retries: 0 });
      await assert.rejects(
        () => client.submit({ explainerDir: '/tmp/explainer' }),
        (err: unknown) => err instanceof RenderServiceError && pattern.test((err as Error).message)
      );
    } finally {
      await fake.close();
    }
  }
});

test('AbortSignal: aborts the wait and calls POST /jobs/:id/cancel', async () => {
  let cancelCount = 0;
  let resolveCancel: (() => void) | undefined;
  const cancelSeen = new Promise<void>((resolve) => {
    resolveCancel = resolve;
  });

  const fake = await startServer((req, res) => {
    if (req.method === 'POST' && req.url === '/jobs') {
      req.resume();
      return json(res, 202, { jobId: 'job-abort' });
    }
    if (req.url === '/jobs/job-abort/events') {
      res.writeHead(501);
      res.end();
      return;
    }
    if (req.url === '/jobs/job-abort/cancel') {
      cancelCount += 1;
      json(res, 200, { ok: true });
      resolveCancel?.();
      return;
    }
    if (req.url === '/jobs/job-abort') {
      return json(res, 200, {
        jobId: 'job-abort',
        state: 'running',
        framesRendered: 0,
        totalFrames: 30,
        fps: 30,
      });
    }
    json(res, 404, { error: 'not found' });
  });

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'render-service-abort-'));
  const controller = new AbortController();
  try {
    const renderPromise = renderViaService({
      baseUrl: fake.url,
      token: 'secret',
      explainerDir: path.join(tmpDir, 'explainer'),
      timeline: { resolution: { width: 1920, height: 1080 }, fps: 30, totalDurationSec: 1 },
      outVideoPath: path.join(tmpDir, 'out.mp4'),
      pollIntervalMs: 20,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 60);
    await assert.rejects(renderPromise, (err: unknown) => (err as Error).name === 'AbortError');
    await Promise.race([
      cancelSeen,
      new Promise((_, reject) => setTimeout(() => reject(new Error('cancel was not called')), 1000)),
    ]);
    assert.equal(cancelCount, 1);
  } finally {
    await fake.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// renderExplainerVideo routing (§5): configured-but-unhealthy must fail fast.
// ---------------------------------------------------------------------------

test('renderExplainerVideo: configured but unhealthy service fails fast (no local fallback)', async () => {
  const fake = await startServer((req, res) => {
    json(res, 503, { error: 'service is wedged' });
  });
  try {
    await assert.rejects(
      () =>
        renderExplainerVideo({
          explainerDir: '/tmp/does-not-matter-routing',
          timeline: { resolution: { width: 1920, height: 1080 }, fps: 30, totalDurationSec: 1 },
          narrationWavPath: '/tmp/does-not-matter.wav',
          outVideoPath: '/tmp/does-not-matter.mp4',
          renderService: { url: fake.url, token: 'secret', probeTimeoutMs: 300 },
        }),
      (err: unknown) =>
        err instanceof Error &&
        /CONFIGURED but UNHEALTHY/.test(err.message) &&
        /Refusing to silently fall back/.test(err.message)
    );
  } finally {
    await fake.close();
  }
});

test('renderExplainerVideo: configured service without a token fails fast', async () => {
  const previous = process.env.EXPLAINER_RENDER_SERVICE_TOKEN;
  delete process.env.EXPLAINER_RENDER_SERVICE_TOKEN;
  try {
    await assert.rejects(
      () =>
        renderExplainerVideo({
          explainerDir: '/tmp/does-not-matter-routing',
          timeline: { resolution: { width: 1920, height: 1080 }, fps: 30, totalDurationSec: 1 },
          narrationWavPath: '/tmp/does-not-matter.wav',
          outVideoPath: '/tmp/does-not-matter.mp4',
          renderService: { url: 'http://127.0.0.1:9', probeTimeoutMs: 100 },
        }),
      (err: unknown) => err instanceof Error && /no token is set/.test(err.message)
    );
  } finally {
    if (previous === undefined) delete process.env.EXPLAINER_RENDER_SERVICE_TOKEN;
    else process.env.EXPLAINER_RENDER_SERVICE_TOKEN = previous;
  }
});
