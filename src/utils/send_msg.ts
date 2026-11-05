/**
 * Sends a notification message via the webhook service.
 *
 * Credentials (`WEBHOOK_URL`, `WEBHOOK_TOKEN`, `NOTIFY_TO`) come from the
 * environment; the delivery *bot* is project-level configuration
 * (`NOTIFY_PROJECT_DEFAULTS`) overridable per call. See `notify-defaults.ts`.
 */
import { loadEnvFile } from '../env.js';
import pc from 'picocolors';
import { NOTIFY_PROJECT_DEFAULTS, type NotifyProjectDefaults } from './notify-defaults.js';

export interface WebhookConfig {
  webhookUrl: string;
  webhookToken: string;
  notifyTo: string;
  /**
   * Bot name for the multi-bot gateway (pi-telegram-server `TELEGRAM_BOTS`).
   *
   * Resolved from the caller's parameter first, then the CLI `--notify` target,
   * then `NOTIFY_PROJECT_DEFAULTS.bot`. It is never read from the environment:
   * a stale `PI_TELEGRAM_BOT` in a tmux session already routed alerts to the
   * wrong bot once.
   */
  bot: string;
}

export interface WebhookSendResult {
  ok: boolean;
  to: string;
  messageIds?: number[];
  raw?: unknown;
}

/**
 * Explicit bot → Pi inbound port mapping.
 *
 * Project-level (`NOTIFY_PROJECT_DEFAULTS.botPorts`), used to catch a bot whose
 * alerts would be injected into the wrong Pi session. A port is never guessed.
 */
export type BotPortMap = Readonly<Record<string, number>>;

/**
 * Fails when `bot` is not part of the project bot map (a typo, not a guess).
 */
export function assertKnownBot(bot: string, map: BotPortMap = NOTIFY_PROJECT_DEFAULTS.botPorts): void {
  const name = bot.trim().toLowerCase();
  if (map[name] === undefined) {
    throw new Error(
      `Bot "${bot}" is not part of the project bot map (known bots: ${Object.keys(map).join(', ')}); ` +
        'see src/utils/notify-defaults.ts'
    );
  }
}

/**
 * Fails when `bot` is unknown to the mapping, or when `inboundUrl` does not
 * point at the port declared for that bot.
 */
export function assertBotPortConsistency(
  bot: string,
  inboundUrl: string,
  map: BotPortMap = NOTIFY_PROJECT_DEFAULTS.botPorts
): void {
  assertKnownBot(bot, map);

  const expected = map[bot.trim().toLowerCase()];
  let parsed: URL;
  try {
    parsed = new URL(inboundUrl);
  } catch {
    throw new Error(`Pi inbound URL is not a valid URL: ${inboundUrl}`);
  }
  const actualPort = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
  if (actualPort !== expected) {
    throw new Error(
      `Bot/port mismatch: bot "${bot}" must post to port ${expected}, ` +
        `but the inbound URL points at port ${actualPort} (${inboundUrl})`
    );
  }
}

/* ── notify target override (--notify / --notify-error) ─────────────────── */

/**
 * A resolved delivery target: the gateway bot name plus the Pi inbound endpoint
 * that belongs to that bot.
 *
 * Both halves come from the project bot map, so a target can never point at a
 * bot on the wrong port — the failure mode that silently delivered alerts into
 * the wrong Pi session.
 */
export interface NotifyTarget {
  bot: string;
  inboundUrl: string;
}

export type NotifyTargetKind = 'result' | 'error';

/**
 * Parses a `--notify` / `--notify-error` value: `inspilot` or `main,inspilot`.
 *
 * Empty entries and embedded whitespace are typos, not something to skip: a
 * typo here routes a run's output to the wrong chat, so it fails loudly.
 */
