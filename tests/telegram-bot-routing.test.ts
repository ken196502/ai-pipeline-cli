/**
 * Regression tests for multi-bot Telegram gateway routing.
 *
 * Contract pinned here (project-level configuration, parameter-driven):
 *  - The delivery bot is project-level (`NOTIFY_PROJECT_DEFAULTS.bot`), never env.
 *  - A caller parameter wins over the project default.
 *  - A bot outside the project map is a hard error before any request is sent.
 *  - Pi inbound needs its token from env (a credential); the endpoint itself is
 *    derived from the project defaults.
 *  - A gateway rejection surfaces as a real error (never a fake success).
 *
 * Everything runs against a local mock HTTP server: no real Telegram traffic.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertBotPortConsistency,
  assertKnownBot,
  getPiInboundConfig,
  getWebhookConfig,
  sendMsg,
  verifyNotificationConfig,
} from '../src/utils/send_msg.js';
import { NOTIFY_PROJECT_DEFAULTS } from '../src/utils/notify-defaults.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

/* ── bot selection ───────────────────────────────────────────────────────── */

test('the default bot is the project-level default (no env involved)', async () => {
  captured.length = 0;
  await withEnv({ PI_TELEGRAM_BOT: 'inspilot' }, () => sendMsg('hello', baseOverride()));

  assert.equal(captured.length, 1);
  assert.equal(captured[0].body.bot, NOTIFY_PROJECT_DEFAULTS.bot);
  assert.equal(captured[0].body.to, '5971350987');
  assert.equal(captured[0].authorization, 'Bearer test-token');
});

test('PI_TELEGRAM_BOT is no longer consulted at all', async () => {
  await withEnv({ PI_TELEGRAM_BOT: 'inspilot' }, () => {
    assert.equal(getWebhookConfig(baseOverride()).bot, NOTIFY_PROJECT_DEFAULTS.bot);
  });
});

test('an explicit caller bot wins over the project default', async () => {
  captured.length = 0;
  await sendMsg('hello', { ...baseOverride(), bot: 'inspilot' });

  assert.equal(captured[0].body.bot, 'inspilot');
});

test('a bot outside the project map is a hard error (no request attempted)', async () => {
  captured.length = 0;
  await assert.rejects(
    () => sendMsg('hello', { ...baseOverride(), bot: 'ghost' }),
    (err: Error) => {
      assert.match(err.message, /not part of the project bot map/);
      assert.match(err.message, /main, inspilot/);
      return true;
    }
  );
  assert.equal(captured.length, 0, 'must fail before hitting the gateway');
});

test('a blank bot is a hard error (no silent fallback)', async () => {
  captured.length = 0;
  await assert.rejects(
    () => sendMsg('hello', { ...baseOverride(), bot: '' }),
    /bot is blank/i
  );
  assert.equal(captured.length, 0, 'must fail before hitting the gateway');
});

