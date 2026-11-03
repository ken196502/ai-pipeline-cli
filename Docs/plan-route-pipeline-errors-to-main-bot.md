# Plan: 将 AIGC-pipeline 的错误告警投递对象从 `inspilot` 改到 `main`

## 需求
用户要求：AIGC-pipeline 的**错误**通知改发到 `main` bot（Pi 会话端口 3094），其余状态类消息保持不变。

## 现状
- `.env` 只有单一 bot 通道：`PI_TELEGRAM_BOT=inspilot`、`PI_INBOUND_URL=http://127.0.0.1:3095/telegram/inbound`。
- `src/utils/send_msg.ts` 的 `sendMsg()` / `sendToPi()` / `notifyError()` 全部走这一条通道，`notifyError()` 只是把两者并行调用，没有独立的“错误通道”概念。
- `tools/xdev-supervisor.mjs` 另有独立变量 `XDEV_NOTIFY_BOT`（未写在 `.env`，靠启动命令注入），当前实际值是 `inspilot`。
- 网关 `pi-telegram-server` 已同时运行 `main`(3094) 与 `inspilot`(3095)，`PI_TELEGRAM_BOT_PORTS=main:3094,inspilot:3095` 已提供严格校验表。

## 设计（不引入静默 fallback）
1. 新增两个显式环境变量（写入 `.env`）：
   - `PI_TELEGRAM_ERROR_BOT=main`
   - `PI_TELEGRAM_ERROR_INBOUND_URL=http://127.0.0.1:3094/telegram/inbound`
2. `src/utils/send_msg.ts` 新增 `getErrorChannelOverride()`：
   - `PI_TELEGRAM_ERROR_BOT` 未设置 → 返回 `{}`，错误沿用标准通道（这是文档化的单通道模式，不是隐藏兜底）。
   - 设置了 `PI_TELEGRAM_ERROR_BOT` 但缺少 `PI_TELEGRAM_ERROR_INBOUND_URL` → **抛错**（不猜端口）。
   - 设置了则用 `PI_TELEGRAM_BOT_PORTS` 做严格校验：bot 必须在表内、inbound 端口必须与该 bot 映射一致（`assertBotPortConsistency`），拼错即报错。
3. `notifyError()` 使用该 override：webhook 的 `bot` 与 Pi inbound 的 `inboundUrl` 同时切到错误通道；调用方显式传入的 `webhookOverride` / `piOverride` 优先级更高（测试用 mock 不受影响）。
4. 启动期自检 `verifyNotificationConfig()` 扩展为同时校验错误通道，并把 `errorBot` / `errorInboundUrl` 加入返回摘要；`stages.ts` / `xhot/stages/check-env.ts` 的日志随之打印，配置错误在 Stage 1 直接失败，不会跑到一半丢告警。
5. `tools/xdev-supervisor.mjs` 不变（仍要求显式 `XDEV_NOTIFY_BOT`），在 `.env` 中补 `XDEV_NOTIFY_BOT=main`，使 xdev 监督进程的告警同样落到 `main`；命令行显式注入仍优先（`loadEnvFile` 只填未定义的键）。

## 影响面
- 仅错误/告警类消息改道：`notifyError()`（pipeline 失败、LLM 不可用、登录失败、xdev 监督告警）。
- 普通状态消息（`sendMsg` 直接调用、进度汇报、运行结束通知）仍走 `inspilot`。
- 正在运行的 flowTutor 进程在启动时已把 `.env` 读入 `process.env`，本次改动只对**新启动**的进程生效；不影响其当前投递。

## 验证
1. `npx tsc --noEmit` 通过。
2. `node --test tests/telegram-bot-routing.test.ts`（含 bot/端口一致性用例）通过。
3. 实弹验证：调用一次 `notifyError()` 测试消息，确认 Telegram 收在 `main` bot、且网关日志 `bot=main` 返回 200。
4. 反向验证：临时把 `PI_TELEGRAM_ERROR_BOT` 改成不存在的 bot，确认启动自检/`getErrorChannelOverride()` 明确报错（不静默回退到 inspilot）。
