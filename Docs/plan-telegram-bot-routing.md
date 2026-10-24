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
