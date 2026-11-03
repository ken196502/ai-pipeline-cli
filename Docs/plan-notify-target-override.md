# Plan: 通知目标可配置（`--notify` / `--notify-error`）

## 背景

当前所有 pipeline 的**结果**与**错误**都被写死送到 `main`：

| 通道 | 当前来源 | 备注 |
| --- | --- | --- |
| 进度 / 成果消息 | `PI_TELEGRAM_BOT=main` | `sendMsg()` |
| 错误 / 告警 | `PI_TELEGRAM_ERROR_BOT=main` + `PI_TELEGRAM_ERROR_INBOUND_URL` | `notifyError()` |
| xdev 运行期 / 成果 | **硬编码** `{ bot: 'main' }`（`src/pipelines/xdev/execute.ts` 4 处） | 连 `--notify` 都无法覆盖 |
| xdev supervisor | `XDEV_NOTIFY_BOT=main`（缺省即 FATAL） | `tools/xdev-supervisor.mjs` |

用户要求：**默认仍是 main，但允许额外加参数指定目标**，例如指定发给 `inspilot`。

## 目标

1. `aigc <pipeline> --notify <bot[,bot...]>`：本次运行的结果**和**错误都发到指定 bot。
2. `aigc <pipeline> --notify-error <bot[,bot...]>`：只改错误/告警目标（结果仍走 `--notify` 或默认）。
3. `tools/xdev-supervisor.mjs --notify <bot[,bot...]>`：supervisor 自身告警 + 子进程 pipeline 都跟着走。
4. 环境变量形式 `NOTIFY_TARGET` / `NOTIFY_ERROR_TARGET`：给不解析 CLI 参数的入口（独立 module CLI、runner）用。
5. 支持一次发多个 bot（fan-out），例如 `--notify main,inspilot`。
6. **零猜测**：bot 必须能在 `PI_TELEGRAM_BOT_PORTS` 里查到端口，Pi inbound URL 由该映射推导（scheme/host/path 沿用 `PI_INBOUND_URL`）。查不到就报错并列出已知 bot，绝不猜端口。
7. 去掉 `xdev/execute.ts` 里的 `{ bot: 'main' }` 硬编码，日志里的 `(@main)` 改为实际目标。

## 优先级（自高到低）

1. **调用方显式 override**（测试 / 专用通道，如 `sendMsg(msg, { bot })`）— 保持现有语义
2. **CLI**：`--notify` / `--notify-error`
3. **环境变量**：`NOTIFY_TARGET` / `NOTIFY_ERROR_TARGET`（首次使用时惰性读取）
4. **环境变量**：`PI_TELEGRAM_ERROR_BOT`（错误通道）、`PI_TELEGRAM_BOT`（进度通道）

## 实现

### 1. `src/utils/send_msg.ts`（核心）

新增纯函数 + 进程级状态（不新增模块，避免与 `parseBotPortMap` 形成循环依赖）：

- `parseNotifyTargetList(raw)`：逗号/空白分隔，trim + lowercase + 去重；空项报错。
- `withInboundPort(inboundUrl, port)`：仅替换端口，保留 scheme/host/path。
- `resolveNotifyTargets({ bots, inboundUrl, map })`：
  - 无 map → 报错（无法推导端口，拒绝猜测）
  - bot 不在 map → 报错并列出已知 bot
  - 无 `PI_INBOUND_URL` → 报错（没有 scheme/host 基准）
  - 返回 `NotifyTarget[] = { bot, inboundUrl }[]`
- 状态：`setNotifyTargets({ result, error })`（`error` 缺省 = `result`）、`getNotifyTargets(kind)`、`clearNotifyTargets()`、`describeNotifyTargets(kind)`。

改造现有解析器（都先看 CLI 覆盖，再回落到 env）：

