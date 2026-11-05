import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { notifyError } from '../src/utils/send_msg.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The bot→port mapping is project-level configuration now; the gateway resolves
 * the Pi WebSocket session from the bot name. Nothing in these tests talks to an
 * inbound HTTP port — that transport was removed with the gateway's 方案 C.
 */
const MOCK_PI_BOT = 'main';

interface CapturedRequest {
  url: string;
  authorization: string | undefined;
  body: any;
}

async function startMockServer(name: string): Promise<{
  url: string;
  port: number;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      let body: any = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
      requests.push({ url: req.url ?? '', authorization: req.headers.authorization, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, channel: name }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}/${name}`,
    port: address.port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('notifyError sends ONE gateway request that fans out to Telegram and Pi', async () => {
  const telegram = await startMockServer('webhook');
  // The old HTTP Pi-inbound transport: must stay silent, forever.
  const legacyInbound = await startMockServer('telegram/inbound');

  try {
    await notifyError('❌ Viral pipeline failed: no prompts extracted', {
      webhookOverride: {
        webhookUrl: telegram.url,
        webhookToken: 'tg-token',
        notifyTo: '5971350987',
        bot: MOCK_PI_BOT,
      },
    });

    // Gateway contract: to/message/bot + bearer token + the Pi fan-out flag.
    assert.equal(telegram.requests.length, 1);
    assert.equal(telegram.requests[0].authorization, 'Bearer tg-token');
    assert.equal(telegram.requests[0].body.to, '5971350987');
    assert.equal(telegram.requests[0].body.bot, MOCK_PI_BOT);
    assert.equal(telegram.requests[0].body.notifyPi, true);
    assert.match(telegram.requests[0].body.message, /Viral pipeline failed/);

    // No second leg: the gateway owns the WebSocket hop to the Pi session.
    assert.equal(
      legacyInbound.requests.length,
      0,
      'the pipeline must not POST to the removed HTTP Pi-inbound endpoint'
    );
  } finally {
    await telegram.close();
    await legacyInbound.close();
  }
});

test('notifyError reports a gateway failure instead of swallowing it', async () => {
  const failing = http.createServer((_req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'gateway down' }));
  });
  await new Promise<void>((resolve) => failing.listen(0, '127.0.0.1', resolve));
  const address = failing.address();
  assert.ok(address && typeof address === 'object');

  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: any[]) => {
    logged.push(args.map((a) => String(a)).join(' '));
  };

  try {
    await notifyError('❌ partial failure: 1 clip failed', {
      webhookOverride: {
        webhookUrl: `http://127.0.0.1:${address.port}/webhook`,
        webhookToken: 'tg-token',
        notifyTo: '5971350987',
        bot: MOCK_PI_BOT,
      },
    });

    assert.ok(
      logged.some((line) => /Failed to send alert \(Telegram \+ Pi\)/.test(line) && /HTTP 500/.test(line)),
      `a gateway failure must be logged loudly, got: ${JSON.stringify(logged)}`
    );
  } finally {
    console.error = originalError;
    await new Promise<void>((resolve) => failing.close(() => resolve()));
  }
});

/**
 * Regression guard for the actual bug: the flowTutor failure branch (and friends)
 * called `sendMsg(...)` — Telegram only — so the Pi agent never learned about
 * the failure. Error alerts must go through `notifyError` (dual channel).
 */
test('error paths use notifyError, never Telegram-only sendMsg', async () => {
  const guardedFiles = [
    'src/pipelines/flowtutor/cli.ts',
    'src/pipelines/xhot/cli.ts',
    'src/tutorial/cli.ts',
    'src/flow/cli.ts',
    'src/libs/browser/login-helper.ts',
    'src/modules/auth/auth.ts',
  ];

  // Error-shaped arguments that used to be passed to the Telegram-only helper.
  const forbidden = [
    /sendMsg\(\s*detailedMsg/,
    /sendMsg\(\s*alertMsg/,
    /sendMsg\(\s*msgLines\.join\(/,
    /sendMsg\(\s*timeoutMsg/,
  ];

  for (const rel of guardedFiles) {
    const source = await fs.readFile(path.join(PROJECT_ROOT, rel), 'utf8');
    for (const pattern of forbidden) {
      assert.ok(
        !pattern.test(source),
        `${rel}: error alert must use notifyError() (Telegram + Pi inbound), found ${pattern}`
      );
    }
  }
});
