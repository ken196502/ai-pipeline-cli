/**
 * Tests for the `--notify` / `--notify-error` delivery-target override.
 *
 * Contract pinned here (project-level configuration, parameter-driven):
 *  - Default is the project bot (`NOTIFY_PROJECT_DEFAULTS.bot`); no env involved.
 *  - A parameter target wins over the project default and derives its Pi inbound
 *    port from the project bot map — never guessed.
 *  - An unknown bot or a malformed list is a hard error.
 *  - Several targets fan out, and a partial failure is a real failure.
 *  - `--notify-error` overrides only the error channel and defaults to `--notify`.
 *
 * Everything runs against a local mock HTTP server: no real Telegram traffic.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import {
  clearNotifyTargets,
  describeNotifyTargets,
  getErrorChannelOverride,
  getNotifyTargets,
  getPiInboundConfig,
  getWebhookConfig,
  notifyError,
  parseNotifyTargetList,
  resolveNotifyTargets,
  sendMsg,
  setNotifyTargets,
  withInboundPort,
} from '../src/utils/send_msg.js';
import { NOTIFY_PROJECT_DEFAULTS } from '../src/utils/notify-defaults.js';

interface Captured {
  body: Record<string, any>;
}

const captured: Captured[] = [];
let server: http.Server;
let webhookUrl: string;
/** Bot names the mock gateway refuses, to exercise partial-failure reporting. */
const rejectedBots = new Set<string>();

const savedEnv: Record<string, string | undefined> = {};
const CREDENTIAL_KEYS = ['WEBHOOK_URL', 'WEBHOOK_TOKEN', 'NOTIFY_TO', 'PI_TELEGRAM_INBOUND_TOKEN'];

before(async () => {
  for (const key of CREDENTIAL_KEYS) savedEnv[key] = process.env[key];

  server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      captured.push({ body });

      if (rejectedBots.has(String(body.bot))) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: `bot ${body.bot} unavailable` }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, messageIds: [captured.length] }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  webhookUrl = `http://127.0.0.1:${address.port}/webhook`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  clearNotifyTargets();
});

/** Pins only the credential env — bot routing comes from project config/params. */
function pinCredentials(): void {
  process.env.WEBHOOK_URL = webhookUrl;
  process.env.WEBHOOK_TOKEN = 'test-token';
  process.env.NOTIFY_TO = '5971350987';
  process.env.PI_TELEGRAM_INBOUND_TOKEN = 'test-token';
}

beforeEach(() => {
  captured.length = 0;
  rejectedBots.clear();
  clearNotifyTargets();
  pinCredentials();
});

const baseOverride = () => ({ webhookUrl, webhookToken: 'test-token', notifyTo: '5971350987' });

/* ── parsing ─────────────────────────────────────────────────────────────── */

test('parseNotifyTargetList: undefined means "no override"', () => {
  assert.deepEqual(parseNotifyTargetList(undefined), []);
});

test('parseNotifyTargetList: single bot, lowercased', () => {
  assert.deepEqual(parseNotifyTargetList('Inspilot'), ['inspilot']);
});

test('parseNotifyTargetList: several bots are deduped in order', () => {
  assert.deepEqual(parseNotifyTargetList('main, inspilot,MAIN'), ['main', 'inspilot']);
});

test('parseNotifyTargetList: blank value is a hard error', () => {
  assert.throws(() => parseNotifyTargetList('   '), /must not be blank/);
});

test('parseNotifyTargetList: empty entry is a hard error (typo, not "skip")', () => {
  assert.throws(() => parseNotifyTargetList('main,,inspilot'), /empty entry/);
  assert.throws(() => parseNotifyTargetList('main,'), /empty entry/);
});

test('parseNotifyTargetList: whitespace-separated names are rejected', () => {
  assert.throws(() => parseNotifyTargetList('main inspilot'), /whitespace/);
});

/* ── port derivation ─────────────────────────────────────────────────────── */

test('withInboundPort: swaps the port and keeps scheme/host/path', () => {
  assert.equal(
    withInboundPort('http://127.0.0.1:3094/telegram/inbound', 3095),
    'http://127.0.0.1:3095/telegram/inbound'
  );
});

test('withInboundPort: an invalid base URL is a hard error', () => {
  assert.throws(() => withInboundPort('not a url', 3095), /not a valid URL/);
});

/* ── target resolution ───────────────────────────────────────────────────── */

test('resolveNotifyTargets: no bots means no override', () => {
  assert.deepEqual(resolveNotifyTargets({ bots: [] }), []);
});

test('resolveNotifyTargets: uses the project bot map by default', () => {
  const targets = resolveNotifyTargets({ bots: ['main', 'inspilot'] });

  assert.deepEqual(targets, [
    {
      bot: 'main',
      inboundUrl: `http://127.0.0.1:${NOTIFY_PROJECT_DEFAULTS.botPorts.main}/telegram/inbound`,
    },
    {
      bot: 'inspilot',
      inboundUrl: `http://127.0.0.1:${NOTIFY_PROJECT_DEFAULTS.botPorts.inspilot}/telegram/inbound`,
    },
  ]);
});

