#!/usr/bin/env node
/**
 * xdev supervisor — runs the full xdev pipeline and pushes EVERY error back to Pi.
 *
 * Why this exists
 * ---------------
 * The pipeline only alerts from its own top-level `catch`. Anything that happens
 * outside that try block (process kill, OOM, an unhandled rejection, a hung
 * browser, a swallowed `console.warn` degradation) used to die silently inside a
 * tmux session — the user saw nothing.
 *
 * Delivery channel
 * ----------------
 * `send_msg.ts::sendToPi()` posts to the project-level Pi inbound endpoint
 * (`src/utils/notify-defaults.ts`, port 3094 by default), which no longer
 * exists: the gateway moved to "方案 C" where Pi connects *out* to
 * `ws://127.0.0.1:3093/inbound`. The only channel that actually reaches the Pi
 * session is the gateway webhook: POST /webhook with `bot: inspilot`, which the
 * gateway delivers as a Telegram message to the bot that owns the Pi session.
 * That is what this supervisor uses, and it is the same leg the pipeline's own
 * notifyError() already proves works.
 *
 * Guarantees
 * ----------
 *   1. Pre-flight Grok smoke test (skippable) so a broken Grok path fails in ~90s.
 *   2. Every hard-error line in the child's output is pushed immediately (deduped,
 *      rate-limited, max 6 per run).
 *   3. Stall detection (10 min of silence) and a hard wall-clock timeout (60 min).
 *   4. Exit summary: success or failure, always delivered — with retries, and with
 *      an on-disk marker file if delivery keeps failing (never silent).
 *
 * Usage:
 *   node tools/xdev-supervisor.mjs                          # → project default bot
 *   node tools/xdev-supervisor.mjs --notify inspilot
 *   node tools/xdev-supervisor.mjs --notify main,inspilot
 *   node tools/xdev-supervisor.mjs --notify main --notify-error inspilot
 *   XDEV_SKIP_SMOKE=1 XDEV_MAX_RUNTIME_MIN=45 node tools/xdev-supervisor.mjs
 *
 * The delivery bot is project-level configuration
 * (`src/utils/notify-defaults.ts`, default `main`), overridable by `--notify`.
 * No bot is read from env. `--notify` also propagates to the child pipeline, so
 * run results and errors land in the same chat. See the CONFIG comment below.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(REPO_DIR, 'artifacts/xdev');
// Supervisor-level logs and alerts are not run outputs, so they get their own folder.
const SUPERVISOR_DIR = path.join(OUT_DIR, '_supervisor');
const TSX = path.join(REPO_DIR, 'node_modules/.bin/tsx');

const ANSI = /\u001b\[[0-9;]*m/g;
const stripAnsi = (s) => s.replace(ANSI, '');

/* ── config ──────────────────────────────────────────────────────────────── */

function loadEnvFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.join(REPO_DIR, '.env'));

/* ── CLI args (--notify / --notify-error) ────────────────────────────────── */

/** Reads `--flag value` or `--flag=value`; a flag without a value is a hard error. */
function readFlag(argv, name) {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  const value = argv[idx + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error(`[supervisor] FATAL: --${name} requires a value (e.g. --${name} inspilot)`);
    process.exit(78);
  }
  return value;
}

/**
 * Project default bot. MUST stay in sync with
 * `src/utils/notify-defaults.ts` → `NOTIFY_PROJECT_DEFAULTS.bot`
 * (guarded by tests/notify-target.test.ts).
 */
const PROJECT_DEFAULT_BOT = 'main';

/** `inspilot` / `main,inspilot` → lowercase, deduped bot names. Typos fail loudly. */
function parseBotList(raw, flag) {
  if (raw === undefined) return [];
  if (!raw.trim()) {
    console.error(`[supervisor] FATAL: --${flag} must not be blank`);
    process.exit(78);
  }
  const bots = [];
  for (const entry of raw.split(',')) {
    const name = entry.trim().toLowerCase();
    if (!name || /\s/.test(name)) {
      console.error(`[supervisor] FATAL: --${flag} entry "${entry}" is not a bot name`);
      process.exit(78);
    }
    if (!bots.includes(name)) bots.push(name);
  }
  return bots;
}

const ARGV = process.argv.slice(2);
const ARG_NOTIFY = readFlag(ARGV, 'notify');
const ARG_NOTIFY_ERROR = readFlag(ARGV, 'notify-error');

