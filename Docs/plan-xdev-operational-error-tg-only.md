# Plan: Route Non-Bug Operational Exits in xdev to Telegram Only (Skip Pi Inbound)

## Background & Objective
When the `xdev` pipeline exits due to operational/data criteria:
- No tweets have >= 1,000 views or external links/articles;
- All scraped candidate tweets have already been covered in recent history;
- LLM reviewer intentionally rejects all candidates under the "宁缺毋滥" policy;

These are expected business rule / data condition terminations, NOT program bugs or crashes.
Dispatching them to the Pi inbound listener triggers AI agent interventions and false alarms in the development session.
The user requested:
> "这种非程序bug的退出，不需要发给pi，只要tg警告就行"
(Such non-program-bug exits should NOT be sent to Pi, only a Telegram warning is needed.)

## Implementation Details

### 1. Define `OperationalWarningError`
Create and export `OperationalWarningError` in `AIGC-pipeline/src/pipelines/xdev/contracts.ts` (or `errors.ts`):
```ts
export class OperationalWarningError extends Error {
  readonly isOperational = true;
  constructor(message: string) {
    super(message);
    this.name = 'OperationalWarningError';
  }
}
```

### 2. Use `OperationalWarningError` for Business Condition Terminations
1. **Scraping / Low Views Filter (`execute.ts`)**:
   When `allTweets.length === 0`:
   Throw `OperationalWarningError` stating that no tweets met the >= 1,000 views requirement.
2. **History Duplicate Filter (`execute.ts`)**:
   When `freshTweets.length === 0`:
   Throw `OperationalWarningError` stating that all candidate tweets have already been written about in recent history.
3. **LLM Reviewer Rejection (`analyzer.ts`)**:
   When `validIndices.length === 0` (reviewer rejects all candidates under "宁缺毋滥"):
   Throw `OperationalWarningError`.

### 3. Differentiate Alert Routing in Catch Block (`execute.ts`)
In `runXDevPipeline`'s `catch (err)`:
- Check if `err.isOperational === true` (or message matches operational criteria):
  - If TRUE:
    - Log `⚠ xdev 流水线安全终止 [stage]: ...`
    - Send Telegram-only warning via `sendMsg(warningMsg, { bot: 'inspilot' })`.
    - Skip Pi inbound dispatch.
    - Re-throw `err` (pipeline halts without hidden fallback).
  - If FALSE (genuine program bug / unexpected exception):
    - Send dual-channel alert via `notifyError(detailedMsg, { webhookOverride: { bot: 'inspilot' } })` to both Telegram and Pi inbound.
    - Re-throw `err`.

### 4. Tests
- Add unit tests in `AIGC-pipeline/tests/xdev-operational-error.test.ts` verifying:
  - `OperationalWarningError` carries `isOperational = true`.
  - Operational errors trigger Telegram notification without calling Pi inbound.
  - Program bugs continue to invoke dual-channel `notifyError`.
