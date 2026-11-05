# Plan: 修复 Pi-inbound 通知链路 + 候选 1/2/3 名替补机制

## 0. 背景（实测证据，2026-11-03 10:29 那次 flowTutor 运行）

1. 运行 `flowTutor-1793719783954-znjddm` 在 `research/detect-prompts` 阶段失败：
   `NO_VIDEO_PROMPT_FOUND — No AI generation prompts were extracted from any candidate video after trying 2 candidates.`
   - 冠军 `HeD2KyrOeeI` 提取到 0 个 prompt；
   - 第 1 替补 `AXF8u5mjDbc` 没有字幕 → `skipping`；
   - 队列只有 2 个候选（`selection.decision.runnersUp` 里有 `BKuP8yHsd1o`，但它不在 5 条 evaluation pool 里，
     `poolResult.pool.find(...)` 返回 undefined 后被静默过滤）→ 没有第 3 个替补可试。

2. 失败告警只到 Telegram，没到 Pi 会话：
   `[sendToPi] Warning: Failed to send to Pi: fetch failed`
   - 网关已迁移到「方案 C」：只监听 `127.0.0.1:3093`，Pi 会话通过 WebSocket 反注册到 `/inbound`；
     `3094 / 3095` 已无进程监听（`ss -ltnp` 确认）。
   - `src/utils/send_msg.ts` 仍在 `POST http://127.0.0.1:3094/telegram/inbound` → 必然失败。
   - 网关侧 `POST /webhook` 已支持 `notifyPi: true`：它会在发 Telegram 的同时把同一条消息通过 WS
     推给已注册的 Pi 会话（`pi-telegram-server/src/gateway.mjs` `forwardInbound`）。

> 说明：`main` bot 的 Telegram 用户名就是 `@t852clawdbot`（id 8696700404 / Pi-Agent），
> 因此「告警没发到 main」实际是「告警发到了 main，但 Pi-inbound 那一路死了」。

## 1. 改动 A：通知链路（单通道投递，双通道生效）

1. `postWebhook()` 增加 `options.notifyPi`，为 true 时在 webhook body 里带 `notifyPi: true`。
2. `sendMsg()` 透传该选项。
3. `notifyError()` 改为**一次**网关调用：`sendMsg(message, {bot}, attachment, { notifyPi: true })`；
   删除对 3094 的 HTTP `sendToPi()` 腿（它已不可能成功），并在日志里显式打印
   `[pi-inbound] forwarded via gateway (bot=…, notifyPi=true)`，不再静默降级成一行 warning。
4. 删除已死的 `sendToPi()` 导出函数；`getPiInboundConfig()` / `verifyNotificationConfig()` 的
   bot→port 配置校验暂时保留（被 `tests/notify-target.test.ts`、`tests/telegram-bot-routing.test.ts`
   覆盖，清理属于后续独立改动，见 §4）。
5. 更新 `tests/notification-dual-channel.test.ts` 到新契约：
   - 断言网关请求体带 `notifyPi: true`；
   - 断言**没有**对 inbound HTTP 端口的第二次 POST（旧契约的 mock 会失败）。

## 2. 改动 B：候选 1/2/3 名（primary + 两个替补）

1. `selection.decision.ranking` 增加 `rank`（1..3）与 `role`（`primary` / `alternate`），
   并在 `research` 日志里打印 `#1 primary / #2 alternate / #3 alternate`。
2. prompt-detector 的候选队列改为**按排名**构建，而不是只看 5 条 evaluation pool：
   - 来源顺序：`selection.decision.ranking`（VL 排名）→ 回退 `runnersUp`；
   - 每个 videoId 依次用 `candidateByVideoId`（全量 `search.candidates`）→ `poolResult.pool` 解析，
     避免「排名里有、pool 里没有」的候选被静默丢弃（本次 `BKuP8yHsd1o` 就是这么消失的）；
   - 队列上限 3（primary + 2 替补）。
3. `Retrying candidate i/N` 文案里的 N 用真实队列长度（现在是硬编码 `/2`）。
4. 替补候选无字幕时继续尝试下一个（保持现有 `continue`），不再直接耗尽队列。

## 3. 验证

1. `npx tsx --test tests/notification-dual-channel.test.ts tests/notify-target.test.ts tests/telegram-bot-routing.test.ts`
2. 真实链路自检：`notifyError` 手动触发一次，确认
   - Telegram 收到（main / @t852clawdbot）；
   - 本 Pi 会话收到同一条（WS 注入）；
   - 网关 `/health` 的 `bots.main.forwarded` 计数 +1、`dropped` 不增加。
3. 重新跑 flowTutor 全流程（tmux `flowtutor-pipeline`），确认能过 `detect-prompts` 并跑到报告/教程阶段。

## 4. 后续（本次不做）

- 清理 `NOTIFY_PROJECT_DEFAULTS.botPorts` / `inboundBaseUrl` / `withInboundPort` / `PiInboundConfig`
  这套「HTTP inbound 端口」遗留模型，把 Stage 1 自检输出改成「gateway WS 通道」；
  涉及 `src/pipelines/core/stages.ts`、`src/pipelines/xhot/stages/check-env.ts` 与 3 个测试文件。
