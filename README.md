# Xhot: Trending Video Pipeline

独立的 X (Twitter) 热点追踪与解说视频自动化生产流水线。

项目采用清晰的 **三层架构（utils/libs, modules, pipelines）** 设计：
- **Layer 1: utils / libs** —— 领域无关的底层基础库与系统工具（浏览器 CDP 驱动、多模态 LLM 通信、媒体编解码/抽帧/拼图、OpusVideo 画布播放器与 Edge-TTS 渲染、环境变量加载、日志与通知）。
- **Layer 2: modules** —— 5 个高内聚、低耦合的独立业务功能模块（`auth`、`discovery`、`evaluation`、`harvest`、`explainer-video`），支持单独测试（`test<Name>Module`）或独立 CLI 执行。
- **Layer 3: pipelines** —— 顶层端到端流程编排层，通过 `executeXHotPipeline` 串联 7 个阶段（`check-env` → `x-login` → `x-search-grid` → `x-eval` → `x-harvest` → `x-video` → `report`），统一调度各模块并生成交付报告与消息通知。

> **架构规范特别说明**：本项目中**无任何 tutorial 概念**，视频生成子系统专指 **`explainer-video`（解说视频）** 模块。

---

## 🏛️ 三层架构详解

```
xhot/
├── .env -> /Users/FrankLin/VM/VideoGen/.env    # 软链接共享 .env 配置
├── package.json
├── tsconfig.json
├── tools/
│   └── edge_tts_synth.py                      # Edge-TTS Python 辅助脚本
│
├── src/
│   ├── utils/                                 # 【Layer 1A: 通用系统工具层】
│   │   ├── env.ts                             # 智能 .env 候选路径解析与加载
│   │   ├── logger.ts                          # 结构化 RunLogger (.log & .jsonl)
│   │   ├── send_msg.ts                        # Telegram / Webhook 告警与成果通知
│   │   ├── shutdown.ts                        # 退出缓冲区刷新守护
│   │   ├── retry.ts                           # 指数退避重试
│   │   ├── cookies.ts                         # Netscape Cookie 格式化与解析
│   │   ├── text.ts                            # 文本过滤与关键词脱敏
│   │   ├── run.ts                             # RunID 生成与输出目录确保
│   │   └── index.ts
│   │
│   ├── libs/                                  # 【Layer 1B: 底层基础设施库层】
│   │   ├── browser/                           # Chromium 持久化 Profile、CDP 会话管理
│   │   ├── llm/                               # OpenAI-compatible / Responses API 客户端与 curl 预检
│   │   ├── media/                             # ffmpeg/ffprobe 抽帧探针与 yt-dlp 视频下载包装
│   │   ├── player/                            # OpusVideo HTML5/Canvas 播放器、TTS 时间轴与逐帧渲染器
│   │   └── index.ts
│   │
│   ├── modules/                               # 【Layer 2: 业务功能模块层】
│   │   ├── auth/                              # Module 1: X (Twitter) 登录与会话维持
│   │   │   ├── auth.ts / contracts.ts / cli.ts / index.ts (包含 testAuthModule)
│   │   ├── discovery/                         # Module 2: 话题发现与候选推文拼图
│   │   │   ├── search.ts / grid.ts / contracts.ts / cli.ts / index.ts (包含 testDiscoveryModule)
│   │   ├── evaluation/                        # Module 3: 多模态 VL 视觉模型综合评估
│   │   │   ├── eval.ts / contracts.ts / cli.ts / index.ts (包含 testEvaluationModule)
│   │   ├── harvest/                           # Module 4: 冠军话题深度素材采集
│   │   │   ├── harvest.ts / contracts.ts / cli.ts / index.ts (包含 testHarvestModule)
│   │   ├── explainer-video/                   # Module 5: 解说视频故事板与视频渲染 (Explainer Video)
│   │   │   ├── produce.ts / video.ts / cli.ts / contracts.ts / index.ts (包含 testExplainerVideoModule)
│   │   └── index.ts                           # 统一导出与 testAllModules()
│   │
│   ├── pipelines/                             # 【Layer 3: 流水线编排调度层】
│   │   ├── core/                              # Pipeline、PipelineStageDef、PipelineRegistry、Context
│   │   ├── xhot/                              # xhot 7 阶段全流程流水线
│   │   │   ├── stages/check-env.ts            # Stage 1: 环境预检
│   │   │   ├── execute.ts                     # Stage 1..7 调度执行引擎
│   │   │   ├── report.ts                      # Markdown 与 JSON 报告生成
│   │   │   ├── contracts.ts                   # 流水线选项与完整产物规范
│   │   │   └── cli.ts                         # 流水线 CLI 入口
│   │   └── index.ts                           # 流水线注册中心
│   │
│   ├── cli.ts                                 # 顶层 CLI 入口 (`xhot` 命令)
│   └── index.ts                               # 顶层库导出入口 (utils, libs, modules, pipelines)
└── tests/
    ├── modules.test.ts                        # 5 个业务模块的一对一独立自测套件
    └── xhot-pipeline.test.ts                  # xhot 全流程端到端集成测试套件
```

---

## 📁 环境变量复用 (.env)

本项目软链接复用了 `VideoGen` 项目的 `.env`：
```bash
.env -> ../VideoGen/.env
```

核心环境变量包括：
```ini
BASE_URL=https://...
API_KEY=sk-...
LLM_MODEL=gemini-3.6-flash
VL_MODEL=gemini-3.6-flash
IMAGE_MODEL=sensenova-u1.5-fast

# X 平台登录凭据
X_USERNAME=your_x_username
X_PWD=your_x_password

# 消息通知
WEBHOOK_URL=http://...
WEBHOOK_TOKEN=...
NOTIFY_TO=...
```

---

## 🚀 常用命令

### 1. 运行测试
```bash
# 运行所有测试（包含 5 个模块的单模块自测与 Pipeline 完整测试）
npm test

# 仅测试 Layer 2 业务模块 (逐一自测)
npm run test:modules

# 仅测试 Layer 3 流水线
npm run test:pipeline
```

### 2. 独立运行 Layer 2 业务模块
```bash
# 运行模块 1: X 平台鉴权状态检查与登录
npm run module:auth

# 运行模块 2: 话题发现与候选卡片拼图
npm run module:discovery -- "deepseek r1"

# 运行模块 3: 多模态 VL 评估已有的拼图
npm run module:evaluation -- path/to/grid.png

# 运行模块 4: 对指定冠军话题深度采集推文与多媒体素材
npm run module:harvest -- "Claude 3.7"

# 运行模块 5: 渲染解说视频 (explainer-video)
npm run module:explainer-video -- path/to/eval-result.json path/to/harvest-result.json
```

### 3. 运行 Layer 3 完整流水线
```bash
# Dry-run 仿真模式（不消耗网络和点数）
npm run xhot -- "new model" --dry-run

# 默认搜索 "new model"
npm run xhot

# 指定搜索话题
npm run xhot -- "deepseek r1"

# 自定义参数：抓取 12 个候选，仅筛选 48 小时内的推文，显示有头浏览器
npm run xhot -- "claude 3.7" --candidate-count 12 --max-age-hours 48 --headed

# 跳过视频渲染，仅收集热点素材和评估报告
npm run xhot -- "sora video" --skip-video
```

### 4. 编译构建
```bash
npm run build
```
