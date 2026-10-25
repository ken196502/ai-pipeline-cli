# AIGC Pipeline Platform

多流水线 AIGC 自动化生产框架。采用清晰的 **三层架构（utils/libs, modules, pipelines）** 设计，支持以插件化方式扩展多条独立流水线。

当前已集成的流水线：

| Pipeline ID | 名称 | 描述 |
|---|---|---|
| `xhot` | Xhot Trending Video | X (Twitter) 热点追踪 → VL 评估 → 素材采集 → 解说视频自动渲染 |

> 更多流水线（如 YouTube Shorts 自动化、Reddit 热帖视频等）可通过 `src/pipelines/<id>/` 目录结构快速接入。

---

## 🏛️ 三层架构详解

```
AIGC-pipeline/
├── .env -> ../VideoGen/.env                   # 软链接共享 .env 配置
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
│   │   ├── time.ts                            # 时间格式化工具
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
│   │   ├── discovery/                         # Module 2: 话题发现与候选推文拼图
│   │   ├── evaluation/                        # Module 3: 多模态 VL 视觉模型综合评估
│   │   ├── harvest/                           # Module 4: 冠军话题深度素材采集
│   │   ├── explainer-video/                   # Module 5: 解说视频故事板与视频渲染
│   │   └── index.ts                           # 统一导出与 testAllModules()
│   │
│   ├── pipelines/                             # 【Layer 3: 流水线编排调度层】
│   │   ├── core/                              # 通用 Pipeline 框架
│   │   │   ├── contracts.ts                   # Pipeline / PipelineStageDef / Pipeline24hOptions 类型定义
│   │   │   ├── context.ts                     # PipelineExecutionContext 运行时上下文
│   │   │   ├── registry.ts                    # PipelineRegistry 注册中心 (含 run24h)
│   │   │   └── runner.ts                      # 24H 连续调度器 (ContinuousTopicScheduler / runPipeline24h)
│   │   ├── xhot/                              # 🔥 Xhot 7 阶段全流程流水线
│   │   │   ├── stages/check-env.ts            # Stage 1: 环境预检
│   │   │   ├── execute.ts                     # Stage 1..7 调度执行引擎
│   │   │   ├── report.ts                      # Markdown 与 JSON 报告生成
│   │   │   ├── contracts.ts                   # 流水线选项与完整产物规范
│   │   │   └── cli.ts                         # 流水线 CLI 子命令入口
│   │   └── index.ts                           # 流水线注册中心 (自动注册所有 pipelines)
│   │
│   ├── cli.ts                                 # 顶层 CLI 入口 (`aigc` 多命令路由)
│   └── index.ts                               # 顶层库导出入口
│
└── tests/
    ├── modules.test.ts                        # 5 个业务模块的一对一独立自测套件
    ├── runner-24h.test.ts                     # 24H 连续调度器与 Runner 测试套件
    └── xhot-pipeline.test.ts                  # Xhot 全流程端到端集成测试套件
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

# 消息通知（全部必填，缺失直接抛错，无默认值/无别名）
WEBHOOK_URL=http://...
WEBHOOK_TOKEN=...
NOTIFY_TO=...
# 网关为多 bot 模式（pi-telegram-server 的 TELEGRAM_BOTS）时必须指定 bot 名；
# 只认 PI_TELEGRAM_BOT（不读 TELEGRAM_BOT），未设置则发送前直接报错
PI_TELEGRAM_BOT=main
# Pi inbound 端点与令牌：不写就报错，代码里没有 127.0.0.1:3094 / Abcd#123456 之类的默认值
PI_INBOUND_URL=http://127.0.0.1:3094/telegram/inbound
PI_TELEGRAM_INBOUND_TOKEN=...
```

---

## 🚀 常用命令

### 1. 运行测试
```bash
# 运行全部测试（模块 + 流水线 + 调度器）
npm test

# 仅测试 Layer 2 业务模块
npm run test:modules

# 仅测试 Xhot 流水线
npm run test:pipeline

# 仅测试 24H Runner 调度器
npm run test:runner
```

### 2. 独立运行 Layer 2 业务模块
```bash
npm run module:auth
npm run module:discovery -- "deepseek r1"
npm run module:evaluation -- path/to/grid.png
npm run module:harvest -- "Claude 3.7"
npm run module:explainer-video -- path/to/eval-result.json path/to/harvest-result.json
```

### 3. 运行 Xhot 流水线

```bash
# 通过 aigc 多命令 CLI
npm run aigc -- xhot "new model"
npm run aigc -- xhot --dry-run

# 直接快捷方式
npm run xhot -- "new model"
npm run xhot -- "deepseek r1" --dry-run

# 多话题单次顺序执行（分号分隔）
npm run aigc -- xhot --topics "AI;new model;deepseek r1"

# 24H 连续循环模式（顺序执行，永不停止，每话题 24 小时默认最多 1 次）
npm run aigc -- xhot --topics "AI;new model;deepseek r1" --24h

# 24H 连续循环模式（自定义限制：每话题 24 小时最多 2 次）
npm run aigc -- xhot --topics "AI;new model;deepseek r1" --24h 2

# 自定义参数
npm run aigc -- xhot "claude 3.7" --candidate-count 12 --max-age-hours 48 --headed

# 跳过视频渲染
npm run aigc -- xhot "sora video" --skip-video
```

### 4. 查看帮助
```bash
# 查看全部可用流水线
npm run aigc -- --help

# 查看 Xhot 流水线参数
npm run aigc -- xhot --help
```

### 5. 编译构建
```bash
npm run build
```

---

## 🔌 添加新流水线

1. 在 `src/pipelines/` 下新建目录，如 `src/pipelines/yt-shorts/`
2. 实现 `contracts.ts`、`execute.ts`、`cli.ts`，导出符合 `Pipeline<TOptions, TResult>` 接口的对象
3. 在 `src/pipelines/index.ts` 中 import 并 `pipelineRegistry.register(yourPipeline)`
4. 在 `src/cli.ts` 中添加对应的 `program.command('yt-shorts')` 子命令
5. 新流水线自动获得 24H Runner、注册中心、状态持久化等全部 Core 能力
