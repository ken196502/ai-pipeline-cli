/**
 * Integration test for renderViaService against a fake host render service
 * (Docs/plan-explainer-host-render-service.md §8.2).
 *
 * The fake service does not run a browser: it writes a pre-rendered MP4 into the
 * shared explainer directory, streams a few `progress` events over SSE, then
 * `done`. This exercises the real client path end-to-end: submit → progress
 * callbacks → artifact verification (ffprobe duration) → result.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { renderViaService, probeVideoDurationSec } from '../src/libs/player/render-service-client.js';

const execFileAsync = promisify(execFile);

const FIXTURE_SECONDS = 1;

async function makeFixtureVideo(filePath: string): Promise<void> {
  await execFileAsync('ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', `testsrc=size=320x180:rate=30`,
    '-t', String(FIXTURE_SECONDS),
    '-pix_fmt', 'yuv420p',
    '-c:v', 'libx264',
    filePath,
  ]);
}

test('renderViaService: submit → SSE progress → artifact verification', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'render-service-integration-'));
  const explainerDir = path.join(tmpDir, 'artifacts', 'run-1', 'explainer');
  const outVideoPath = path.join(tmpDir, 'vm-side', 'explainer-video.mp4');
  await fs.mkdir(path.join(explainerDir, 'assets'), { recursive: true });
  await fs.writeFile(path.join(explainerDir, 'explainer.json'), JSON.stringify({ fps: 30, totalDurationSec: FIXTURE_SECONDS }));
  await fs.writeFile(path.join(explainerDir, 'assets', 'narration.wav'), '');
  await makeFixtureVideo(path.join(tmpDir, 'fixture.mp4'));

  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    const url = req.url || '/';

    if (url === '/healthz') {
      const body = JSON.stringify({
        ok: true,
        version: '1.0.0',
        gpu: 'metal',
        browser: 'fake',
        busy: false,
        queueLen: 0,
        uptimeSec: 1,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }

    if (req.method === 'POST' && url === '/jobs') {
      req.resume();
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jobId: 'integration-job' }));
      return;
    }

    if (url === '/jobs/integration-job/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': connected\n\n');
      res.write('event: progress\ndata: {"framesRendered":10,"totalFrames":30,"fps":30}\n\n');
      void (async () => {
        await fs.copyFile(path.join(tmpDir, 'fixture.mp4'), path.join(explainerDir, 'explainer-video.mp4'));
        res.write('event: progress\ndata: {"framesRendered":30,"totalFrames":30,"fps":30}\n\n');
        res.write(
          'event: done\ndata: ' +
            JSON.stringify({
              jobId: 'integration-job',
              state: 'done',
              framesRendered: 30,
              totalFrames: 30,
              fps: 30,
              engine: 'chromium',
              gpu: 'metal',
              outputs: { video: path.join(explainerDir, 'explainer-video.mp4') },
            }) +
            '\n\n'
        );
        res.end();
      })();
      return;
    }

    if (url === '/jobs/integration-job') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jobId: 'integration-job',
          state: 'done',
          framesRendered: 30,
          totalFrames: 30,
          fps: 30,
          outputs: { video: path.join(explainerDir, 'explainer-video.mp4') },
        })
      );
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
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
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    assert.equal(
      (await (await fetch(`${baseUrl}/healthz`)).json() as { ok: boolean }).ok,
      true
    );

    const progress: Array<[number, number]> = [];
    const result = await renderViaService({
      baseUrl,
      token: 'test-token',
      explainerDir,
      timeline: {
        resolution: { width: 320, height: 180 },
        fps: 30,
        totalDurationSec: FIXTURE_SECONDS,
      },
      outVideoPath,
      pollIntervalMs: 20,
      onProgress: (rendered, total) => progress.push([rendered, total]),
    });

    assert.equal(result.videoPath, outVideoPath);
    assert.equal(result.framesRendered, 30);
    assert.equal(result.totalFrames, 30);
    assert.ok(result.durationSec > 0);
    assert.ok(progress.length >= 2);
    assert.deepEqual(progress[progress.length - 1], [30, 30]);

    const stat = await fs.stat(outVideoPath);
    assert.ok(stat.size > 0, 'video must be copied to the VM-side output path');
    const duration = await probeVideoDurationSec(outVideoPath);
    assert.ok(Math.abs(duration - FIXTURE_SECONDS) < 0.5, `unexpected duration ${duration}`);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
