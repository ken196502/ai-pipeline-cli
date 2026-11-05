# Plan: 提升参考视频下载画质至至少 720p 保证 OCR/提示词识别率

## 1. 背景与现状分析
在 `flowTutor-1793720826350-iv53k8` 运行中，首选候选视频 `HeD2KyrOeeI` 本身包含丰富的 AI 提示词界面，但系统下载得到的参考视频分辨率仅为 **576x360**（360p）：
- `src/research/youtube/ytdlp.ts` 中写死了参数 `'--extractor-args', 'youtube:player_client=web'`。
- 在部分网络/客户端环境下，`player_client=web` 只能解析出 360p 格式（ID 18）。
- `DEFAULT_DOWNLOAD_FORMAT` 设置优先匹配 `height<=720`，如果缺损则跌落至最差可用流或 360p。
- `ensurePlayableH264Video` 还将视频降采样限制在 `scale='min(1280,iw)':-2`。
- 视频极其模糊导致 prompt-detector 提取抽帧后，模型根本无法辨认出屏幕文字，直接误判为 0 个提示词并触发备选候选降级。

## 2. 改进方案

### 2.1 区分字幕场景：有字幕时直接拉取纯高清视频轨（Video-Only $\ge 720$p）
1. **参考视频在管线里的真实分工**：
   - **画面轨（Video Track）**：给 `frames.ts` 制作分镜转场图与接触表（Contact Sheets），以及供 `prompt-detector` 识别屏幕上的 AI 提示词（OCR / Vision-Language）。清晰度必须严格 $\ge 720$p。
   - **音轨（Audio Track）**：唯一用途是在**无字幕**时提供给 ASR（自动语音识别）生成转录文本。
2. **场景分流策略**：
   - **已获取字幕（有 Transcript）**：
     直接下载纯视频轨（Video Only），格式设定为优先选择 720p/1080p，如 `bestvideo[height>=720]/best[height>=720]/best`。不绑定也不下载音频流，彻底杜绝因“捆绑音频”而跌落到 360p 的问题，大幅提升下载速度与画面清晰度。
   - **无字幕需 ASR 转写**：
     才需要音频。此时单独或一并提取音频轨供 ASR 使用。
3. **解除客户端限制**：
   - 移除 `--extractor-args youtube:player_client=web` 的硬编码单一限制，允许使用多客户端（例如 `web,web_embedded,tv` 或默认），确保高分辨率（720p/1080p）DASH 视频轨正常暴露。
4. **视频转码保留高清分辨率**：
   - `ensurePlayableH264Video` 对 $\ge 720$p 的视频保持原始高度，若不是 H.264 则无损/高质量转为 H.264，不再过度降采样或压缩。

## 3. 验证计划
- 单元测试：验证下载格式配置、在有字幕时是否使用 video-only 高清优先格式。
- 对候选视频 `HeD2KyrOeeI` 进行下载验证，确认分辨率 $\ge 720$p 且抽帧文字清晰可见。
- 测试结束后清理所有临时测试产物。

## 3. 验证计划
- 单元/集成测试：针对视频下载格式进行验证，确保下载视频的高度不小于 720 像素。
- 清理所有测试产物。
