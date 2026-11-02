# Plan: Route All Notifications and Error Alerts to Main Bot

## Background & Objective
The user explicitly instructed:
> "所有通知报错要发给main，不要发给inspilot"
(All notifications and error reports must be sent to `main`, do not send to `inspilot`.)

Currently:
1. `AIGC-pipeline/.env` configured `PI_TELEGRAM_BOT=inspilot` and `PI_INBOUND_URL=http://127.0.0.1:3095/telegram/inbound`.
2. `xdev/execute.ts` hardcoded `{ bot: 'inspilot' }` in artifact dispatch, standalone HTML dispatch, and error/warning handling.
3. This routed progress notifications, research artifacts, generated previews, warnings, and error alerts to `@InspilotBot` instead of the user's primary bot `main`.

## Implementation Details

### 1. Update `AIGC-pipeline/.env`
- Change `PI_TELEGRAM_BOT=inspilot` -> `PI_TELEGRAM_BOT=main`.
- Change `PI_INBOUND_URL=http://127.0.0.1:3095/telegram/inbound` -> `PI_INBOUND_URL=http://127.0.0.1:3094/telegram/inbound`.
- Maintain:
  - `PI_TELEGRAM_BOT_PORTS=main:3094,inspilot:3095`
  - `PI_TELEGRAM_ERROR_BOT=main`
  - `PI_TELEGRAM_ERROR_INBOUND_URL=http://127.0.0.1:3094/telegram/inbound`
  - `XDEV_NOTIFY_BOT=main`

### 2. Update `xdev/execute.ts`
- Replace `{ bot: 'inspilot' }` with `{ bot: 'main' }` across all dispatch calls:
  - Stage 7.1: Grok research artifact dispatch (`sendMsg` with `{ bot: 'main' }`).
  - Stage 7.2: Standalone HTML article dispatch (`sendMsg` with `{ bot: 'main' }`).
  - Operational warning exit (`sendMsg` with `{ bot: 'main' }`).
  - Real program bug exit (`notifyError` with `{ webhookOverride: { bot: 'main' } }`).
- Update console log messages from `(@InspilotBot)` to `(@main)`.

### 3. Verify Tests
- Run `tests/telegram-bot-routing.test.ts` and `tests/xdev*.test.ts`.
- Ensure consistency between bot names and port mappings.
- Clean up any test processes.