test('resolveNotifyTargets: an explicit map/base overrides the project default', () => {
  const targets = resolveNotifyTargets({
    bots: ['other'],
    inboundUrl: 'http://10.0.0.5:8080/telegram/inbound',
    map: { other: 9999 },
  });
  assert.deepEqual(targets, [
    { bot: 'other', inboundUrl: 'http://10.0.0.5:9999/telegram/inbound' },
  ]);
});

test('resolveNotifyTargets: an unknown bot lists the project map', () => {
  assert.throws(
    () => resolveNotifyTargets({ bots: ['inspilto'] }),
    /not part of the project bot map.*main, inspilot/
  );
});

test('resolveNotifyTargets: an empty base URL is a hard error', () => {
  assert.throws(
    () => resolveNotifyTargets({ bots: ['inspilot'], inboundUrl: '   ' }),
    /inbound base URL is empty/
  );
});

/* ── process-level override ──────────────────────────────────────────────── */

test('setNotifyTargets: --notify wins over the project default', () => {
  setNotifyTargets({ result: 'inspilot' });

  assert.equal(getWebhookConfig(baseOverride()).bot, 'inspilot');
  assert.equal(
    getPiInboundConfig().inboundUrl,
    `http://127.0.0.1:${NOTIFY_PROJECT_DEFAULTS.botPorts.inspilot}/telegram/inbound`
  );
  assert.match(describeNotifyTargets('result'), /^inspilot \(http:\/\/127\.0\.0\.1:3095\//);
});

test('setNotifyTargets: --notify also moves the error channel', () => {
  setNotifyTargets({ result: 'inspilot' });

  const errorChannel = getErrorChannelOverride();
  assert.equal(errorChannel.webhookOverride?.bot, 'inspilot');
  assert.equal(errorChannel.targets?.length, 1);
  assert.equal(errorChannel.targets?.[0].bot, 'inspilot');
});

test('setNotifyTargets: --notify-error only moves the error channel', () => {
  setNotifyTargets({ error: 'inspilot' });

  // Results keep the project default...
  assert.deepEqual(getNotifyTargets('result'), []);
  assert.equal(getWebhookConfig(baseOverride()).bot, NOTIFY_PROJECT_DEFAULTS.bot);
  // ...errors follow the parameter.
  assert.equal(getErrorChannelOverride().webhookOverride?.bot, 'inspilot');
});

test('setNotifyTargets: --notify + --notify-error are independent', () => {
  setNotifyTargets({ result: 'main', error: 'inspilot' });

  assert.equal(getNotifyTargets('result')[0].bot, 'main');
  assert.equal(getNotifyTargets('error')[0].bot, 'inspilot');
});

test('clearNotifyTargets: falls back to the project default again', () => {
  setNotifyTargets({ result: 'inspilot' });
  clearNotifyTargets();

  assert.deepEqual(getNotifyTargets('result'), []);
  assert.equal(getWebhookConfig(baseOverride()).bot, NOTIFY_PROJECT_DEFAULTS.bot);
  assert.equal(getPiInboundConfig().inboundUrl, NOTIFY_PROJECT_DEFAULTS.inboundBaseUrl);
  assert.match(describeNotifyTargets('result'), /project-default/);
});

test('an explicit caller bot still beats --notify', async () => {
  setNotifyTargets({ result: 'inspilot' });
  await sendMsg('hello', { ...baseOverride(), bot: 'main' });

  assert.equal(captured.length, 1);
  assert.equal(captured[0].body.bot, 'main');
});

/* ── fan-out ─────────────────────────────────────────────────────────────── */

test('sendMsg: several --notify targets fan out', async () => {
  setNotifyTargets({ result: 'main,inspilot' });
  await sendMsg('hello', baseOverride());

  assert.equal(captured.length, 2);
  assert.deepEqual(
    captured.map((c) => c.body.bot).sort(),
    ['inspilot', 'main']
  );
  for (const c of captured) {
    assert.equal(c.body.to, '5971350987');
    assert.equal(c.body.message, 'hello');
  }
});

test('sendMsg: a failing target is a real failure, not a silent partial success', async () => {
  setNotifyTargets({ result: 'main,inspilot' });
  rejectedBots.add('inspilot');

  await assert.rejects(
    () => sendMsg('hello', baseOverride()),
    (err: Error) => {
      assert.match(err.message, /1\/2 delivery target\(s\) failed/);
      assert.match(err.message, /inspilot/);
      return true;
    }
  );
});

test('notifyError: fans out on the Telegram leg and exposes one Pi target per bot', async () => {
  setNotifyTargets({ result: 'main,inspilot' });

  await notifyError('boom', { webhookOverride: baseOverride() });

  const telegram = captured.filter((c) => typeof c.body.bot === 'string');
  assert.deepEqual(
    telegram.map((c) => c.body.bot).sort(),
    ['inspilot', 'main']
  );

  // The Pi-inbound leg cannot be pointed at the mock port (that would break the
  // project bot/port consistency check), so assert the resolved targets instead.
  const targets = getErrorChannelOverride().targets ?? [];
  assert.deepEqual(
    targets.map((t) => t.inboundUrl).sort(),
    [
      `http://127.0.0.1:${NOTIFY_PROJECT_DEFAULTS.botPorts.inspilot}/telegram/inbound`,
      `http://127.0.0.1:${NOTIFY_PROJECT_DEFAULTS.botPorts.main}/telegram/inbound`,
    ].sort()
  );
});