// No target passed → project default. Nothing is read from env.
const NOTIFY_BOT_NAMES =
  ARG_NOTIFY !== undefined ? parseBotList(ARG_NOTIFY, 'notify') : [PROJECT_DEFAULT_BOT];
const NOTIFY_ERROR_BOT_NAMES =
  ARG_NOTIFY_ERROR !== undefined ? parseBotList(ARG_NOTIFY_ERROR, 'notify-error') : NOTIFY_BOT_NAMES;

const CONFIG = {
  webhookUrl: process.env.WEBHOOK_URL,
  webhookToken: process.env.WEBHOOK_TOKEN,
  notifyTo: process.env.NOTIFY_TO || process.env.TELEGRAM_TO,
  // Bots that own the Pi sessions these alerts must land in.
  //
  // Project default unless `--notify` says otherwise. The supervisor only needs
  // the bot *name* (the gateway resolves the port and injects into Pi via
  // `notifyPi: true`), so the port map is not duplicated here — the child
  // pipeline owns that single source of truth.
  notifyBots: NOTIFY_BOT_NAMES.map((bot) => ({ bot })),
  notifyErrorBots: NOTIFY_ERROR_BOT_NAMES.map((bot) => ({ bot })),
  maxRuntimeMin: Number(process.env.XDEV_MAX_RUNTIME_MIN || 60),
  skipSmoke: process.env.XDEV_SKIP_SMOKE === '1',
};

// `--notify-error` may name bots outside the result list; keep one flat send list.
const ALL_ALERT_BOTS = [];
for (const target of [...CONFIG.notifyBots, ...CONFIG.notifyErrorBots]) {
  if (!ALL_ALERT_BOTS.some((t) => t.bot === target.bot)) ALL_ALERT_BOTS.push(target);
}
CONFIG.alertBots = ALL_ALERT_BOTS;

// The child pipeline must route its own alerts to the same place as this supervisor.
// One mechanism only: the CLI flags (authoritative inside src/cli.ts).
const NOTIFY_ARGS = ['--notify', CONFIG.notifyBots.map((t) => t.bot).join(',')];
if (ARG_NOTIFY_ERROR !== undefined) {
  NOTIFY_ARGS.push('--notify-error', CONFIG.notifyErrorBots.map((t) => t.bot).join(','));
}

for (const [name, value] of Object.entries({
  WEBHOOK_URL: CONFIG.webhookUrl,
  WEBHOOK_TOKEN: CONFIG.webhookToken,
  NOTIFY_TO: CONFIG.notifyTo,
})) {
  if (!value || !String(value).trim()) {
    console.error(`[supervisor] FATAL: missing required env ${name} (see AIGC-pipeline/.env)`);
    process.exit(78);
  }
}

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_PATH = path.join(SUPERVISOR_DIR, 'run-' + RUN_ID + '.log');
const MANIFEST_PATH = path.join(SUPERVISOR_DIR, 'supervisor-' + RUN_ID + '.json');

const state = {
  runId: RUN_ID,
  startedAt: new Date().toISOString(),
  pid: null,
  phase: 'init',
  currentStage: null,
  exitCode: null,
  alertsSent: 0,
  alertsFailed: 0,
  immediateAlerts: 0,
  errorLines: [],
  logPath: LOG_PATH,
  finishedAt: null,
};

/* ── logging ─────────────────────────────────────────────────────────────── */

let logStream = null;
function log(line) {
  const clean = stripAnsi(String(line));
  if (logStream) logStream.write(clean + '\n');
  console.log(clean);
}

/* ── alert delivery ──────────────────────────────────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Delivers one message to one bot, with retries. Returns null on success, else the error. */
async function deliverToBot(target, message, { title } = {}) {
  const body = {
    to: CONFIG.notifyTo,
    bot: target.bot,
    message,
    notifyPi: true,
  };

  const delays = [0, 1000, 3000, 7000];
  let lastErr = null;

  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt]) await sleep(delays[attempt]);
    try {
      const res = await fetch(CONFIG.webhookUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CONFIG.webhookToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
      }
      state.alertsSent += 1;
      log(`[supervisor] ✔ alert delivered (${title || 'alert'}) via bot=${target.bot}`);
      return null;
    } catch (err) {
      lastErr = err;
      log(`[supervisor] alert attempt ${attempt + 1}/${delays.length} failed (bot=${target.bot}): ${err?.message || err}`);
    }
  }

  return lastErr;
}