- 错误通知里的 `Log:` / `Output Dir:` 路径是错的（指向 `artifacts/pipeline.log`，实际在
  `artifacts/flowtutor/<runId>/pipeline.log`）。

---

## 5. 追加：tutorial 阶段两处独立故障（2026-11-03 第二轮运行后）

### 5.1 TTS 断流（已修，`src/libs/player/tts.ts`）
- 现象：`stage [tutorial-gen] failed: terminated`，停在旁白第 2 行。
- 根因：TTS 默认并发 2，两路 SSE 同时打同一个 ZeroGPU Space（单会话应用），其中一路连接被掐断；
  `reader.read()` 抛出的裸 `terminated` 既没包装也不在重试白名单里 → 整阶段判死。
- 修复：断流分类为 `TTS_STREAM_TERMINATED` + 退避重试（3s/6s，最多 3 次）；默认并发 2 → 1
  （`EXPLAINER_TTS_CONCURRENCY` 可覆盖）。

### 5.2 渲染 "Target crashed"（已修，`src/libs/player/render.ts`）
- 现象：`page.evaluate: Target crashed`，稳定发生在第 30–60 帧（两次复现）。
- 根因：软件 GL（SwiftShader）下 `raw` 帧导出每帧做 8.3 MB `readPixels` + ~11 MB base64 字符串回传，
  渲染进程堆持续膨胀后崩掉；与并发/内存无关（清出 2.4 GB、单 worker 仍崩）。
- 修复：
  1. 检测到软件 GL 时默认改用 PNG 截图导出（Playwright 原生，不在页面里堆大 buffer），并打印
     `[render] software GL detected → PNG frame export`；
  2. base64 改为 Blob + FileReader（去掉每帧 256 次字符串拼接）；
  3. `resolveRenderConcurrency` 改为按可用内存预算（1500 MB/worker）与核数取小值；
  4. chunk 改为先写 `.part` 再 rename，避免崩溃留下的截断 chunk 被 auto-resume 当成已完成
     （旧实现只判 `size > 10KB`，无 moov atom 的半成品会被静默复用）。

### 5.3 顺带修的坑
- `tutorial --rebuild` 的 engine 回退写死 `'firefox'`（本机根本没装 playwright firefox），
  现改为读 run.json 里记录的 `tutorialEngine`，兜底 `'chromium'`。
- 卡死 1h57m 的 `pnpm test`（firefox/geckodriver 占 ~540MB、swap 打满）已清理。

### 5.4 性能现状（2 核 / 4 GB，SwiftShader）
- PNG 导出 + 单 worker：0.73 s/帧，5552 帧 ≈ 66 分钟；并发 2 无收益（CPU 瓶颈）。
- 若需更快：`--tutorial-size 1280x720` 或 `--tutorial-fps 24`。

---

## 6. 结果：tutorial 渲染成功（2026-11-03 15:03）

```
✅ TUTORIAL VIDEO REBUILT (exit 0, attempt 1/1)
tutorial/tutorial-video.mp4   1920x1080 · 30fps · h264+aac · 185.07s · 129.7 MB
tutorial/tutorial-grid.jpg    24 帧联系表
tutorial/qa/                  40 帧视觉 QA，通过
```
- 渲染：5552/5552 帧，PNG 导出 + 单 worker（软件 GL 下唯一稳定路径），约 0.83 s/帧，77 分钟。
- `[shutdown] tutorial-video: no leftover handles — event loop is free` —— 这次没有卡在退出。

### 6.1 顺带修掉的「重建后 run.json 仍是 failed」
`tutorial/cli.ts --rebuild` 走的是 `rebuildTutorialBundle()`，**没有经过 `RunContext.step`**，
所以视频明明重建成功，`run.json` 里 `tutorial-gen` 仍是 `failed`，run 级 status 也还是 `failed`
（报告、通知、后续 CI 全部继续报错）。

修复（`src/tutorial/cli.ts`）：
- `--run` 打开的 `RunContext` 提升到 action 作用域（`runContext`）；
- `--rebuild` 现在包在 `runContext.step('tutorial-gen', …)` 里，成功即写 `completed`；
- 随后调用 `runContext.finish()`，让 run 级 status 按真实 stage 状态重算（本次 `failed → completed`）。

本次运行已按同一路径回填：`run.json` status `failed → completed`、`tutorial-gen` `failed → completed`
（durationMs 4612s，取自 `tutorial-render-20261103-1346.log` 的 13:46:10 → 15:03:02），
`FINAL_REPORT.md` 的 stage 表与第 9 节同步更新为实际产物。

验证：`tsc --noEmit` 干净；`flowtutor-pipeline` / `tts-qwen3` / `tts-multi` / `notification-dual-channel`
共 7 项测试全绿；无残留进程、无 pipeline.lock。
