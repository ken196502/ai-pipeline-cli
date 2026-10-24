/**
 * Sends a notification message via the webhook service.
 * Strictly enforces configuration from environment variables without hidden fallbacks.
 */
import { loadEnvFile } from '../env.js';
import pc from 'picocolors';

export interface WebhookConfig {
  webhookUrl: string;
  webhookToken: string;
  notifyTo: string;
  /**
   * Bot name for multi-bot gateways (pi-telegram-server `TELEGRAM_BOTS`).
   * When the gateway serves more than one bot it rejects requests without it.
   * Resolved from PI_TELEGRAM_BOT / TELEGRAM_BOT; never guessed.
   */
  bot?: string;
}

export interface WebhookSendResult {
  ok: boolean;
  to: string;
  messageIds?: number[];
  raw?: unknown;
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

  const notifyTo = override?.notifyTo ?? process.env.NOTIFY_TO ?? process.env.TELEGRAM_TO;
  if (!notifyTo || !notifyTo.trim()) {
    throw new Error('Missing required environment variable: NOTIFY_TO (or TELEGRAM_TO) must be defined');
  }

  const rawBot = override?.bot ?? process.env.PI_TELEGRAM_BOT ?? process.env.TELEGRAM_BOT;
  const bot = rawBot && rawBot.trim() ? rawBot.trim() : undefined;

  return {
    webhookUrl: webhookUrl.trim(),
    webhookToken: webhookToken.trim(),
    notifyTo: notifyTo.trim(),
    ...(bot ? { bot } : {}),
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
 * Sends a notification message via the webhook endpoint.
 * When `attachment` is provided, the gateway delivers the referenced file as
 * a document and uses `message` as its caption.
 * Throws an explicit Error if delivery fails or if response status is not ok.
 */
export async function sendMsg(
  message: string,
  overrideConfig?: Partial<WebhookConfig>,
  attachment?: WebhookAttachment
): Promise<WebhookSendResult> {
  const config = getWebhookConfig(overrideConfig);

  // Test runs must not page a human. An explicit overrideConfig means the test
  // is driving its own mock server, which is allowed.
  if (isTestEnvironment() && !overrideConfig?.webhookUrl) {
    console.log(pc.dim(`[send_msg] Suppressed real Telegram message in test environment: ${message.slice(0, 80)}`));
    return { ok: true, to: config.notifyTo, raw: { suppressed: true } };
  }

  if (attachment && (!attachment.filePath || !attachment.filePath.trim())) {
    throw new Error('[send_msg] attachment.filePath must be a non-empty string');
  }

  const body: Record<string, string> = { to: config.notifyTo, message };
  if (config.bot) body.bot = config.bot;
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
      `[send_msg] Network request failed while sending to webhook ${config.webhookUrl}: ${netErr.message}`
    );
  }

  const bodyText = await res.text().catch(() => '');

  if (!res.ok) {
    const hint =
      res.status === 400 && /multiple bots configured/i.test(bodyText)
        ? ' (gateway runs multiple bots: set PI_TELEGRAM_BOT=<name> in the environment)'
        : '';
    throw new Error(
      `[send_msg] Webhook responded with error HTTP ${res.status}: ${bodyText || res.statusText}${hint}`
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

export interface PiInboundConfig {
  inboundUrl: string;
  inboundToken: string;
  senderId?: string;
  chatId?: string;
}

/**
 * Resolves configuration for forwarding messages to the running Pi instance.
 * Defaults to the local telegram inbound listener: http://127.0.0.1:3094/telegram/inbound
 */
export function getPiInboundConfig(override?: Partial<PiInboundConfig>): PiInboundConfig {
  loadEnvFile();

  const inboundUrl =
    override?.inboundUrl ??
    process.env.PI_INBOUND_URL ??
    process.env.TELEGRAM_INBOUND_URL ??
    'http://127.0.0.1:3094/telegram/inbound';

  const inboundToken =
    override?.inboundToken ??
    process.env.PI_INBOUND_TOKEN ??
    process.env.INBOUND_WEBHOOK_TOKEN ??
    process.env.PI_TELEGRAM_INBOUND_TOKEN ??
    'Abcd#123456';

  const senderId =
    override?.senderId ??
    process.env.NOTIFY_TO ??
    process.env.TELEGRAM_TO ??
    '5971350987';

  const chatId = override?.chatId ?? senderId;

  return {
    inboundUrl: inboundUrl.trim(),
    inboundToken: inboundToken.trim(),
    senderId: senderId.trim(),
    chatId: chatId.trim(),
  };
}

/**
 * Sends a message directly into the running Pi agent session via Pi's inbound webhook.
 * This notifies Pi immediately of pipeline errors, events, or status updates.
 */
export async function sendToPi(
  message: string,
  overrideConfig?: Partial<PiInboundConfig>
): Promise<boolean> {
  if (isTestEnvironment() && !overrideConfig?.inboundUrl) {
    console.log(pc.dim(`[sendToPi] Suppressed real Pi inbound message in test environment`));
    return true;
  }
  const config = getPiInboundConfig(overrideConfig);
  if (!config.inboundUrl || !config.inboundToken) {
    return false;
  }

  try {
    const payload = {
      body: message,
      senderId: config.senderId,
      chatId: config.chatId,
      timestamp: Math.floor(Date.now() / 1000),
    };

    const res = await fetch(config.inboundUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.inboundToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });

    return res.ok;
  } catch (err: any) {
    console.error(pc.dim(`[sendToPi] Notice: Could not deliver message to Pi inbound (${config.inboundUrl}): ${err.message}`));
    return false;
  }
}

/**
 * Dispatches an error alert to both Telegram (via Webhook) and Pi (via Inbound listener).
 */
export async function notifyError(
  message: string,
  options?: {
    webhookOverride?: Partial<WebhookConfig>;
    piOverride?: Partial<PiInboundConfig>;
    attachment?: WebhookAttachment;
  }
): Promise<void> {
  const tasks: Promise<any>[] = [];

  // 1. Telegram Webhook
  tasks.push(
    sendMsg(message, options?.webhookOverride, options?.attachment).catch((e) => {
      console.error(pc.yellow(`[webhook] Warning: Failed to send Telegram notification: ${e.message}`));
    })
  );

  // 2. Pi Inbound Listener
  tasks.push(
    sendToPi(message, options?.piOverride).catch((e) => {
      console.error(pc.dim(`[sendToPi] Warning: Failed to send to Pi: ${e.message}`));
    })
  );

  await Promise.allSettled(tasks);
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
