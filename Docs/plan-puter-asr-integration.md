# 集成 Puter.js 语音转文本 (ASR) 基础库并在 Xhot 流水线中解析推文视频

## 1. 需求与目标

1. **基础库封装（`src/libs/asr/`）**：
   - 依据官方 Puter.js 规范 (`https://developer.puter.com/tutorials/free-unlimited-speech-to-text-api/`)，构建一套稳定、符合 AIGC-pipeline 架构约定的语音转文本 ASR 基础库。
   - 支持多种输入类型：网络 URL、本地音视频文件（`.mp4`, `.webm`, `.mkv`, `.wav`, `.mp3` 等）、Buffer/Data URI。
   - 对视频文件自动调用 `ffmpeg` 提取音频流并压缩为高效语音格式（如 16kHz 单声道 mp3/wav）。
   - 支持 Puter 提供的所有核心模型参数：`gpt-4o-transcribe`（默认）、`whisper-1`、`gpt-4o-mini-transcribe`、`gpt-4o-transcribe-diarize`，并支持 `translate` 翻译选项。
   - 接入环境认证体系：优先读取 `PUTER_AUTH_TOKEN` / `process.env.puterAuthToken`，支持通过 CLI 或环境配置进行认证管理。
   - 严格遵循工程准则：**No fallbacks to hide problems**（不隐藏错误、不静默吞掉 ASR 失败，清晰上报错误并记录结构化日志）。

2. **在 Xhot Pipeline 中引用与端到端集成**：
   - **推文视频感知与 ASR 解析**：
     - **Discovery 阶段（`src/modules/discovery/`）**：在搜索推文候选卡片时检测推文是否包含视频（`[data-testid="videoPlayer"], [data-testid="videoComponent"]`），若有视频则下载视频/提取音频并调用 ASR 库解析出语音文本，记录到 `candidate.videoUrl`, `candidate.videoPath`, `candidate.asrTranscript` 中。
     - **Harvest 阶段（`src/modules/harvest/`）**：在冠军话题深度采集素材下载推文视频（`downloadTweetVideo`）后，自动对视频调用 ASR 库解析出语音文本，记录到 `item.asrTranscript` 以及 `mediaFiles` 对应视频资产中。
     - **Evaluation 评估与视频制作阶段**：VL 模型评分与解说视频生成可以充分利用 ASR 语音文本丰富理解上下文。
   - **CLI 与模块自测**：
     - 提供独立 ASR 测试命令与自测例程：`npm run module:asr` 或 `testAsrModule()`。
     - 更新 `tests/modules.test.ts`、`tests/xhot-pipeline.test.ts`。

---

## 2. 架构设计与实现步骤

### 2.1 Layer 1B 基础库层：`src/libs/asr/`

- **`contracts.ts`**：
  - 定义 `PuterAsrOptions`、`PuterAsrResult`、`PuterAsrWord`、`PuterAsrSegment`。
  - Zod Schema 校验与 TypeScript 类型推导。
- **`audio.ts`**：
  - 音频提取与格式转换：利用系统 `ffmpeg`（通过 `src/libs/media/frames.ts` 中的 `resolveFfmpegBin`）从本地视频中提取轻量音频，生成临时语音文件或 base64 Data URI。
  - 自动清理临时音频文件。
- **`puter-client.ts`**：
  - 底层驱动与 Puter API 交互：
    - Puter Drivers API：`POST https://api.puter.com/drivers/call`。
    - 请求体：`{ interface: 'puter-speech2txt', driver: 'ai-speech2txt', method: 'transcribe' | 'translate', args: { file, model, response_format, ... }, auth_token: token }`。
    - Token 获取方式：`process.env.PUTER_AUTH_TOKEN` / `process.env.puterAuthToken`。
    - 针对测试环境（test mode）支持 `test_mode: true` 模拟调用。
- **`transcribe.ts`**：
  - 顶层统一入口函数：`transcribeAudio(input, options)`、`transcribeTweetVideo(videoPathOrUrl, options)`。
- **`index.ts`**：
  - 统一导出，并在 `src/libs/index.ts` 导出 `export * as asrLib from './asr/index.js'`。

### 2.2 Layer 2 业务模块层：Discovery 与 Harvest 深度改造

1. **`src/modules/discovery/contracts.ts`**：
   - 在 `XHotCandidateSchema` 中增加：
     - `hasVideo: z.boolean().default(false)`
     - `videoUrl: z.string().optional()`
     - `videoPath: z.string().optional()`
     - `asrTranscript: z.string().optional()`

2. **`src/modules/discovery/search.ts`**：
   - 在 `captureCandidate` 中探测 tweet 元素是否包含视频播放器。
   - 若发现视频且开启了视频探测，调用 `yt-dlp` 下载视频并调用 `transcribeTweetVideo` 解析视频语音，将语音转录文本合并入 candidate。

3. **`src/modules/harvest/contracts.ts`**：
   - 在 `XHotHarvestItemSchema` 与 `mediaFiles` 中支持 `asrTranscript: z.string().optional()`。

4. **`src/modules/harvest/harvest.ts`**：
   - 在下载完 `video-${idx}.mp4` 后，直接调用 `transcribeTweetVideo`，并将解析出的 ASR 文本写入当前视频及 tweet 对象中，同步保存至 `harvest-result.json`。

### 2.3 Layer 3 Pipeline 接入：Xhot 报告与流水线

1. **`src/pipelines/xhot/stages/check-env.ts`**：
   - 增加对 ffmpeg 及 Puter ASR 认证凭据的环境检测提示（标记为可选或配置状态）。
2. **`src/pipelines/xhot/report.ts`**：
   - 在 Markdown / JSON 报告中展示带视频推文的 ASR 转录语音摘要。

### 2.4 测试与验证

1. 单元测试 `tests/asr.test.ts`：测试音频提取、参数处理、Schema 验证、Mock/TestMode 调用。
2. 模块集成测试 `tests/modules.test.ts`：验证 ASR 模块与 Harvest/Discovery 集成。
3. 全流水线测试 `npm test`：全部通过无退化。
4. 测试完毕后清理所有临时文件与测试进程，在 `.gitignore` 中确认无残留。