/**
 * Delivers an alert to every configured target (`--notify` + `--notify-error`).
 * A target that never accepts the message leaves an on-disk marker: a lost
 * alert must never be silent.
 */
async function deliverAlert(message, { title } = {}) {
  const failures = [];

  for (const target of CONFIG.alertBots) {
    const err = await deliverToBot(target, message, { title });
    if (err) failures.push({ target, err });
  }

  if (failures.length === 0) return true;

  state.alertsFailed += failures.length;
  const marker = path.join(SUPERVISOR_DIR, 'ALERT-DELIVERY-FAILED-' + RUN_ID + '.txt');
  const content = [
    `# ALERT DELIVERY FAILED — ${new Date().toISOString()}`,
    `title: ${title || 'alert'}`,
    `webhook: ${CONFIG.webhookUrl} to=${CONFIG.notifyTo}`,
    `targets: ${CONFIG.alertBots.map((t) => t.bot).join(', ')}`,
    `failed: ${failures.map((f) => `${f.target.bot} (${f.err?.message || f.err})`).join(' | ')}`,
    '',
    '## Undelivered message',
    message,
    '',
  ].join('\n');
  await fsp.mkdir(SUPERVISOR_DIR, { recursive: true });
  await fsp.appendFile(marker, content, 'utf-8');
  console.error(`[supervisor] ✗ ALERT DELIVERY FAILED for ${failures.length}/${CONFIG.alertBots.length} target(s) -> ${marker}`);
  return false;
}

const GUARD = '\n\n_（自动告警：处理前请先确认 tmux 会话 `xdev-full` 状态，勿重复启动 pipeline。）_';

function buildAlert(header, detail) {
  const parts = [header, ''];
  if (state.currentStage) parts.push(`• 当前阶段: \`${state.currentStage}\``);
  parts.push(`• 运行 ID: \`${state.runId}\``);
  parts.push(`• 日志: \`${state.logPath}\``);
  if (detail) parts.push('', detail);
  let msg = parts.join('\n') + GUARD;
  if (msg.length > 3800) msg = msg.slice(0, 3600) + '\n…（已截断，完整内容见日志）' + GUARD;
  return msg;
}

/* ── child process ───────────────────────────────────────────────────────── */

const tail = [];
let tailBytes = 0;
const TAIL_LINES = 200;

function pushTail(line) {
  tail.push(line);
  tailBytes += line.length;
  while (tail.length > TAIL_LINES || tailBytes > 40000) {
    const dropped = tail.shift();
    if (dropped === undefined) break;
    tailBytes -= dropped.length;
  }
}

