import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { notifyError } from '../src/utils/send_msg.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The bot→port map and bot name come from the ambient environment / .env (and the
 * loader never overwrites an already-set variable, but treats an empty string as
 * unset). Pin them explicitly to the mock inbound port so the bot→port consistency
 * check runs against this test instead of the box's real 3094/3095 mapping.
 */
function pinBotPortMap(inboundPort: number): void {
  process.env.PI_TELEGRAM_BOT = 'main';
  process.env.PI_TELEGRAM_BOT_PORTS = `main:${inboundPort}`;
  delete process.env.WEBHOOK_URL;
  delete process.env.WEBHOOK_TOKEN;
  delete process.env.NOTIFY_TO;
  delete process.env.PI_INBOUND_URL;
  delete process.env.PI_TELEGRAM_INBOUND_TOKEN;
}

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

test('notifyError delivers the same failure to Telegram and Pi inbound', async () => {
  const telegram = await startMockServer('webhook');
  const pi = await startMockServer('telegram/inbound');
  pinBotPortMap(pi.port);

  try {
    await notifyError('❌ Viral pipeline failed: no prompts extracted', {
      webhookOverride: {
        webhookUrl: telegram.url,
        webhookToken: 'tg-token',
        notifyTo: '5971350987',
        bot: 'main',
      },
      piOverride: {
        inboundUrl: pi.url,
        inboundToken: 'pi-token',
        senderId: '5971350987',
        chatId: '5971350987',
      },
    });

    // Telegram channel: gateway contract (to/message/bot + bearer token).
    assert.equal(telegram.requests.length, 1);
    assert.equal(telegram.requests[0].authorization, 'Bearer tg-token');
    assert.equal(telegram.requests[0].body.to, '5971350987');
    assert.equal(telegram.requests[0].body.bot, 'main');
    assert.match(telegram.requests[0].body.message, /Viral pipeline failed/);

    // Pi channel: inbound contract (body/senderId/chatId + bearer token).
    assert.equal(pi.requests.length, 1);
    assert.equal(pi.requests[0].authorization, 'Bearer pi-token');
    assert.equal(pi.requests[0].body.senderId, '5971350987');
    assert.equal(pi.requests[0].body.chatId, '5971350987');
    assert.match(pi.requests[0].body.body, /Viral pipeline failed/);
    assert.equal(typeof pi.requests[0].body.timestamp, 'number');
  } finally {
    await telegram.close();
    await pi.close();
  }
});

test('notifyError still delivers to Telegram when the Pi inbound is unreachable', async () => {
  const telegram = await startMockServer('webhook');

  // Port 1 is never a Pi inbound listener.
  pinBotPortMap(1);
  try {
    await notifyError('❌ partial failure: 1 clip failed', {
      webhookOverride: {
        webhookUrl: telegram.url,
        webhookToken: 'tg-token',
        notifyTo: '5971350987',
        bot: 'main',
      },
      piOverride: {
        inboundUrl: 'http://127.0.0.1:1/telegram/inbound',
        inboundToken: 'pi-token',
        senderId: '5971350987',
        chatId: '5971350987',
      },
    });

    assert.equal(telegram.requests.length, 1);
    assert.match(telegram.requests[0].body.message, /partial failure/);
  } finally {
    await telegram.close();
  }
});

/**
 * Regression guard for the actual bug: the flowTutor (ex-ytbhot) failure branch (and friends)
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
