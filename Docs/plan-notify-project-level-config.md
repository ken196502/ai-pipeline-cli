# Plan: 通知目标改为项目级配置 + 传参（移除 pipeline 级 env）

## 背景

上一轮加了 `--notify` / `--notify-error`，但 bot 选择仍然由 **env** 兜底：

```
PI_TELEGRAM_BOT=main
PI_TELEGRAM_BOT_PORTS=main:3094,inspilot:3095
PI_INBOUND_URL=http://127.0.0.1:3094/telegram/inbound
PI_TELEGRAM_ERROR_BOT=main
PI_TELEGRAM_ERROR_INBOUND_URL=http://127.0.0.1:3094/telegram/inbound
XDEV_NOTIFY_BOT=main
NOTIFY_TARGET / NOTIFY_ERROR_TARGET        (上一轮新增的 env 形式)
```

问题（已实际发生）：
- tmux 会话残留 `PI_TELEGRAM_BOT=inspilot` 与 `.env` 的 `PI_INBOUND_URL=:3094` 冲突 → 直接跑 pipeline 在 Stage 1 因 bot/端口不匹配中止；
- `XDEV_NOTIFY_BOT` 从 `.env` 补回，导致"没传目标应当报错"的路径根本无法触发（我误跑了一次完整流水线）；
- 同一件事有 6 个环境变量 + 2 个 CLI 参数，pipeline 级配置散落在 env 里，难以审计。

## 目标

1. bot 选择改为**项目级常量**（单一事实来源）：默认 bot = `main`，端口映射与 inbound 基准 URL 也写在同一处。
2. 运行时**只靠传参**覆盖：`--notify` / `--notify-error`（CLI）、`sendMsg(msg, { bot })` / `setNotifyTargets()`（代码）。
3. **未传就默认**（项目级 `main`），不再有任何"缺失即报错"的 bot env。
4. 删除 env 中所有 bot 配置及相关逻辑：`PI_TELEGRAM_BOT`、`PI_TELEGRAM_BOT_PORTS`、`PI_INBOUND_URL`、`PI_TELEGRAM_ERROR_BOT`、`PI_TELEGRAM_ERROR_INBOUND_URL`、`XDEV_NOTIFY_BOT`、`NOTIFY_TARGET`、`NOTIFY_ERROR_TARGET`。
5. 保留**凭据/基础设施** env（不是 bot 配置）：`WEBHOOK_URL`、`WEBHOOK_TOKEN`、`NOTIFY_TO`、`PI_TELEGRAM_INBOUND_TOKEN`。

## 项目级默认值

`src/utils/notify-defaults.ts`（新文件，单一事实来源）：

```ts
export const NOTIFY_PROJECT_DEFAULTS = {
  bot: 'main',
  botPorts: { main: 3094, inspilot: 3095 },
  inboundBaseUrl: 'http://127.0.0.1:3094/telegram/inbound',
} as const;
```

## 实现

### 1. `src/utils/send_msg.ts`

删除：`parseBotPortMap`、`getBotPortMap`、`resolveErrorChannel`、`NOTIFY_TARGET*` 的惰性 env 读取。

改造：

| 函数 | 新行为 |
| --- | --- |
| `assertBotPortConsistency(bot, inboundUrl, map?)` | map 默认取项目常量 |
| `resolveNotifyTargets({ bots, inboundUrl?, map? })` | 未传时用项目默认 inboundBaseUrl / botPorts；未知 bot 仍报错（typo） |
| `setNotifyTargets({ result?, error? })` | 纯参数，不读 env；`error` 缺省 = `result` |
| `getWebhookConfig(override?)` | `bot = override.bot ?? target.bot ?? 项目默认 bot` |
| `getPiInboundConfig(override?)` | `inboundUrl = override ?? target ?? 由项目默认推导`；token 仍取 env |
| `getErrorChannelOverride()` | 只来自 `--notify-error`（无则 `{}`，走标准通道） |
| `verifyNotificationConfig()` | 报告项目默认值 + 当前目标；不再要求 bot env |
| `describeNotifyTargets()` | 无覆盖时返回 `project-default` |

`sendMsg` / `notifyError` 的 fan-out 逻辑保留。

### 2. `tools/xdev-supervisor.mjs`

- 删除 `XDEV_NOTIFY_BOT`、端口映射解析、`PI_INBOUND_URL` 读取、`CHILD_NOTIFY_ENV`。
- `--notify` 可选，缺省 = 项目默认 bot（`main`）；`--notify-error` 同理。
- 告警只走 gateway webhook（`bot` 名 + `notifyPi: true`），不需要端口 → 不再复制端口表。
- 子进程固定追加 `--notify <bots>`，保证 supervisor 与 pipeline 目标一致。
- 加漂移守卫测试：supervisor 里的默认 bot 必须等于 `NOTIFY_PROJECT_DEFAULTS.bot`。

### 3. 其它调用点

- `src/cli.ts`：只更新注释/帮助文案（去掉 `PI_TELEGRAM_BOT` 措辞）。
- `src/pipelines/xdev/execute.ts`：`notifyLabel()` 已用 `getWebhookConfig()`，无需改逻辑。

### 4. 测试

- `tests/telegram-bot-routing.test.ts`：删掉 env-bot 相关用例（env 已不是事实来源），改为"项目默认 / 参数覆盖 / 未知 bot 报错 / gateway 400 传播 / Pi token 必需 / bot-port 一致性（项目映射）"。
- `tests/notification-dual-channel.test.ts`：去掉 `PI_TELEGRAM_ERROR_BOT` / `PI_TELEGRAM_BOT_PORTS` 的 env 注入。
- `tests/notify-target.test.ts`：去掉 `NOTIFY_TARGET*` 用例；`pinEnv` 只固定凭据；新增 supervisor 默认值漂移守卫。
- 回归：`pipeline-lock` / `xdev-*` 全绿。

### 5. 文档与配置

- `.env`：删掉 6 个 bot 配置项，保留凭据项并加一行注释指向 `src/utils/notify-defaults.ts`。
- `README.md`：环境变量表与"指定通知目标"章节重写。
- 本计划文件随实现更新。

## 验收

```bash
# 默认（不传参）→ main
npx tsx src/cli.ts xdev

# 传参覆盖
npx tsx src/cli.ts xdev --notify inspilot
npx tsx src/cli.ts xdev --notify main --notify-error inspilot
npx tsx src/cli.ts xdev --notify main,inspilot

# 未知 bot → 启动前失败，退出码 78
npx tsx src/cli.ts xdev --notify typo

# supervisor 未传 → 默认 main
node tools/xdev-supervisor.mjs

# 代码层传参
sendMsg(msg, { bot: 'inspilot' })
```

## 不做

- 不保留任何 bot 相关 env（包括过渡期兼容）。
- 不引入新的默认端口猜测：端口只来自项目常量。