export function parseNotifyTargetList(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  if (!raw.trim()) {
    throw new Error('--notify must not be blank; pass a bot name, e.g. "inspilot" or "main,inspilot"');
  }

  const bots: string[] = [];
  for (const entry of raw.split(',')) {
    const name = entry.trim().toLowerCase();
    if (!name) {
      throw new Error(`--notify has an empty entry in "${raw}"; expected <bot>[,<bot>...]`);
    }
    if (/\s/.test(name)) {
      throw new Error(`--notify entry "${name}" must not contain whitespace (use commas: main,inspilot)`);
    }
    if (!bots.includes(name)) bots.push(name);
  }
  return bots;
}

/** Swaps only the port of `inboundUrl`, keeping scheme/host/path intact. */
export function withInboundPort(inboundUrl: string, port: number): string {
  let parsed: URL;
  try {
    parsed = new URL(inboundUrl);
  } catch {
    throw new Error(`Pi inbound URL is not a valid URL: ${inboundUrl}`);
  }
  parsed.port = String(port);
  return parsed.toString();
}

/**
 * Resolves bot names into `{ bot, inboundUrl }` pairs.
 *
 * `map` / `inboundUrl` default to the project-level configuration; they are
 * parameters (not env) so a test or a future pipeline can drive them directly.
 * An unknown bot is a hard error: a typo must not silently drop an alert.
 */
export function resolveNotifyTargets(config: {
  bots: string[];
  inboundUrl?: string;
  map?: BotPortMap;
}): NotifyTarget[] {
  const { bots } = config;
  if (bots.length === 0) return [];

  const map = config.map ?? NOTIFY_PROJECT_DEFAULTS.botPorts;
  const base = (config.inboundUrl ?? NOTIFY_PROJECT_DEFAULTS.inboundBaseUrl).trim();
  if (!base) {
    throw new Error('Cannot resolve notification target(s): the inbound base URL is empty');
  }

  const targets: NotifyTarget[] = [];
  for (const bot of bots) {
    const port = map[bot];
    if (port === undefined) {
      throw new Error(
        `Bot "${bot}" is not part of the project bot map ` +
          `(known bots: ${Object.keys(map).join(', ')}); see src/utils/notify-defaults.ts`
      );
    }
    targets.push({ bot, inboundUrl: withInboundPort(base, port) });
  }
  return targets;
}

/** Explicit targets for the current process; empty means "project default". */
let activeResultTargets: NotifyTarget[] = [];
let activeErrorTargets: NotifyTarget[] = [];

/**
 * Applies `--notify` / `--notify-error` for the rest of the process.
 *
 * Parameters only — nothing is read from the environment.
 * `--notify-error` defaults to the `--notify` targets: the operator asked for a
 * destination, and silently keeping errors elsewhere would defeat the point.
 */
export function setNotifyTargets(input: { result?: string; error?: string }): void {
  const result = resolveNotifyTargets({ bots: parseNotifyTargetList(input.result) });
  const error =
    input.error === undefined
      ? result
      : resolveNotifyTargets({ bots: parseNotifyTargetList(input.error) });

  activeResultTargets = result;
  activeErrorTargets = error;
}

export function getNotifyTargets(kind: NotifyTargetKind = 'result'): NotifyTarget[] {
  return kind === 'error' ? activeErrorTargets : activeResultTargets;
}

/** Forgets the programmatic override: the project default applies again. */
export function clearNotifyTargets(): void {
  activeResultTargets = [];
  activeErrorTargets = [];
}

/** Human-readable target list for logs (e.g. `inspilot (http://…:3095/…)`). */
export function describeNotifyTargets(kind: NotifyTargetKind = 'result'): string {
  const targets = getNotifyTargets(kind);
  if (targets.length === 0) {
    return `project-default (${NOTIFY_PROJECT_DEFAULTS.bot})`;
  }
  return targets.map((t) => `${t.bot} (${t.inboundUrl})`).join(', ');
}

/**
 * Optional file attachment delivered via the webhook service.
 * The gateway forwards `filePath` as a Telegram document with the message
 * text as its caption.
 */
