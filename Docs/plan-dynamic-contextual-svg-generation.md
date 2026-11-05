# 计划：动态生成贴合文章主题的高质感架构与时序 SVG 图表

## 问题排查
经检查，`src/pipelines/xdev/svg-builder.ts` 中的 `buildArchitectureSvg` 与 `buildSequenceSvg` 此前完全是写死的静态模板（例如包含死板的 `Goal Orchestrator`、`Active Context Window`、`Context Eviction Gate`、`State Bus` 以及固定的 6 步时序），连入参 `topicTitle` 都未被实际使用，导致每次生成的文章中嵌入的架构拓扑与交互时序图均与文章内容脱节。

## 改进目标
让 SVG 图表根据**当期选定的核心议题、推文技术实体以及碰撞洞见**动态生成：
1. **架构图 (Architecture Blueprint SVG)**：
   - 根据当期文章核心架构动态生成 3~4 个技术核心组件卡片（如本期逆向工程中对应的 Input Parser / Context Engine / Harness State Machine / Git Bedrock 等）；
   - 动态包含组件名称、核心机制、输入输出契约、关键数据或指标；
   - 保留 Apple / Google Clean Design Language（Off-white #F8FAFC 渐变背景、柔和卡片阴影、Apple Blue #0071E3 与 Indigo #4F46E5 强调色、绝对无中文）。
2. **交互时序图 (Interaction Timeline SVG)**：
   - 动态生成 3~4 个生命周期参与角色（Lifelines）；
   - 动态生成 5~6 个贴合文章场景的具体调用与数据流动步骤（含标记、状态流转与反馈循环）。
3. **结构化参数生成架构**：
   - 方案选择：采用结构化 LLM 生成器（LLM 提取/规划架构图与时序图的模型描述数据，例如包含 `title`, `subtitle`, `nodes: [{name, subtitle, desc1, desc2, tag}]`, `steps: [{from, to, label}]`），再由确定性的 SVG 渲染器组装出 100% 语法合法、尺寸自适应且不含任何畸变或中文的精美 SVG；
   - 这样既杜绝了 LLM 直接生成裸 SVG 可能导致的 XML 语法错误或错位，又彻底解决了图表内容与文章脱节的问题。
4. **验证与回归**：
   - 确保 `tests/xdev-svg-apple-style.test.ts` 适配并测试动态生成逻辑；
   - 运行单元测试确认无错误，保持环境整洁。
