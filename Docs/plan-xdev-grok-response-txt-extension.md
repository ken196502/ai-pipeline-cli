# Plan: 将 Grok 回答产物扩展名改为 .txt

## 背景与需求
用户要求：在 Xdev pipeline 中，保存 Grok 回答的环节将扩展名改为 `.txt`（原本为 `.md`）。

## 分析与修改
1. **涉及文件**：
   - `AIGC-pipeline/src/pipelines/xdev/execute.ts`
     - 行 267 附近：
       ```ts
       grokResponsePath = path.join(outDir, `grok-response-${timestamp}.txt`);
       ```
     - 检查 Telegram 发送附件部分：`sendMsg` / `postWebhook` 发送文件时会读取 `grokResponsePath`，改为 `.txt` 后，Telegram 会将其作为普通文本文件直接展示/下载，格式完全兼容。
     - 检查最终报告中对 `grokResponsePath` 的引用，确保链接及文件名展示正确。
2. **验证**：
   - 运行 TypeScript 类型检查 `pnpm build`。
   - 运行单元测试。

## 涉及文件
- `AIGC-pipeline/src/pipelines/xdev/execute.ts`
