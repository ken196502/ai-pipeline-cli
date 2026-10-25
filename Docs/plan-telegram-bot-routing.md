# Plan: 修复 AIGC-pipeline → Telegram 通知丢失（多 bot 路由）

## 现象

AIGC-pipeline 跑完 / 失败后，Telegram 收不到任何消息。tmux `xhot-pipeline` 面板里可见：

```
[webhook] Warning: Failed to send success notification: [send_msg] Webhook responded with error HTTP 400:
{"ok":false,"error":"multiple bots configured (main, inspilot); specify the bot in the request and set PI_TELEGRAM_BOT=<name> for this Pi session"}
```

## 根因

1. `pi-telegram-server` gateway（127.0.0.1:3093）已切换为多 bot 模式
   （`TELEGRAM_BOTS=main=...,inspilot=...`），`/webhook` 要求请求体带 `bot`
   字段；缺失时直接 400（刻意不猜 bot）。
2. `AIGC-pipeline/src/utils/send_msg.ts` 的 `sendMsg()` 只发送 `{ to, message }`，
   从未带 `bot`，因此 **所有** Telegram 通知（成功播报、失败告警、文档附件）全部 400。
3. 调用方 `notifyError()` / `sendMsg().catch()` 只把错误打成 console warning，
   于是问题静默存在，只有翻 tmux 日志才能看到。

补充核实（非问题）：
- Pi inbound 监听 3094 正常：错误 token → 401，正确 token + 空 body → `{"ok":false,"error":"body is required"}`。
- gateway 带 `bot:"main"` 的直发测试 → `{"ok":true,"messageIds":[9724]}`。

## 方案

在 webhook 客户端显式携带 bot 名，配置来源于环境变量，不猜、不兜底。

1. `send_msg.ts`
   - `WebhookConfig` 新增可选 `bot?: string`。
   - `getWebhookConfig()` 解析顺序：`override.bot` → `PI_TELEGRAM_BOT` → `TELEGRAM_BOT`；
     空白视为未设置（不填默认值）。
   - `sendMsg()` 在 body 中仅当 `bot` 非空时附加 `bot` 字段。
   - 失败仍然抛错（保持现有 `HTTP 400: <gateway 原文>` 语义），不静默吞掉。
2. `AIGC-pipeline/.env`
   - 新增 `PI_TELEGRAM_BOT=main`（本机 gateway 的 main bot，与本项目通知对象一致）。
3. 测试 `tests/telegram-bot-routing.test.ts`（本地 mock HTTP server，不触达真实 TG）
   - 设置 `PI_TELEGRAM_BOT` 时 body 必须含 `bot`。
   - `override.bot` 优先级高于环境变量。
   - 未配置时 body 不含 `bot`（保持对单 bot 部署的兼容）。
   - gateway 返回 400 时 `sendMsg` 必须抛错且错误信息包含响应原文（不允许假成功）。
4. 文档：`README.md` 环境变量表补充 `PI_TELEGRAM_BOT`。

## 验证

- `npx tsx --test tests/telegram-bot-routing.test.ts`
- `npm test`（全量）
- `npm run build`（tsc 通过）
- 真机验证：用修好的 `sendMsg()` 发一条真实通知到 5971350987，确认 TG 收到。

## 不做

- 不在 gateway 端加"默认 bot"兜底（会掩盖配置错误）。
- 不改 pi inbound payload 的 `bot` 字段（避免 bot 名与 inbound 端口错配导致静默丢弃）。

## 追加：去掉所有"不清不楚"的 fallback（2026-10-24）

多 bot 网关下，bot 名只能来自 env；缺失即报错，不做任何猜测。

`src/utils/send_msg.ts`：

| 变量 | 变更前 | 变更后 |
|---|---|---|
| `PI_TELEGRAM_BOT` | 可选，回落 `TELEGRAM_BOT`，空则不发 bot 字段 | **必填**，只认 `PI_TELEGRAM_BOT`；空白/缺失 → `sendMsg` 直接抛错，不发请求 |
| `NOTIFY_TO` | 可回落 `TELEGRAM_TO` | **必填**，只认 `NOTIFY_TO` |
| `PI_INBOUND_URL` | 回落 `TELEGRAM_INBOUND_URL`，再回落硬编码 `127.0.0.1:3094` | **必填**，无默认值 |
| `PI_TELEGRAM_INBOUND_TOKEN` | 回落 `INBOUND_WEBHOOK_TOKEN` / `PI_INBOUND_TOKEN`，再回落硬编码 `Abcd#123456` | **必填**，只认 `PI_TELEGRAM_INBOUND_TOKEN` |
| inbound sender/chat | 回落 `TELEGRAM_TO` / 硬编码 `5971350987` | 必填 `NOTIFY_TO` |
| `sendToPi` 失败 | `return false` 静默吞掉 | 抛错（由 `notifyError` 记录），HTTP 非 2xx 也算失败 |

测试 `tests/telegram-bot-routing.test.ts` 扩到 9 条，覆盖：缺失/空白 bot 直接报错且不发请求、
`TELEGRAM_BOT` 别名不被接受、inbound URL/token 缺失报错、别名 token 不被接受。

已知边界：`loadEnvFile()` 仅在变量未设置时写入，因此在 pi 会话 shell 里运行会继承该会话的
`PI_TELEGRAM_BOT`。要固定 bot，请用干净 shell 或同时显式导出 bot 与 `PI_INBOUND_URL`。

## 追加 2：启动期自检 `PI_TELEGRAM_BOT_PORTS`（2026-10-24）

问题：`.env` 里的 `PI_INBOUND_URL` 与 `process.env` 里继承来的 `PI_TELEGRAM_BOT`
可能指向不同的 bot（如 bot=inspilot 但 inbound=3094/main），告警会注入错的 Pi 会话。

做法：新增**显式**映射变量，不写就完全不检查（绝不猜端口）。

```ini
PI_TELEGRAM_BOT_PORTS=main:3094,inspilot:3095
```

规则（`src/utils/send_msg.ts`）：

- `parseBotPortMap()`：解析 `<bot>:<port>` 逗号列表；空串/未设置 → `undefined`（跳过检查）；
  空条目、缺 `:`、非整数端口、端口越界、重名 bot → 直接抛错。
- `assertBotPortConsistency(bot, inboundUrl, map)`：
  - 未配置映射 → 直接返回（不猜）；
  - bot 不在映射里 → 报错并列出已知 bot（拦拼写错误）；
  - `PI_INBOUND_URL` 端口与该 bot 的端口不一致 → 报错（URL 未写端口时按协议默认 80/443 判定）。
- `getWebhookConfig()`：映射存在时，未知 bot 直接报错。
- `getPiInboundConfig()`：映射存在且 `PI_TELEGRAM_BOT` 有值时校验端口一致性。
- `verifyNotificationConfig()`：一次性解析 webhook + inbound 并做完整校验，返回摘要供日志使用。
- 启动期接入：`pipelines/core/stages.ts` 与 `pipelines/xhot/stages/check-env.ts` 的
  Stage 1 第一步调用；测试环境（`isTestEnvironment()`）显式跳过并写日志，
  避免 `npm test` 受当前 shell 的 bot 变量影响。

副作用（重要）：在 pi 会话 shell 里跑流水线而未成对导出变量时，Stage 1 会直接失败，
而不是跑一小时后丢掉所有告警。`tests/runner-24h.test.ts` 的 dry-run 用例曾因
check-env 失败被 24h 循环无限重试而挂起，现已由测试环境跳过修复。