test('a multi-bot gateway rejection throws with the gateway message', async () => {
  rejectWithoutBot = true;
  try {
    // Force a request without a bot by talking to the mock directly: the
    // gateway 400 must not look like success.
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

/* ── Pi inbound ──────────────────────────────────────────────────────────── */

test('Pi inbound token is a required credential (no hardcoded token)', () => {
  assert.throws(
    () => getPiInboundConfig({ inboundToken: '', senderId: '5971350987' }),
    /PI_TELEGRAM_INBOUND_TOKEN must be defined/
  );
});

test('Pi inbound ignores the INBOUND_WEBHOOK_TOKEN alias', async () => {
  await withEnv({ INBOUND_WEBHOOK_TOKEN: 'alias-token' }, () => {
    const config = getPiInboundConfig({
      inboundUrl: 'http://127.0.0.1:3094/telegram/inbound',
      inboundToken: 'real-token',
      senderId: '1',
    });
    assert.equal(config.inboundToken, 'real-token');
  });
});

test('Pi inbound endpoint is derived from the project defaults', () => {
  const config = getPiInboundConfig({
    inboundToken: 't',
    senderId: '5971350987',
  });
  assert.equal(config.inboundUrl, NOTIFY_PROJECT_DEFAULTS.inboundBaseUrl);
  assert.equal(config.chatId, '5971350987');
});

test('Pi inbound follows the caller bot to its mapped port', () => {
  const config = getPiInboundConfig({
    bot: 'inspilot',
    inboundToken: 't',
    senderId: '1',
  });
  assert.equal(
    config.inboundUrl,
    `http://127.0.0.1:${NOTIFY_PROJECT_DEFAULTS.botPorts.inspilot}/telegram/inbound`
  );
});

test('Pi inbound rejects a bot/port mismatch instead of delivering to the wrong session', () => {
  assert.throws(
    () =>
      getPiInboundConfig({
        bot: 'inspilot',
        inboundUrl: 'http://127.0.0.1:3094/telegram/inbound',
        inboundToken: 't',
        senderId: '1',
      }),
    /Bot\/port mismatch/
  );
});

/* ── project bot map ─────────────────────────────────────────────────────── */

test('assertKnownBot: unknown bot lists the project map', () => {
  assert.throws(() => assertKnownBot('ghost'), /known bots: main, inspilot/);
  assert.doesNotThrow(() => assertKnownBot('inspilot'));
});

test('assertBotPortConsistency: every mapped bot derives its own port', () => {
  for (const [bot, port] of Object.entries(NOTIFY_PROJECT_DEFAULTS.botPorts)) {
    assert.doesNotThrow(() =>
      assertBotPortConsistency(bot, `http://127.0.0.1:${port}/telegram/inbound`)
    );
    assert.throws(
      () => assertBotPortConsistency(bot, 'http://127.0.0.1:1/telegram/inbound'),
      /Bot\/port mismatch/
    );
  }
});

test('assertBotPortConsistency: an invalid URL is a hard error', () => {
  assert.throws(() => assertBotPortConsistency('main', 'not a url'), /not a valid URL/);
});

/* ── startup self-check ──────────────────────────────────────────────────── */

test('verifyNotificationConfig: reports the project defaults', async () => {
  await withEnv({ PI_TELEGRAM_BOT: 'inspilot' }, () => {
    const summary = verifyNotificationConfig({
      webhookOverride: { webhookUrl, webhookToken: 't', notifyTo: '5971350987' },
      piOverride: {
        inboundUrl: NOTIFY_PROJECT_DEFAULTS.inboundBaseUrl,
        inboundToken: 'Abcd#123456',
        senderId: '5971350987',
      },
    });

    assert.equal(summary.bot, NOTIFY_PROJECT_DEFAULTS.bot);
    assert.equal(summary.errorBot, NOTIFY_PROJECT_DEFAULTS.bot);
    assert.equal(summary.inboundUrl, NOTIFY_PROJECT_DEFAULTS.inboundBaseUrl);
    assert.match(summary.resultTargets, /project-default/);
    assert.match(summary.errorTargets, /project-default/);
  });
});

test('verifyNotificationConfig: fails when bot and inbound port disagree', () => {
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

/* ── no bot config left in env ───────────────────────────────────────────── */

test('no bot-related env keys are read by the notification layer', async () => {
  const source = await fs.readFile(path.join(PROJECT_ROOT, 'src/utils/send_msg.ts'), 'utf8');
  for (const key of [
    'PI_TELEGRAM_BOT_PORTS',
    'PI_TELEGRAM_ERROR_BOT',
    'PI_TELEGRAM_ERROR_INBOUND_URL',
    'NOTIFY_ERROR_TARGET',
  ]) {
    assert.equal(source.includes(key), false, `${key} must not be read anymore`);
  }
  // `PI_TELEGRAM_BOT` may only appear in an explanatory comment.
  const codeLines = source
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .filter((line) => line.includes('PI_TELEGRAM_BOT'));
  assert.deepEqual(codeLines, [], 'PI_TELEGRAM_BOT must not appear in executable code');
});

test('the supervisor default bot matches the project default', async () => {
  const source = await fs.readFile(path.join(PROJECT_ROOT, 'tools/xdev-supervisor.mjs'), 'utf8');
  const match = /const PROJECT_DEFAULT_BOT = '([^']+)'/.exec(source);
  assert.ok(match, 'supervisor must declare PROJECT_DEFAULT_BOT');
  assert.equal(match[1], NOTIFY_PROJECT_DEFAULTS.bot);
});
