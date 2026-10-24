# 修复推理大模型请求超时与 Qwen3-TTS 旁白合成实施计划

## 1. 目标与规范要求
- **No Fallbacks**：坚决禁止使用静默降级逻辑或兜底假实现遮掩问题，失败必须明确抛出。
- **支持深度思考/推理模型 (Reasoning Model)**：
  - 核心大模型为 `z-ai/glm-5.3-flash`（强制思考模型），耗时集中在 `reasoning_content` 的生成阶段。
  - 现有客户端使用非流式单次 HTTP POST 请求，当网关反向代理或连接超过约 90-110 秒时连接被断开或客户端超时，导致 `fetch failed`。
  - 需要在 `src/libs/llm/client.ts` 中实现 SSE 流式接收支持（`stream: true`），持续接收数据块避免反向代理因空闲超时掐断连接，并在流结束后组装完整 `content`、`reasoning_content` 及 `usage`。
- **正确适配与修复 Qwen3-TTS**：
  - TTS 服务端采用 Hugging Face Space `https://qwen-qwen3-tts.hf.space` 的 Gradio 5 API。
  - 支持的音色列表为 `['Aiden', 'Dylan', 'Eric', 'Ono_anna', 'Ryan', 'Serena', 'Sohee', 'Uncle_fu', 'Vivian']`。
  - 修复流水线和模块中遗留的 Edge-TTS 音色名（如 `en-US-ChristopherNeural` 或 `local-clone`），使其在未显式传参时默认选择 Qwen3-TTS 合法音色（如 `Ryan` / `Eric`）。
  - 在 `src/libs/player/tts.ts` 中完整落地 Qwen3-TTS 旁白语音合成并导出 `synthesizeQwen3Tts`，严禁任何 fallback 到 edge-tts。

## 2. 深入技术分析

### 2.1 推理模型 `z-ai/glm-5.3-flash` 超时问题
- **实测表现**：
  - 非流式调用大 Prompt 或故事板（Storyboard）生成时，由于模型前置思考较深（Reasoning 往往输出数千字符），整段思考耗时达到 80~100+ 秒，网关或代理可能因未收到任何响应字节而触发 `Remote end closed connection without response`，导致 Node.js `fetch` 抛出 `TypeError: fetch failed`。
  - 采用流式（`stream: true`）请求时，服务端立即建立 SSE 管道并在生成 token 过程中不断下发数据块，管道全程保持活跃，彻底杜绝网关空闲超时断连。
- **改进方案**：
  - 在 `rawFetchRequest` 与 `invokeWithRetry` 支持 `stream: true`。
  - 使用标准的 `ReadableStreamDefaultReader` 或异步迭代器解析 SSE 数据行（`data: {...}` 与 `data: [DONE]`）。
  - 流式累积 `delta.content` 与 `delta.reasoning_content`，最终拼接生成完整的 `ChatResult`。

### 2.2 Qwen3-TTS 适配与音色修复
- 默认音色修正：
  - 将 `src/modules/explainer-video/video.ts` 中的 `ttsVoice: options.ttsVoice || 'en-US-ChristopherNeural'` 修正为 `ttsVoice: options.ttsVoice || 'Ryan'`。
  - 将 `src/modules/explainer-video/produce.ts` 中的 `options.ttsVoice || 'local-clone'` 修正为 `options.ttsVoice || 'Ryan'`。
  - 保持 `src/libs/player/tts.ts` 中 `synthesizeQwen3Tts` 的标准 Gradio 5 queue 实现，无降级分支。

## 3. 验证步骤
1. 执行 `tests/tts-qwen3.test.ts` 验证 Qwen3-TTS 真实合成与时长、字幕时间戳解析。
2. 运行 LLM 测试，验证 `z-ai/glm-5.3-flash` 结合流式接收完成包含 reasoning 的故事板 JSON 输出。
3. 运行 TypeScript 编译检查确保无类型错误。
4. 清理所有测试进程与临时文件。
