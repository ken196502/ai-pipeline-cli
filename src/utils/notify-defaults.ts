/**
 * Project-level notification defaults — the single source of truth for
 * *where* pipeline results and error alerts are delivered.
 *
 * Bot selection is deliberately NOT environment-driven anymore. Previously
 * `PI_TELEGRAM_BOT` / `PI_TELEGRAM_BOT_PORTS` / `PI_INBOUND_URL` /
 * `PI_TELEGRAM_ERROR_BOT` / `XDEV_NOTIFY_BOT` each described part of the same
 * routing decision, and a stale value left in a tmux session silently pointed
 * alerts at the wrong bot (or made a run abort on a bot/port mismatch).
 *
 * Rules:
 *   • this file holds the project default;
 *   • a run overrides it by parameter only (`--notify`, `--notify-error`,
 *     `setNotifyTargets()`, `sendMsg(msg, { bot })`);
 *   • nothing per-pipeline is read from the environment.
 *
 * Credentials and chat ids (`WEBHOOK_URL`, `WEBHOOK_TOKEN`, `NOTIFY_TO`,
 * `PI_TELEGRAM_INBOUND_TOKEN`) are NOT bot configuration and stay in `.env`.
 */
export interface NotifyProjectDefaults {
  /** Default recipient bot for both results and error alerts. */
  bot: string;
  /** Project-level bot → Pi inbound port mapping (never guessed at runtime). */
  botPorts: Readonly<Record<string, number>>;
  /** Base Pi inbound URL; only the port is swapped per bot. */
  inboundBaseUrl: string;
}

export const NOTIFY_PROJECT_DEFAULTS: NotifyProjectDefaults = {
  bot: 'main',
  botPorts: {
    main: 3094,
    inspilot: 3095,
  },
  inboundBaseUrl: 'http://127.0.0.1:3094/telegram/inbound',
};
