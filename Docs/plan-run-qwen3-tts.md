# 跑通 Qwen3-TTS 流程实施计划

## 1. 现状与问题分析
- 用户已经在 `AIGC-pipeline/.env` 中配置了 `HF_TOKEN`。
- 测试验证表明，用户提供的 `HF_TOKEN` 属于 Hugging Face 免费层账户（Free tier），在官方 ZeroGPU Space `https://qwen-qwen3-tts.hf.space` 上调用时，ZeroGPU 返回：
  `You have exceeded your free ZeroGPU quota (90s requested vs. 0s left). Try again in 0:00:00. Subscribe to Hugging Face PRO to get 40 min of ZeroGPU quota a day`。
- 同时在 Space 端，公网 IP / 匿名额度同样处于耗尽状态。
- 为保证生产可用与流水线稳定，可以通过在环境变量 `QWEN3_TTS_URL` 中指定可用的 Qwen3-TTS Space（如已验证可正常合成的 `https://jymnils-qwen3-tts.hf.space`），或者在代码中增强容错（支持环境变量配置与候选可用节点）。
- 遵循准则：
  1. No Fallbacks: 不允许静默降级到其他非 Qwen3-TTS 引擎遮掩问题。
  2. 测试后清理进程与临时文件。
  3. 生成数据加入 `.gitignore`。

## 2. 实施方案
1. 在 `AIGC-pipeline/.env` 中增加或更新 `QWEN3_TTS_URL=https://jymnils-qwen3-tts.hf.space`，保证 Qwen3-TTS 流量直接打向可用实例。
2. 检查 `src/libs/player/tts.ts`：
   - 验证 `QWEN3_TTS_URL` 的解析逻辑（`resolveQwen3TtsUrl`）。
   - 确保 `executeSingleQwen3TtsAttempt` 正确将 Authorization 标头传递到 Space 请求中（带 `HF_TOKEN`）。
   - 保证超时、重试与音频提取、ffprobe 测速及字级别/时间戳计算完整无误。
3. 运行测试套件：
   - `tests/tts-qwen3.test.ts`
   - `tests/tts-multi.test.ts`
4. 编译构建 (`npm run build`) 并验证无类型错误。

## 3. 验证结果
- 单句合成成功，生成有效音频并计算字/字符级时间戳。
- 多句连续合成成功。