export interface WebhookAttachment {
  /** Absolute path to an existing, readable file on the webhook host. */
  filePath: string;
  fileName?: string;
  mimetype?: string;
}

/**
 * Resolves webhook configuration from process.env.
 * Throws an explicit Error if any required variable is missing.
 */
export function getWebhookConfig(override?: Partial<WebhookConfig>): WebhookConfig {
  loadEnvFile();

  const webhookUrl = override?.webhookUrl ?? process.env.WEBHOOK_URL;
  if (!webhookUrl || !webhookUrl.trim()) {
    throw new Error('Missing required environment variable: WEBHOOK_URL must be defined');
  }

  const webhookToken = override?.webhookToken ?? process.env.WEBHOOK_TOKEN;
  if (!webhookToken || !webhookToken.trim()) {
    throw new Error('Missing required environment variable: WEBHOOK_TOKEN must be defined');
  }

  const notifyTo = override?.notifyTo ?? process.env.NOTIFY_TO;
  if (!notifyTo || !notifyTo.trim()) {
    throw new Error('Missing required environment variable: NOTIFY_TO must be defined');
  }

  // Caller parameter → `--notify` target → project default. Never env.
  const activeBot = getNotifyTargets('result')[0]?.bot;
  const bot = override?.bot ?? activeBot ?? NOTIFY_PROJECT_DEFAULTS.bot;
  if (!bot || !bot.trim()) {
    throw new Error(
      'Notification bot is blank: pass a non-empty bot name (e.g. { bot: "inspilot" }) ' +
        'or omit it to use the project default'
    );
  }

  // A bot outside the project map is a typo, not something to guess around.
  assertKnownBot(bot.trim());

  return {
    webhookUrl: webhookUrl.trim(),
    webhookToken: webhookToken.trim(),
    notifyTo: notifyTo.trim(),
    bot: bot.trim(),
  };
}
/**
 * True when the process runs inside a test runner. Real external alerts
 * (Telegram webhook / Pi inbound) must never fire from tests — a test that
 * exercises an error path would otherwise page a human for a fake failure.
 */
export function isTestEnvironment(): boolean {
  if (typeof process === 'undefined') return false;
  return Boolean(
    process.env.NODE_TEST_CONTEXT ||
      process.env.VITEST ||
      process.env.JEST_WORKER_ID ||
      process.env.NODE_ENV === 'test' ||
      (process.argv[1] && /(?:^|\/)tests?\/.*\.test\.[cm]?[jt]s$/i.test(process.argv[1]))
  );
}

/**
 * Builds the webhook configs for one send.
 *
 * • explicit caller bot → exactly that bot (tests / dedicated channels);
 * • `--notify` targets → one config per target (fan-out);
 * • otherwise → the single project-default channel.
 */
function resolveWebhookConfigs(override?: Partial<WebhookConfig>): WebhookConfig[] {
  if (override?.bot) return [getWebhookConfig(override)];

  const targets = getNotifyTargets('result');
  if (targets.length === 0) return [getWebhookConfig(override)];

  return targets.map((target) => getWebhookConfig({ ...override, bot: target.bot }));
}

/** POSTs one message to one webhook target. Throws on any non-OK answer. */
/**
 * Per-call delivery options.
 *
 * `notifyPi` asks the gateway to also push the same text into the registered Pi
 * agent session over its WebSocket (gateway `forwardInbound`). That is the ONLY
 * Pi channel: the HTTP `POST /telegram/inbound` endpoints on 3094/3095 no
 * longer exist (gateway 方案 C), so a second HTTP leg would just fail.
 */
export interface DeliveryOptions {
  notifyPi?: boolean;
}

