/**
 * Regression tests for multi-bot Telegram gateway routing.
 *
 * A pi-telegram-server gateway configured with TELEGRAM_BOTS rejects every
 * outbound request that does not name a bot ("multiple bots configured").
 * These tests pin that `sendMsg` forwards the configured bot name and that a
 * gateway rejection surfaces as a real error instead of a silent success.
 *
 * Everything runs against a local mock HTTP server: no real Telegram traffic.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { getWebhookConfig, sendMsg } from '../src/utils/send_msg.js';

interface CapturedRequest {
  authorization: string;
  body: Record<string, unknown>;
}

const captured: CapturedRequest[] = [];
let server: http.Server;
let webhookUrl: string;
/** Set by a test to force the mock gateway to answer like a multi-bot gateway. */
let rejectWithoutBot = false;

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      captured.push({ authorization: String(req.headers.authorization || ''), body });

      if (rejectWithoutBot && !body.bot) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: false,
            error: 'multiple bots configured (main, inspilot); specify the bot in the request',
          })
        );
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, messageIds: [42], bot: body.bot ?? null }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock server failed to bind');
  webhookUrl = `http://127.0.0.1:${address.port}/webhook`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const baseOverride = () => ({
  webhookUrl,
  webhookToken: 'test-token',
  notifyTo: '5971350987',
});

test('forwards PI_TELEGRAM_BOT from the environment as the bot field', async () => {
  captured.length = 0;
  const previous = process.env.PI_TELEGRAM_BOT;
  process.env.PI_TELEGRAM_BOT = 'main';
  try {
    await sendMsg('hello', baseOverride());
  } finally {
    if (previous === undefined) delete process.env.PI_TELEGRAM_BOT;
    else process.env.PI_TELEGRAM_BOT = previous;
  }

  assert.equal(captured.length, 1);
  assert.equal(captured[0].body.bot, 'main');
  assert.equal(captured[0].body.to, '5971350987');
  assert.equal(captured[0].authorization, 'Bearer test-token');
});

test('explicit override bot wins over the environment', async () => {
  captured.length = 0;
  const previous = process.env.PI_TELEGRAM_BOT;
  process.env.PI_TELEGRAM_BOT = 'main';
  try {
    await sendMsg('hello', { ...baseOverride(), bot: 'inspilot' });
  } finally {
    if (previous === undefined) delete process.env.PI_TELEGRAM_BOT;
    else process.env.PI_TELEGRAM_BOT = previous;
  }

  assert.equal(captured[0].body.bot, 'inspilot');
});

test('omits the bot field when no bot is configured (single-bot gateways)', async () => {
  captured.length = 0;
  // Explicit blank override: `loadEnvFile()` repopulates PI_TELEGRAM_BOT from
  // the repo .env, so deleting the variable would not prove anything here.
  await sendMsg('hello', { ...baseOverride(), bot: '' });

  assert.equal('bot' in captured[0].body, false);
});

test('a multi-bot gateway rejection throws with the gateway message', async () => {
  rejectWithoutBot = true;
  try {
    await assert.rejects(
      () => sendMsg('hello', { ...baseOverride(), bot: '' }),
      (err: Error) => {
        assert.match(err.message, /HTTP 400/);
        assert.match(err.message, /multiple bots configured/);
        assert.match(err.message, /PI_TELEGRAM_BOT/);
        return true;
      }
    );
  } finally {
    rejectWithoutBot = false;
  }
});

test('getWebhookConfig ignores blank bot values instead of sending an empty name', () => {
  const previous = process.env.PI_TELEGRAM_BOT;
  process.env.PI_TELEGRAM_BOT = '   ';
  try {
    const config = getWebhookConfig(baseOverride());
    assert.equal(config.bot, undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_TELEGRAM_BOT;
    else process.env.PI_TELEGRAM_BOT = previous;
  }
});
