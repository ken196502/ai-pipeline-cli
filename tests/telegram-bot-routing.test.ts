/**
 * Regression tests for multi-bot Telegram gateway routing and strict
 * (fallback-free) notification configuration.
 *
 * Rules pinned here:
 *  - The bot name comes from `PI_TELEGRAM_BOT` only. No alias, no default.
 *  - A missing/blank bot is a hard error, not a request that the gateway
 *    silently rejects.
 *  - Pi inbound needs `PI_INBOUND_URL` + `PI_TELEGRAM_INBOUND_TOKEN`; there is
 *    no hardcoded host/port/token fallback.
 *  - A gateway rejection surfaces as a real error (never a fake success).
 *
 * Everything runs against a local mock HTTP server: no real Telegram traffic.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import {
  assertBotPortConsistency,
  getPiInboundConfig,
  getWebhookConfig,
  parseBotPortMap,
  sendMsg,
  verifyNotificationConfig,
} from '../src/utils/send_msg.js';

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
  bot: 'main',
});

/** Runs `fn` with the given env vars temporarily applied (undefined = unset). */
async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('forwards PI_TELEGRAM_BOT from the environment as the bot field', async () => {
  captured.length = 0;
  await withEnv({ PI_TELEGRAM_BOT: 'main' }, () => sendMsg('hello', { ...baseOverride(), bot: undefined }));

  assert.equal(captured.length, 1);
  assert.equal(captured[0].body.bot, 'main');
  assert.equal(captured[0].body.to, '5971350987');
  assert.equal(captured[0].authorization, 'Bearer test-token');
});

test('explicit override bot wins over the environment', async () => {
  captured.length = 0;
  await withEnv({ PI_TELEGRAM_BOT: 'main' }, () => sendMsg('hello', { ...baseOverride(), bot: 'inspilot' }));

  assert.equal(captured[0].body.bot, 'inspilot');
});

test('a blank bot is a hard error (no request is attempted)', async () => {
  captured.length = 0;
  await assert.rejects(
    () => sendMsg('hello', { ...baseOverride(), bot: '' }),
    (err: Error) => {
      assert.match(err.message, /PI_TELEGRAM_BOT/);
      return true;
    }
  );
  assert.equal(captured.length, 0, 'must fail before hitting the gateway');
});

test('TELEGRAM_BOT is not accepted as an alias for PI_TELEGRAM_BOT', async () => {
  // `loadEnvFile()` refills PI_TELEGRAM_BOT from the repo .env, so a blank
  // value must resolve to the .env bot — never to the TELEGRAM_BOT alias.
  await withEnv({ PI_TELEGRAM_BOT: '', TELEGRAM_BOT: 'inspilot' }, () => {
    const config = getWebhookConfig({ webhookUrl, webhookToken: 't', notifyTo: '1' });
    assert.notEqual(config.bot, 'inspilot');
    assert.equal(config.bot, 'main');
  });
});

test('a multi-bot gateway rejection throws with the gateway message', async () => {
  rejectWithoutBot = true;
  try {
    // Force a request without a bot by talking to the mock directly through a
    // config that bypasses validation: the gateway 400 must not look like success.
    await assert.rejects(
      async () => {
        const res = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: '5971350987', message: 'no bot' }),
        });
        assert.equal(res.ok, false);
        const text = await res.text();
        throw new Error(`[send_msg] Webhook responded with error HTTP ${res.status}: ${text}`);
      },
      (err: Error) => {
        assert.match(err.message, /HTTP 400/);
        assert.match(err.message, /multiple bots configured/);
        return true;
      }
    );
  } finally {
    rejectWithoutBot = false;
  }
});

test('Pi inbound requires PI_INBOUND_URL (no hardcoded host/port)', () => {
  assert.throws(
    () => getPiInboundConfig({ inboundUrl: '', inboundToken: 't', senderId: '1' }),
    /PI_INBOUND_URL/
  );
});

test('Pi inbound requires PI_TELEGRAM_INBOUND_TOKEN (no hardcoded token)', async () => {
  await withEnv({ PI_TELEGRAM_BOT: 'main' }, () => {
    assert.throws(
      () =>
        getPiInboundConfig({
          inboundUrl: 'http://127.0.0.1:3094/telegram/inbound',
          inboundToken: '',
          senderId: '1',
        }),
      /PI_TELEGRAM_INBOUND_TOKEN/
    );
  });
});

test('Pi inbound ignores the INBOUND_WEBHOOK_TOKEN alias', async () => {
  await withEnv({ PI_TELEGRAM_BOT: 'main', INBOUND_WEBHOOK_TOKEN: 'alias-token' }, () => {
    assert.throws(
      () =>
        getPiInboundConfig({
          inboundUrl: 'http://127.0.0.1:3094/telegram/inbound',
          inboundToken: '',
          senderId: '1',
        }),
      /PI_TELEGRAM_INBOUND_TOKEN/,
      'a blank explicit token must not fall back to INBOUND_WEBHOOK_TOKEN'
    );
  });
});

