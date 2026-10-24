# Plan: 评估搜索前 20 条推文并筛选 Top 10 信息最丰富素材采集

## 背景与目标
在 Xhot pipeline 运行中，当前素材采集（Stage 5: `harvestWinnerTopicMaterials`）默认只直接抓取前 6 条推文（`targetCount = 6`），素材数量偏少且缺乏信息密度筛选。
用户需求：
1. 搜索胜出主题（或相关搜索）前 20 条推文。
2. 复用现有的评估机制（利用截图拼图 Grid 与 Multimodal VL 模型）。
3. 评估出信息最丰富的 10 条推文。
4. 逐个将选出的 10 条推文采集成高质量素材（截图、高分辨率图片、视频及 ASR 转写）。

## 实现方案

### 1. 结构与模块设计
在 `src/modules/harvest/` 目录下或扩展 harvest：
- **阶段 1：搜集 20 条推文预览信息**
  - 在深度搜索 `winnerName` 页面时，抓取前 20 条非广告推文的元数据与快照截图（`targetSearchCount = 20`）。
  - 若搜索结果不足 20 条（例如 X 搜索结果较少），以实际获取到的全部有效推文为准。
- **阶段 2：构建推文评估 Grid 并调用 VL Lite 模型评估**
  - 复用 `buildXHotGrid` 生成 20 条推文卡片的带编号矩阵图。
  - 使用最新的 VL Lite 模型（`gemini-3.5-flash-lite`）进行多模态评估，兼顾高推理速度与更敏锐的视觉多模态理解能力。
  - 编写专用评估 Prompt（复用 `chat` / VL 接口），指示 VL 模型：
    - 评估推文的信息丰富度（包含长文本深度、实测结果、技术架构、多媒体内容、论述详实度、互动数据等）；
    - 选出信息最丰富的 Top 10（若候选推文少于等于 10 则全部入选并排序）。
    - 严格返回结构化 JSON（包含选中的编号 index 列表与推荐理由）。
- **阶段 3：针对选中的 Top 10 推文进行全量素材采集**
  - 采集高分辨率图片（替换为 `large` 格式并下载）。
  - 检测并下载视频（yt-dlp），并进行 Puter ASR 语音转写。
  - 保存清晰的推文卡片截图作为视频呈现素材。
  - 最终生成包含 10 条高质量素材的 `XHotHarvestResult`。

### 2. 代码改造点
1. `src/modules/harvest/contracts.ts`:
   - 增加 `HarvestRichnessEvalResult` 类型定义及选项（`previewCount = 20`, `targetCount = 10` 等）。
2. `src/modules/harvest/eval-richness.ts` (新建):
   - 封装 `evaluateTweetRichnessWithVL`：构建 20 张推文卡片的截图 Grid，调用 VL 模型选出信息最丰富的 Top 10 推文索引。
3. `src/modules/harvest/harvest.ts`:
   - 更新采集流程：先扫描 20 条推文快速生成卡片截图和元数据，通过 VL 评估选出 Top 10，然后逐个抓取媒体/视频/ASR 资产并存为最终素材。
4. `src/pipelines/xhot/execute.ts`:
   - 将 `harvestWinnerTopicMaterials` 的 `targetCount` 调整为 10，支持评估 20 选 10。
5. 单元测试与集成测试验证：
   - 编写/更新测试验证 Top 10 评估与选择逻辑。

## 验证与验收
- 运行测试确保 `npm test` 通过。
- 检查没有多余临时文件泄漏，更新 `.gitignore`（若有新增临时输出）。
- 清理所有测试产生的测试进程与临时文件。