/** Error signatures worth an immediate push. */
const HARD_ERROR = [
  /💥/, // pipeline's own fatal marker
  /failed at \[/, // "xdev Pipeline failed at [stage]"
  /^\s*Error:\s/,
  /Uncaught|UnhandledPromiseRejection|unhandledRejection/,
  /\bFATAL\b/,
  /✗/,
  /throw(n)?\b.*\bError\b/,
  /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up/,
];

/** Known noise that must not page the user. */
const NOISE = [
  /rate limited \(HTTP 429\)/,
  /Failed to send to Pi: fetch failed/, // legacy dead HTTP inbound leg
  /\[sendToPi\] Warning/,
  /sendChatAction failed/,
  /retry \d+\/\d+/,
];

const seenErrorKeys = new Set();
let lastAlertAt = 0;
const MAX_IMMEDIATE_ALERTS = 6;
const MIN_ALERT_GAP_MS = 5000;
let alertQueue = Promise.resolve();

function isHardError(line) {
  if (NOISE.some((re) => re.test(line))) return false;
  return HARD_ERROR.some((re) => re.test(line));
}

function dedupeKey(line) {
  return line
    .replace(/[0-9a-f]{8,}/gi, '<hex>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function queueAlert(message, title) {
  alertQueue = alertQueue.then(async () => {
    const gap = Date.now() - lastAlertAt;
    if (gap < MIN_ALERT_GAP_MS) await sleep(MIN_ALERT_GAP_MS - gap);
    lastAlertAt = Date.now();
    await deliverAlert(message, { title });
  });
  return alertQueue;
}

function onLine(rawLine) {
  const line = stripAnsi(rawLine).replace(/\r$/, '');
  if (!line.trim()) return;
  lastOutputAt = Date.now();
  log(line);
  pushTail(line);

  const stage = line.match(/\[Stage (\d)\/7\]\s*(.*)/);
  if (stage) state.currentStage = `Stage ${stage[1]}/7 ${stage[2]}`.trim();

  if (!isHardError(line)) return;

  const key = dedupeKey(line);
  if (seenErrorKeys.has(key)) return;
  seenErrorKeys.add(key);
  state.errorLines.push({ at: new Date().toISOString(), line });

  if (state.immediateAlerts >= MAX_IMMEDIATE_ALERTS) {
    if (state.immediateAlerts === MAX_IMMEDIATE_ALERTS) {
      state.immediateAlerts += 1; // one-shot notice
      queueAlert(
        buildAlert('⚠️ *xdev 运行中错误已达上限*', `已推送 ${MAX_IMMEDIATE_ALERTS} 条即时错误告警，后续同类错误只写入日志。`),
        'alert-limit'
      );
    }
    return;
  }

  state.immediateAlerts += 1;
  queueAlert(buildAlert('🚨 *xdev 运行中错误*', '```text\n' + line.slice(0, 1200) + '\n```'), 'runtime-error');
}

/* ── phase runner ────────────────────────────────────────────────────────── */

function runPhase(cmd, args, { label, timeoutMs }) {
  return new Promise((resolve) => {
    log(`\n[supervisor] ===== ${label} =====`);
    log(`[supervisor] $ ${cmd} ${args.join(' ')}`);

    const child = spawn(cmd, args, {
      cwd: REPO_DIR,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group, so a stuck browser tree can be killed as a unit
    });
    state.pid = child.pid;
    childPid = child.pid;

    let killedForTimeout = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          killedForTimeout = true;
          log(`[supervisor] ⏱ ${label} exceeded ${(timeoutMs / 60000).toFixed(0)} min — sending SIGTERM`);
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 20000).unref();
        }, timeoutMs)
      : null;

    const handle = (chunk) => {
      const text = chunk.toString();
      for (const line of text.split('\n')) onLine(line);
    };

    child.stdout.on('data', handle);
    child.stderr.on('data', handle);

    child.on('error', (err) => {
      log(`[supervisor] ✗ spawn error: ${err.message}`);
    });

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      log(`[supervisor] ${label} exited code=${code} signal=${signal || '-'}`);
      resolve({ code, signal, killedForTimeout });
    });
  });
}

/* ── stall watchdog ──────────────────────────────────────────────────────── */

let lastOutputAt = Date.now();
const STALL_MS = 10 * 60 * 1000;
let stallAlerted = false;

const watchdog = setInterval(() => {
  if (stallAlerted) return;
  const silentFor = Date.now() - lastOutputAt;
  if (silentFor < STALL_MS) return;
  stallAlerted = true;
  queueAlert(
    buildAlert(
      '🐌 *xdev 疑似卡死*',
      `已连续 ${Math.round(silentFor / 60000)} 分钟无任何输出（进程 PID ${state.pid} 仍存活）。` +
        '常见原因：浏览器挂死 / Grok 流式响应不结束 / 网络等待。'
    ),
    'stall'
  );
}, 30000);
watchdog.unref();

/* ── signal handling ─────────────────────────────────────────────────────── */

let childPid = null;
let shuttingDown = false;

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`[supervisor] received ${sig} — terminating child`);
    if (childPid) {
      try {
        process.kill(-childPid, 'SIGTERM');
      } catch {
        try {
          process.kill(childPid, 'SIGTERM');
        } catch {}
      }
    }
  });
}

/* ── main ────────────────────────────────────────────────────────────────── */

function newestArtifacts(sinceMs) {
  try {
    // Pipeline outputs live in per-run subdirectories; `_supervisor` holds logs only.
    const dirs = [OUT_DIR];
    for (const d of fs.readdirSync(OUT_DIR, { withFileTypes: true })) {
      if (d.isDirectory() && !d.name.startsWith('_')) dirs.push(path.join(OUT_DIR, d.name));
    }
    return dirs
      .flatMap((dir) =>
        fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((f) => f.isFile() && /^multi-agent-thinking-.*\.(html|md)$/.test(f.name))
          .map((f) => path.join(dir, f.name))
      )
      .map((p) => ({ f: p, m: fs.statSync(p).mtimeMs }))
      .filter((x) => x.m >= sinceMs)
      .sort((a, b) => b.m - a.m)
      .map((x) => x.f);
  } catch {
    return [];
  }
}