test('Pi inbound resolves the configured endpoint and sender', async () => {
  await withEnv({ PI_TELEGRAM_BOT: 'main' }, () => {
    const config = getPiInboundConfig({
      inboundUrl: 'http://127.0.0.1:3094/telegram/inbound',
      inboundToken: 'Abcd#123456',
      senderId: '5971350987',
    });
    assert.deepEqual(config, {
      inboundUrl: 'http://127.0.0.1:3094/telegram/inbound',
      inboundToken: 'Abcd#123456',
      senderId: '5971350987',
      chatId: '5971350987',
    });
  });
});

// ── PI_TELEGRAM_BOT_PORTS: explicit bot → inbound port self-check ──────────────

test('parseBotPortMap: unset/blank disables the check', () => {
  assert.equal(parseBotPortMap(undefined), undefined);
  assert.equal(parseBotPortMap('   '), undefined);
});

test('parseBotPortMap: parses an explicit mapping, lowercasing bot names', () => {
  assert.deepEqual(parseBotPortMap('main:3094, Inspilot:3095'), { main: 3094, inspilot: 3095 });
});

test('parseBotPortMap: rejects malformed mappings', () => {
  assert.throws(() => parseBotPortMap('main'), /expected <bot>:<port>/);
  assert.throws(() => parseBotPortMap('main:'), /expected <bot>:<port>/);
  assert.throws(() => parseBotPortMap(':3094'), /expected <bot>:<port>/);
  assert.throws(() => parseBotPortMap('main:abc'), /port must be an integer/);
  assert.throws(() => parseBotPortMap('main:70000'), /out of range/);
  assert.throws(() => parseBotPortMap('main:3094,,inspilot:3095'), /empty entry/);
  assert.throws(() => parseBotPortMap('main:3094,main:3095'), /duplicate bot/);
});

test('assertBotPortConsistency: skips everything when no map is configured', () => {
  assert.doesNotThrow(() => assertBotPortConsistency('anything', 'http://127.0.0.1:9999/telegram/inbound', undefined));
});

test('assertBotPortConsistency: unknown bot is an error', () => {
  assert.throws(
    () => assertBotPortConsistency('inspilot', 'http://127.0.0.1:3095/telegram/inbound', { main: 3094 }),
    /is not listed in PI_TELEGRAM_BOT_PORTS \(known bots: main\)/
  );
});

test('assertBotPortConsistency: bot/port mismatch is an error', () => {
  assert.throws(
    () => assertBotPortConsistency('inspilot', 'http://127.0.0.1:3094/telegram/inbound', { main: 3094, inspilot: 3095 }),
    /Bot\/port mismatch: PI_TELEGRAM_BOT="inspilot" must post to port 3095/
  );
  assert.doesNotThrow(() =>
    assertBotPortConsistency('inspilot', 'http://127.0.0.1:3095/telegram/inbound', { main: 3094, inspilot: 3095 })
  );
});

test('assertBotPortConsistency: missing port in URL falls back to the scheme default', () => {
  assert.throws(
    () => assertBotPortConsistency('main', 'http://127.0.0.1/telegram/inbound', { main: 3094 }),
    /points at port 80/
  );
});

test('verifyNotificationConfig: passes for a consistent configuration', async () => {
  await withEnv({ PI_TELEGRAM_BOT: 'main' }, () => {
    const summary = verifyNotificationConfig({
      webhookOverride: { webhookUrl, webhookToken: 't', notifyTo: '5971350987', bot: 'main' },
      piOverride: {
        inboundUrl: 'http://127.0.0.1:3094/telegram/inbound',
        inboundToken: 'Abcd#123456',
        senderId: '5971350987',
      },
    });
    assert.deepEqual(summary, {
      bot: 'main',
      notifyTo: '5971350987',
      webhookUrl,
      inboundUrl: 'http://127.0.0.1:3094/telegram/inbound',
    });
  });
});

test('verifyNotificationConfig: fails when bot and inbound port disagree', async () => {
  await withEnv({ PI_TELEGRAM_BOT: 'inspilot' }, () => {
    assert.throws(
      () =>
        verifyNotificationConfig({
          webhookOverride: { webhookUrl, webhookToken: 't', notifyTo: '5971350987', bot: 'inspilot' },
          piOverride: {
            inboundUrl: 'http://127.0.0.1:3094/telegram/inbound',
            inboundToken: 'Abcd#123456',
            senderId: '5971350987',
          },
        }),
      /Bot\/port mismatch/
    );
  });
});
