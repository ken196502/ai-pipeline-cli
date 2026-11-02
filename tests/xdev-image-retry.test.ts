import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { generateImageFromEnv } from '../src/pipelines/xdev/image-generator.js';

// 1x1 transparent PNG
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

interface Stub {
  url: string;
  requests: number;
  close: () => Promise<void>;
}

/**
 * Stub gateway. `handler` decides the answer per request; the counter proves how
 * many attempts the retry wrapper actually made.
 */
async function stubGateway(
  handler: (index: number, req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<Stub> {
  let requests = 0;
  const server = http.createServer((req, res) => {
    // Drain the body so the socket is fully read before answering.
    req.on('data', () => {});
    req.on('end', () => handler(requests++, req, res));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    get requests() {
      return requests;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function useGateway(stub: Stub): void {
  process.env.BASE_URL = stub.url;
  process.env.API_KEY = 'stub-key';
  process.env.IMAGE_MODEL = 'stub-image';
  // Keep the retry waits out of the test runtime; production defaults stay 2s/6s.
  process.env.IMAGE_RETRY_BACKOFF_MS = '10,10';
}

async function tempOutput(name: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xdev-image-retry-'));
  return path.join(dir, name);
}

const respondImage = (_index: number, _req: http.IncomingMessage, res: http.ServerResponse): void => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ created: 1, data: [{ b64_json: PNG_B64 }] }));
};

test('a socket closed by the peer is retried and the image still lands on disk', async () => {
  const stub = await stubGateway((index, _req, res) => {
    if (index < 2) {
      // Same signature the production incident left behind: bytesRead 0.
      res.socket?.destroy();
      return;
    }
    respondImage(index, _req, res);
  });
  useGateway(stub);
  const outputPath = await tempOutput('header.png');
  try {
    const result = await generateImageFromEnv({ prompt: 'a red cube', outputPath });
    assert.equal(result.outputPath, outputPath);
    assert.equal(stub.requests, 3, 'two resets then one success must cost exactly three requests');
    const written = await fs.readFile(outputPath);
    assert.deepEqual(written, Buffer.from(PNG_B64, 'base64'));
  } finally {
    await stub.close();
  }
});

test('a gateway rejection is never retried and keeps the gateway message', async () => {
  const stub = await stubGateway((_index, _req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'model stub-image is not supported' } }));
  });
  useGateway(stub);
  const outputPath = await tempOutput('header.png');
  try {
    await assert.rejects(
      () => generateImageFromEnv({ prompt: 'a red cube', outputPath }),
      (error: Error) => {
        assert.match(error.message, /model stub-image is not supported/);
        return true;
      }
    );
    assert.equal(stub.requests, 1, 'a 4xx must not be retried');
    await assert.rejects(() => fs.readFile(outputPath));
  } finally {
    await stub.close();
  }
});

test('every attempt dying on the socket reports the attempt count and the cause', async () => {
  const stub = await stubGateway((_index, _req, res) => {
    res.socket?.destroy();
  });
  useGateway(stub);
  const outputPath = await tempOutput('header.png');
  try {
    await assert.rejects(
      () => generateImageFromEnv({ prompt: 'a red cube', outputPath }),
      (error: Error) => {
        assert.match(error.message, /failed after 3 transport attempt\(s\)/);
        assert.match(error.message, /UND_ERR_SOCKET/);
        assert.match(error.message, /other side closed/);
        return true;
      }
    );
    assert.equal(stub.requests, 3);
  } finally {
    await stub.close();
  }
});