- `getWebhookConfig()`：`bot = override.bot ?? resultTargets[0].bot ?? PI_TELEGRAM_BOT`
- `getPiInboundConfig()`：`inboundUrl = override.inboundUrl ?? resultTargets[0].inboundUrl ?? PI_INBOUND_URL`，bot 同步
- `getErrorChannelOverride()`：error targets 存在时直接返回该通道（含 `targets` 列表），否则走原 `PI_TELEGRAM_ERROR_BOT` 逻辑
- `verifyNotificationConfig()`：summary 增加 `resultTargets` / `errorTargets` 可读描述，Stage 1 日志即可看到实际投递目标
- `sendMsg()`：无显式 `override.bot` 且 result targets 多于 1 个 → 逐目标 fan-out，任一失败即抛错（不静默成功）
- `notifyError()`：按 error targets 逐个 `sendMsg` + `sendToPi`（单目标时行为与现在完全一致）

### 2. `src/cli.ts`（CLI 接线）

- 新增 `attachNotifyOptions(cmd)`，挂到 `xhot` / `flowTutor` / `xdev` 以及根命令。
- `program.hook('preAction', ...)`：合并 `--notify` / `--notify-error` → `setNotifyTargets()`；解析失败打印可执行提示并 `exit 78`（配置错误，不启动 pipeline）。

### 3. `src/pipelines/xdev/execute.ts`

- 4 处 `{ bot: 'main' }` → `undefined`（交给解析器），日志改用 `describeNotifyTargets()`。
- `notifyError` 不再传 `webhookOverride: { bot: 'main' }`。

### 3.5 环境变量形式

`send_msg.ts` 首次解析目标时惰性读取 `NOTIFY_TARGET` / `NOTIFY_ERROR_TARGET`，
使不解析 CLI 参数的入口（`src/modules/*/cli.ts`、runner）也能改投递目标。
CLI 参数先执行并标记状态，因此优先级更高。

### 4. `tools/xdev-supervisor.mjs`

- 解析 `--notify <bots>` / `--notify-error <bots>`。
- `bots = --notify ?? XDEV_NOTIFY_BOT`，两者都没有 → FATAL（保持"不猜"原则）。
- 用 `.env` 的 `PI_TELEGRAM_BOT_PORTS` 校验 bot 并推导端口；未知 bot 直接退出 78。
- `deliverAlert()` 对每个 bot 投递；子进程 args 追加 `--notify <bots>`（必要时 `--notify-error`），使 pipeline 与 supervisor 目标一致。

### 5. 测试

- `tests/notify-target.test.ts`（新）：`parseNotifyTargetList` / `withInboundPort` / `resolveNotifyTargets` 的正常与报错路径、`setNotifyTargets` + `getWebhookConfig`/`getErrorChannelOverride` 的优先级、多目标 fan-out（本地 mock server）。
- 回归：`tests/telegram-bot-routing.test.ts`、`tests/notification-dual-channel.test.ts` 必须全绿。
- 测试后清理所有测试进程（`tmux ls` / `pgrep`）。

### 6. 文档

- `README.md`：通知配置段补充 `--notify` / `--notify-error` 用法与优先级。
- `.env` 注释补充"可用 CLI 覆盖"。

## 验收标准

```bash
# 默认行为不变：仍发 main
aigc xdev

# 结果 + 错误都发 inspilot
aigc xdev --notify inspilot

# 结果发 main，错误发 inspilot
aigc xdev --notify main --notify-error inspilot

# 两个都发
aigc xdev --notify main,inspilot

# 不解析 CLI 参数的入口用环境变量
NOTIFY_TARGET=inspilot npx tsx src/modules/auth/cli.ts

# 未知 bot：立即失败，列出已知 bot
aigc xdev --notify typo   # exit 78

# supervisor 同步生效
node tools/xdev-supervisor.mjs --notify inspilot
```

## 不做

- 不改 `PI_TELEGRAM_BOT_PORTS` 的语义（仍是显式映射，不引入默认端口）。
- 不为缺失配置引入任何 fallback。