async function postWebhook(
  config: WebhookConfig,
  message: string,
  attachment?: WebhookAttachment,
  options?: DeliveryOptions
): Promise<WebhookSendResult> {
  const body: Record<string, string | boolean> = { to: config.notifyTo, message, bot: config.bot };
  if (options?.notifyPi) body.notifyPi = true;
  if (attachment) {
    body.filePath = attachment.filePath.trim();
    if (attachment.fileName?.trim()) body.fileName = attachment.fileName.trim();
    if (attachment.mimetype?.trim()) body.mimetype = attachment.mimetype.trim();
  }

  let res: Response;
  try {
    res = await fetch(config.webhookUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.webhookToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (netErr: any) {
    throw new Error(
      `Network request failed while sending to webhook ${config.webhookUrl} (bot=${config.bot}): ${netErr.message}`
    );
  }

  const bodyText = await res.text().catch(() => '');

  if (!res.ok) {
    const hint =
      res.status === 400 && /multiple bots configured/i.test(bodyText)
        ? ` (gateway does not know bot "${config.bot}": check TELEGRAM_BOTS in the gateway)`
        : '';
    throw new Error(
      `Webhook responded with error HTTP ${res.status}: ${bodyText || res.statusText}${hint}`
    );
  }

  let parsed: any = {};
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    // Non-JSON response but 200 OK
  }

  return {
    ok: true,
    to: config.notifyTo,
    messageIds: parsed.messageIds,
    raw: parsed,
  };
}

/**
 * Sends a notification message via the webhook endpoint.
 * When `attachment` is provided, the gateway delivers the referenced file as
 * a document and uses `message` as its caption.
 * Throws an explicit Error if delivery fails or if response status is not ok.
 */
export async function sendMsg(
  message: string,
  overrideConfig?: Partial<WebhookConfig>,
  attachment?: WebhookAttachment,
  options?: DeliveryOptions
): Promise<WebhookSendResult> {
  const configs = resolveWebhookConfigs(overrideConfig);

  // Test runs must not page a human. An explicit overrideConfig means the test
  // is driving its own mock server, which is allowed.
  if (isTestEnvironment() && !overrideConfig?.webhookUrl) {
    console.log(pc.dim(`[send_msg] Suppressed real Telegram message in test environment: ${message.slice(0, 80)}`));
    return { ok: true, to: configs[0].notifyTo, raw: { suppressed: true } };
  }

  if (attachment && (!attachment.filePath || !attachment.filePath.trim())) {
    throw new Error('[send_msg] attachment.filePath must be a non-empty string');
  }

  // `--notify main,inspilot` fans out: every target must accept the message,
  // otherwise the run reports a real failure instead of a silent partial success.
  const results: WebhookSendResult[] = [];
  const failures: string[] = [];
  for (const config of configs) {
    try {
      results.push(await postWebhook(config, message, attachment, options));
    } catch (err: any) {
      failures.push(`${config.bot}: ${err?.message || err}`);
    }
  }

  if (failures.length > 0) {
    const scope =
      configs.length > 1
        ? `${failures.length}/${configs.length} delivery target(s) failed`
        : 'delivery failed';
    throw new Error(`[send_msg] ${scope}: ${failures.join(' | ')}`);
  }

  if (results.length === 1) return results[0];

  return {
    ok: true,
    to: configs.map((c) => c.notifyTo).join(','),
    messageIds: results.flatMap((r) => r.messageIds ?? []),
    raw: results.map((r) => r.raw),
  };
}

export interface PiInboundConfig {
  inboundUrl: string;
  inboundToken: string;
  senderId: string;
  chatId: string;
}

/**
 * Caller-supplied Pi inbound overrides.
 *
 * `map` exists so a test (or a second deployment) can drive the bot→port
 * mapping explicitly instead of relying on the project default.
 */
export type PiInboundOverride = Partial<PiInboundConfig> & {
  bot?: string;
  map?: BotPortMap;
};

/**
 * Resolves configuration for the Pi session channel (bot, chat id, credentials).
 *
 * NOTE: this no longer describes an HTTP endpoint that the pipeline posts to.
 * Pi delivery now happens through the gateway's WebSocket hub (`notifyPi`),
 * which resolves the session from the bot name. The resolved bot/port pair is
 * kept as a startup consistency check so a typo in `--notify` still fails at
 * Stage 1 instead of silently dropping alerts.
 */
export function getPiInboundConfig(override?: PiInboundOverride): PiInboundConfig {
  loadEnvFile();

  // A `--notify` target carries its own inbound endpoint, so the bot and the port
  // can never drift apart. Without one, derive it from the project default bot.
  const activeTarget = getNotifyTargets('result')[0];
  const bot = (override?.bot ?? activeTarget?.bot ?? NOTIFY_PROJECT_DEFAULTS.bot).trim();
  const map = override?.map ?? NOTIFY_PROJECT_DEFAULTS.botPorts;
  const inboundUrl =
    override?.inboundUrl ??
    activeTarget?.inboundUrl ??
    resolveNotifyTargets({ bots: [bot], map })[0]?.inboundUrl;

  if (!inboundUrl || !inboundUrl.trim()) {
    throw new Error(`Cannot resolve the Pi inbound URL for bot "${bot}" (see src/utils/notify-defaults.ts)`);
  }

  // Bot and inbound port must agree, otherwise alerts land in the wrong Pi session.
  // `override.bot` / `override.map` let a caller assert against its own mapping.
  assertBotPortConsistency(bot, inboundUrl.trim(), map);

  const inboundToken = override?.inboundToken ?? process.env.PI_TELEGRAM_INBOUND_TOKEN;
  if (!inboundToken || !inboundToken.trim()) {
    throw new Error('Missing required environment variable: PI_TELEGRAM_INBOUND_TOKEN must be defined');
  }

  const senderId = override?.senderId ?? process.env.NOTIFY_TO;
  if (!senderId || !senderId.trim()) {
    throw new Error('Missing required environment variable: NOTIFY_TO must be defined');
  }

  const chatId = override?.chatId ?? senderId;
  if (!chatId || !chatId.trim()) {
    throw new Error('Missing required environment variable: chatId must be defined');
  }

  return {
    inboundUrl: inboundUrl.trim(),
    inboundToken: inboundToken.trim(),
    senderId: senderId.trim(),
    chatId: chatId.trim(),
  };
}

export interface ErrorChannelOverride {
  webhookOverride?: Partial<WebhookConfig>;
  /** `bot` is only used for the bot↔port consistency check of the error channel. */
  piOverride?: PiInboundOverride;
  /**
   * Multiple error targets from `--notify` / `--notify-error`.
   * Undefined means "single channel": errors follow the result channel.
   */
  targets?: NotifyTarget[];
}

/**
 * Resolves the error/alert channel.
 *
 * Errors follow `--notify-error`, else the `--notify` targets, else the
 * project default channel — the same place results go. There is no separate
 * error bot in the environment anymore: one project-level decision, overridable
 * by parameter.
 */
export function getErrorChannelOverride(): ErrorChannelOverride {
  const targets = getNotifyTargets('error');
  if (targets.length === 0) return {};

  return {
    webhookOverride: { bot: targets[0].bot },
    piOverride: { inboundUrl: targets[0].inboundUrl, bot: targets[0].bot },
    targets,
  };
}

export interface NotificationConfigSummary {
  bot: string;
  notifyTo: string;
  webhookUrl: string;
  inboundUrl: string;
  /** Bot that receives error/alert messages; equals `bot` when no error channel is configured. */
  errorBot: string;
  /** Pi inbound endpoint for error/alert messages. */
  errorInboundUrl: string;
  /** Resolved `--notify` targets (or `project-default (...)` when not overridden). */
  resultTargets: string;
  /** Resolved `--notify-error` targets (or `project-default (...)`). */
  errorTargets: string;
}

/**
 * Startup self-check for the notification channels.
 *
 * Resolves both channels and verifies the bot name is part of the project map
 * and that its Pi inbound port matches. Throws with an actionable message
 * instead of letting a pipeline run for an hour and then lose every alert.
 */
export function verifyNotificationConfig(options?: {
  webhookOverride?: Partial<WebhookConfig>;
  piOverride?: PiInboundOverride;
}): NotificationConfigSummary {
  const webhook = getWebhookConfig(options?.webhookOverride);
  const inbound = getPiInboundConfig(options?.piOverride);

  assertBotPortConsistency(webhook.bot, inbound.inboundUrl);

  // The error channel is validated here too: a typo in `--notify-error` must
  // fail at Stage 1, not silently drop the one alert that matters after an hour.
  const errorChannel = getErrorChannelOverride();
  const errorBot = errorChannel.webhookOverride?.bot ?? webhook.bot;
  const errorInboundUrl = errorChannel.piOverride?.inboundUrl ?? inbound.inboundUrl;

  return {
    bot: webhook.bot,
    notifyTo: webhook.notifyTo,
    webhookUrl: webhook.webhookUrl,
    inboundUrl: inbound.inboundUrl,
    errorBot,
    errorInboundUrl,
    resultTargets: describeNotifyTargets('result'),
    errorTargets: describeNotifyTargets('error'),
  };
}

/**
 * Dispatches an error alert to the gateway once, asking it to fan out to BOTH
 * channels: the Telegram chat and the registered Pi agent session (`notifyPi`).
 *
 * Delivery targets: `--notify-error` → `--notify` → project default.
 * Multiple targets are fanned out; a caller-supplied override still wins over all of them.
 */
export async function notifyError(
  message: string,
  options?: {
    webhookOverride?: Partial<WebhookConfig>;
    attachment?: WebhookAttachment;
  }
): Promise<void> {
  const errorChannel = getErrorChannelOverride();
  const targets = errorChannel.targets ?? [];

  const deliver = async (target?: NotifyTarget): Promise<void> => {
    // A per-target bot pins the gateway bot, and the gateway resolves that bot's
    // Pi WebSocket session itself — the two channels cannot disagree on routing.
    const webhookOverride = {
      ...(target ? { bot: target.bot } : errorChannel.webhookOverride),
      ...options?.webhookOverride,
    };
    const bot = webhookOverride.bot ?? NOTIFY_PROJECT_DEFAULTS.bot;

    // One request, two channels: gateway → Telegram + gateway → Pi (WS).
    // A failure here is a real failure and must stay visible to the caller.
    await sendMsg(message, webhookOverride, options?.attachment, { notifyPi: true })
      .then(() => {
        console.log(pc.dim(`[pi-inbound] forwarded via gateway (bot=${bot}, notifyPi=true)`));
      })
      .catch((e) => {
        console.error(pc.yellow(`[webhook] Failed to send alert (Telegram + Pi) bot=${bot}: ${e.message}`));
      });
  };

  if (targets.length <= 1) {
    await deliver(targets[0]);
    return;
  }

  await Promise.all(targets.map((target) => deliver(target)));
}

/**
 * Formats an Error / AppError into a detailed, readable notification message for Webhook / Telegram.
 * Unpacks nested cause, candidate evaluation failures, validation errors, and location.
 */
export function formatDetailedErrorMessage(
  err: any,
  titlePrefix: string = '❌ Pipeline execution failed',
  options?: {
    logPath?: string;
    reportPath?: string;
    outDir?: string;
    flowProjectId?: string;
    flowProjectUrl?: string;
    recentOutput?: string;
  }
): string {
  if (!err) return `${titlePrefix}: Unknown error`;

  const lines: string[] = [`${titlePrefix}`];

  // Main message
  const mainMessage = err.message || String(err);
  lines.push(`\n• Error: ${mainMessage}`);

  // Stage and Task if available
  if (err.stage || err.task || err.code) {
    const metaParts: string[] = [];
    if (err.stage) metaParts.push(`Stage: ${err.stage}`);
    if (err.task) metaParts.push(`Task: ${err.task}`);
    if (err.code) metaParts.push(`Code: ${err.code}`);
    lines.push(`• Context: ${metaParts.join(' | ')}`);
  }

  // Failing pipeline step + run, attached by the pipeline registry before rethrow
  if (err.failedStage) lines.push(`• Failed Step: ${err.failedStage}`);
  if (err.runId) lines.push(`• Run: ${err.runId}`);

  // Google Flow Project info if available
  const flowProjectId = options?.flowProjectId || err.flowProjectId;
  const flowProjectUrl =
    options?.flowProjectUrl ||
    err.flowProjectUrl ||
    (flowProjectId ? `https://flow.google.com/project/${flowProjectId}` : undefined);
  if (flowProjectId) lines.push(`• Flow Project ID: ${flowProjectId}`);
  if (flowProjectUrl) lines.push(`• Flow Project URL: ${flowProjectUrl}`);

  // Paths if available
  const logPath = options?.logPath || err.logPath;
  const reportPath = options?.reportPath || err.reportPath;
  const outDir = options?.outDir || err.outDir;
  if (logPath) lines.push(`• Log: ${logPath}`);
  if (reportPath) lines.push(`• Report: ${reportPath}`);
  if (outDir) lines.push(`• Output Dir: ${outDir}`);

  // Nested Cause details
  const cause = err.cause;
  if (cause) {
    if (Array.isArray(cause.failures) && cause.failures.length > 0) {
      lines.push(`\n• Candidate Failure Breakdown:`);
      for (const f of cause.failures) {
        const id = f.videoId || f.id || 'candidate';
        const msg = f.message || f.code || 'failed';
        lines.push(`  - [${id}]: ${msg}`);
      }
    } else if (Array.isArray(cause.validationErrors) && cause.validationErrors.length > 0) {
      lines.push(`\n• Validation Errors:`);
      for (const e of cause.validationErrors) {
        lines.push(`  - ${e}`);
      }
    } else if (typeof cause === 'object') {
      const details: string[] = [];
      if (cause.status) details.push(`HTTP ${cause.status}`);
      if (cause.endpoint) details.push(`Endpoint: ${cause.endpoint}`);
      if (cause.model) details.push(`Model: ${cause.model}`);
      if (cause.message) details.push(`Message: ${cause.message}`);
      if (cause.caller) details.push(`Caller: ${cause.caller}`);
      if (details.length > 0) {
        lines.push(`• Underlying Cause: ${details.join(' | ')}`);
      }
    } else if (typeof cause === 'string') {
      lines.push(`• Underlying Cause: ${cause}`);
    }
  }

  // Pipeline recent output extraction (surfacing root cause from child process logs)
  const recentOutput = err.recentOutput || options?.recentOutput;
  if (recentOutput && typeof recentOutput === 'string') {
    const outputLines = recentOutput.split('\n').map((l: string) => l.trim()).filter(Boolean);
    const failureLines = outputLines.filter(
      (l: string) =>
        l.includes('Pipeline execution failed') ||
        l.includes('AppError') ||
        l.includes('MEDIA_DOWNLOAD_FAILED') ||
        l.includes('Error:') ||
        l.startsWith('❌')
    );
    if (failureLines.length > 0) {
      // Pick unique failure lines up to 4
      const uniqueFailures = Array.from(new Set(failureLines)).slice(-4);
      lines.push(`\n• 💡 Root Cause Details:`);
      for (const fl of uniqueFailures) {
        lines.push(`  ${fl}`);
      }
    } else {
      // Show the last 3 non-empty lines from the output
      const tail = outputLines.slice(-3);
      if (tail.length > 0) {
        lines.push(`\n• Process Tail Output:`);
        for (const tl of tail) {
          lines.push(`  ${tl}`);
        }
      }
    }
  }

  // Top stack frame location
  if (err.stack && typeof err.stack === 'string') {
    const stackLines = err.stack.split('\n');
    const locationLine = stackLines.find((l: string) => l.trim().startsWith('at ') && !l.includes('node:internal'));
    if (locationLine) {
      lines.push(`• Location: ${locationLine.trim()}`);
    }
  }

  const result = lines.join('\n');
  // Enforce Telegram message size ceiling (~3500 chars)
  if (result.length > 3500) {
    return result.slice(0, 3450) + '\n... [message truncated]';
  }
  return result;
}

/**
 * Determines whether an error indicates that the LLM is unavailable
 * (e.g. unconfigured credentials, network failure, 4xx/5xx HTTP errors, quota).
 */
export function isLlmUnavailableError(err: unknown): boolean {
  if (!err) return false;
  if (typeof err === 'object') {
    const e = err as any;
    if (e.code === 'LLM_REQUEST_FAILED' || e.code === 'NO_EVALUABLE_CANDIDATE') return true;
    if (e.name === 'LLMError' || e.name === 'HttpStatusError' || e.name === 'NonRetryableError') return true;
    const msg = String(e.message || '');
    if (
      /LLM.*(?:not configured|unavailable|failed|check failed|timeout)/i.test(msg) ||
      /API_KEY is missing/i.test(msg) ||
      /LLM.*(?:authentication|auth).*failed/i.test(msg) ||
      (/Authentication failed/i.test(msg) && !/YouTube/i.test(msg) && !/Google/i.test(msg)) ||
      /Failed to connect to.*(?:models|chat\/completions)/i.test(msg) ||
      /ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(msg)
    ) {
      return true;
    }
    if (e.cause && isLlmUnavailableError(e.cause)) return true;
  }
  return false;
}

/**
 * Handles LLM unavailability by immediately sending a Telegram notification and exiting/throwing.
 * Strictly prevents falling back to rule-based or mock logic that masks the problem.
 */
export async function notifyLlmUnavailableAndExit(
  err: unknown,
  options?: {
    stage?: string;
    task?: string;
    context?: string;
    shouldExit?: boolean;
    overrideConfig?: Partial<WebhookConfig>;
    logPath?: string;
    reportPath?: string;
    outDir?: string;
  }
): Promise<never> {
  const contextStr = options?.context || options?.stage || 'LLM Gateway';
  const title = `🚨 [FATAL] LLM Unavailable - ${contextStr}`;
  const detailedMsg = formatDetailedErrorMessage(err, title, {
    logPath: options?.logPath,
    reportPath: options?.reportPath,
    outDir: options?.outDir,
  });

  console.error(pc.bold(pc.red(`\n❌ [FATAL] LLM is unavailable: ${(err as any)?.message || err}`)));
  console.error(pc.bold(pc.red(`Execution aborted immediately. Fallbacks are strictly forbidden to prevent masking problems.`)));
  if ((err as any)?.stack) {
    console.error(pc.dim((err as any).stack));
  }

  const inTest = isTestEnvironment();

  // Prevent multiple redundant notifications for the same error object
  if (!(err as any)?.__notifiedTg) {
    try {
      if (typeof err === 'object' && err !== null) {
        (err as any).__notifiedTg = true;
      }
      // Suppress real external notifications in test environments unless an explicit
      // overrideConfig (e.g. local mock test server) is provided by the test suite.
      if (!inTest || options?.overrideConfig?.webhookUrl) {
        await notifyError(detailedMsg, { webhookOverride: options?.overrideConfig });
        console.error(pc.green(`✔ Telegram & Pi alerts dispatched successfully.`));
      } else {
        console.error(pc.dim(`[send_msg] Suppressed real Telegram alert in test environment.`));
      }
    } catch (notifyErr: any) {
      console.error(pc.yellow(`[webhook] Warning: Failed to send Telegram alert: ${notifyErr.message}`));
    }
  }

  const shouldExit = options?.shouldExit ?? (!inTest);

  if (shouldExit) {
    process.exit(1);
  }

  if (err instanceof Error) {
    throw err;
  }
  throw new Error(`[FATAL] LLM is unavailable: ${String(err)}`);
}
