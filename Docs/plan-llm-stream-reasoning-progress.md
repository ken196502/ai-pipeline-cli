# Plan: 分块打印流式 reasoning

## 问题

`parseSseChatResponse()` 已经在逐 delta 接收 `reasoning_content` / `reasoning`（`src/libs/llm/client.ts:578-581`），但收下来的内容只累加进字符串，全程不打一行日志。

后果（2026-11-02 那次 run 实测）：

- Stage 2 审稿单次调用流式接收约 13 分钟、1.08 MB SSE，stdout 全程静默
- supervisor 的 stall 检测只看 stdout 静默，10 分钟后误报「疑似卡死」
- 假告警会稀释真告警的可信度

## 目标

reasoning delta 边收边分块打印到 stdout，让人和 supervisor 都能看到进度。**只做观测，不改任何行为**：

- 不加总时长超时（13 分钟的正常调用不能被杀）
- 不加复读检测（无证据支持，属于臆想机制）
- 不加 abort 逻辑

## 改动

`src/libs/llm/client.ts`：

1. 新增 `createReasoningPrinter(context)`：累积 pending，达到 240 字符或距上次输出 3 秒即 flush 一块。
2. `parseSseChatResponse(response, modelName, context?)` 增加可选第三参数，日志可归属到 `stage/task`。
3. delta 处理分支里 `reasoningPrinter.push(...)`，流结束后 `reasoningPrinter.end()` 补最后一块。
4. 调用点 `invokeWithRetry` 内传入 `args.context`。

输出形态：

```
[llm] 🧠 reasoning 1,240 chars / 12s (xdev/tweet-eval-selection)
  候选 #7 只有 3529 阅读量，不足以支撑核心论点…
```

## 不做的事

- 不改 `DEFAULT_RETRY_POLICY`
- 不改 supervisor 的 stall 判据（有了输出，静默判据自然不再误报）
- 不动 `content` 累加逻辑

## 验证

- `npm test`（现有 llm 相关用例）
- 下一次 xdev run 观察 Stage 2/6 是否每 3 秒有 `[llm] 🧠` 输出