async function main() {
  await fsp.mkdir(SUPERVISOR_DIR, { recursive: true });
  logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });

  log(`[supervisor] xdev full run — runId=${RUN_ID}`);
  log(`[supervisor] repo=${REPO_DIR}`);
  log(`[supervisor] alert channel: ${CONFIG.webhookUrl} bots=${CONFIG.alertBots.map((t) => t.bot).join(',')} to=${CONFIG.notifyTo}`);
  log(`[supervisor] max runtime: ${CONFIG.maxRuntimeMin} min, smoke: ${CONFIG.skipSmoke ? 'skipped' : 'enabled'}`);

  const runStart = Date.now();
  const maxRuntimeMs = CONFIG.maxRuntimeMin * 60 * 1000;

  // ── Phase 0: Grok pre-flight ────────────────────────────────────────────
  if (!CONFIG.skipSmoke) {
    state.phase = 'smoke';
    const smoke = await runPhase(TSX, ['tools/xdev-grok-smoke.ts'], {
      label: 'Phase 0: Grok smoke test',
      timeoutMs: 6 * 60 * 1000,
    });

    if (smoke.code !== 0) {
      state.phase = 'smoke-failed';
      state.exitCode = smoke.code ?? 1;
      state.finishedAt = new Date().toISOString();
      await queueAlert(
        buildAlert(
          '🚨 *xdev 前置冒烟失败 — 主流程未启动*',
          '```text\n' + tail.slice(-25).join('\n').slice(-1500) + '\n```'
        ),
        'smoke-failed'
      );
      return;
    }
  }

  // ── Phase 1: the real pipeline ──────────────────────────────────────────
  state.phase = 'pipeline';
  lastOutputAt = Date.now();
  const pipeline = await runPhase(TSX, ['src/cli.ts', 'xdev', ...NOTIFY_ARGS], {
    label: 'Phase 1: xdev pipeline (full)',
    timeoutMs: maxRuntimeMs,
  });

  state.exitCode = pipeline.code ?? (pipeline.signal ? 1 : 0);
  state.phase = state.exitCode === 0 ? 'completed' : 'failed';
  state.finishedAt = new Date().toISOString();

  const elapsed = ((Date.now() - runStart) / 1000).toFixed(0);

  if (state.exitCode === 0) {
    const arts = newestArtifacts(runStart - 5000);
    const list = arts.length
      ? arts.map((a) => '`' + path.basename(a) + '`').join('\n')
      : '（未发现本次新增的 multi-agent-thinking-* 产物，请检查日志）';
    await queueAlert(
      buildAlert(
        '✅ *xdev 全流程跑完*',
        `• 耗时: ${elapsed}s\n• 产物:\n${list}\n• 告警: ${state.alertsSent} 条（运行中错误 ${state.errorLines.length} 处）`
      ),
      'success'
    );
  } else {
    const reason = pipeline.killedForTimeout
      ? `超时 ${CONFIG.maxRuntimeMin} 分钟被强制终止`
      : pipeline.signal
        ? `进程被信号 ${pipeline.signal} 终止`
        : `退出码 ${state.exitCode}`;
    const errTail = tail.slice(-40).join('\n');
    await queueAlert(
      buildAlert(
        '💥 *xdev 全流程失败*',
        `• 结果: ${reason}\n• 耗时: ${elapsed}s\n\n\`\`\`text\n${errTail.slice(-2400)}\n\`\`\``
      ),
      'pipeline-failed'
    );
  }
}

main()
  .catch(async (err) => {
    state.phase = 'supervisor-crashed';
    console.error('[supervisor] ✗ supervisor crashed:', err?.stack || err);
    await deliverAlert(
      buildAlert('💥 *xdev supervisor 自身崩溃*', '```text\n' + String(err?.stack || err).slice(0, 1500) + '\n```'),
      { title: 'supervisor-crashed' }
    ).catch(() => {});
    state.exitCode = 1;
  })
  .finally(async () => {
    clearInterval(watchdog);
    await alertQueue.catch(() => {});
    try {
      await fsp.writeFile(MANIFEST_PATH, JSON.stringify(state, null, 2), 'utf-8');
    } catch (e) {
      console.error('[supervisor] failed to write manifest:', e?.message || e);
    }
    if (logStream) logStream.end();
    process.exitCode = state.exitCode ?? 1;
    console.log(`[supervisor] done — exit=${state.exitCode} alerts=${state.alertsSent} manifest=${MANIFEST_PATH}`);
  });
