# AIGC Pipeline Platform

多流水线 AIGC 自动化生产框架。采用清晰的 **三层架构（utils/libs, modules, pipelines）** 设计，支持以插件化方式扩展多条独立流水线。

当前已集成的流水线：

| Pipeline ID | 名称 | 描述 |
|---|---|---|
| `xhot` | Xhot Trending Video | X (Twitter) 热点追踪 → VL 评估 → 素材采集 → 解说视频自动渲染 |
| `flowTutor` | FlowTutor | YouTube AI 教程视频搜索 → VL 封面评估 → prompt 提取 → Flow Veo 批量合成 → 解说视频 |

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
│   │   │   ├── lock.ts                        # 并发冲突检测（运行锁 + 存活进程扫描）
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
# bot → Pi inbound 端口显式映射：启动期自检用，bot 不在表里或端口对不上直接报错；
# 不写则跳过检查（不会猜端口）
PI_TELEGRAM_BOT_PORTS=main:3094,inspilot:3095
```

---

## 🚀 常用命令

### 0. 并发冲突保护（启动即拒绝）

所有 pipeline 共用同一个持久化 Chromium profile（`./.chromium-profile`，CDP 9222），并行运行会互相接管浏览器、覆盖 cookie。因此 CLI **在启动第一步就检查是否已有 pipeline 在跑**，有则直接报错退出，不打印 banner、不启动浏览器、不发任何通知。

```text
⛔ Pipeline conflict detected — refusing to start.

  Requested:        flowTutor
  Already running:  xhot (pid 65995)
  Started at:       2026-10-25T07:21:01.365Z
  Command:          /usr/bin/node .../src/cli.ts xhot guard e2e
  Lock file:        /mnt/share/VM/AIGC-pipeline/.tmp/pipeline.lock
```

- 退出码：`2`（`PIPELINE_CONFLICT`），便于脚本判定。
- 判据一：运行锁 `<projectRoot>/.tmp/pipeline.lock`（原子创建，退出/`exit` 钩子自动清理；崩溃残留的锁会因 pid 已死而被下一次启动接管）。
- 判据二：进程表扫描，用于捕捉没有锁的运行者（旧版本、别的终端手工启动）。只认 `node`/`tsx` 进程 + 入口必须解析到本项目的 `src/cli.ts`/`dist/cli.js`，因此 `bash -c`、`tmux send-keys`、`grep`、`npm` 包装进程不会被误判。
- 24H Runner 在整个生命周期（含 sleep 阶段）持锁，因此运行中的 `--24h` 循环会阻止其它 pipeline 启动。
- 需要并行时，必须给其中一条 pipeline 独立的 `CHROMIUM_PROFILE_DIR`（并单独登录），不提供 `--force` 之类的绕过开关。

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

> ⚠️ **Topic 配置说明**：Xhot 流水线不使用任何硬编码默认 topic。每次执行必须通过 CLI 指定 topic，或者在环境变量/`.env` 中配置 `XHOT_TOPICS` / `XHOT_TOPIC`。若未配置任何 topic，流水线将直接报错退出。

```bash
# 通过 CLI 传参指定 topic
npm run aigc -- xhot "AI agents"
npm run aigc -- xhot --dry-run "AI agents"

# 快捷方式
npm run xhot -- "AI agents"
npm run xhot -- "deepseek r1" --dry-run

# 多话题单次顺序执行（分号分隔）
npm run aigc -- xhot --topics "AI;robotics;deepseek r1"

# 24H 连续循环模式（顺序执行，永不停止，每话题 24 小时默认最多 1 次）
npm run aigc -- xhot --topics "AI;robotics;deepseek r1" --24h

# 24H 连续循环模式（自定义限制：每话题 24 小时最多 2 次）
npm run aigc -- xhot --topics "AI;robotics;deepseek r1" --24h 2

# 通过环境变量配置（在 .env 中设置 XHOT_TOPICS 或 XHOT_TOPIC）
# .env:
#   XHOT_TOPICS="AI;robotics;deepseek r1"
npm run aigc -- xhot --24h

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

### 5. 运行 flowTutor

```bash
# 默认查询（与旧 ytbhot 一致）
npm run pipeline:flowTutor

# 指定查询
npx tsx src/cli.ts flowTutor "AI make Niche Viral Video"

# 先只跑到 Flow 生成前，人工确认脚本与 prompt
npx tsx src/cli.ts flowTutor "AI make Niche Viral Video" --stop-before-gen

# 跳过 Flow 生成（只做搜索/评估/prompt 提取/报告）
npx tsx src/cli.ts flowTutor "AI make Niche Viral Video" --skip-flow-gen
```

### 6. 编译构建
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
