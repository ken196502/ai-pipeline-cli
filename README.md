# Xhot: Trending Video Pipeline

独立的 X (Twitter) 热点追踪与解说视频自动化生产流水线。

从 X 平台发现热点话题、截取候选推文卡片、通过多模态视觉模型（VL）评估筛选 Top 3 及冠军（#1 Winner）、深度采集相关推文与富媒体素材（高清图片、yt-dlp 视频），并通过 OpusVideo Canvas 渲染引擎生成带语音解说（Edge-TTS / 本地克隆 TTS）的高清展示视频。

---

## 🌟 特性

1. **环境与凭据检查 (`check-env`)**
   - 自动预检 LLM Gateway 连通性、Chromium 浏览器、yt-dlp、ffmpeg 与持久化 Profile 状态。
2. **X 平台持久化会话与自动登录 (`x-login`)**
   - 复用 Chromium 持久化 Profile，自动检测会话；如未登录则使用 `X_USERNAME` / `X_PWD` 自动登录，支持会话 Cookie 恢复。
3. **话题搜索与候选拼图 (`x-search-grid`)**
   - 检索指定关键词热点推文，自动过滤广告与推广内容（`isPromotedTweet`）。
   - 截取候选卡片并生成 4×3 / 3×3 高对比度编号黄色角标拼图（Sharp 渲染）。
4. **多模态 VL 顶尖评估 (`x-eval`)**
   - 发送拼图及候选元数据至多模态视觉模型（如 `gemini-3.6-flash`），进行热度、讨论度、技术影响力综合评估，评出 Top 3 及冠军 #1。
5. **深度采集冠军素材 (`x-harvest`)**
   - 对冠军话题进行二次深度检索，抓取多篇高互动推文、推文截图、原图，并通过 `yt-dlp` 下载演示视频片段。
6. **OpusVideo 自动解说视频渲染 (`x-video`)**
   - 自动生成解说分镜故事板（Storyboard）。
   - Edge-TTS / Local TTS 逐幕合成语音音轨并计算精确词级时间轴。
   - 生成响应式 HTML5/Canvas 播放器束，通过无头浏览器逐帧确定性渲染为 1080p MP4 视频。
7. **全链路报告与通知 (`report`)**
   - 生成结构化 Markdown 与 JSON 报告，自动发送 Telegram / Webhook 成功或失败通知（附带视频或拼图预览）。

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

若要在不同机器独立部署，只需直接创建或放置本项目的 `.env` 即可。

---

## 🚀 快速上手

### 1. 安装依赖
```bash
npm install
```

### 2. 运行测试
```bash
npm test
```

### 3. Dry-Run 模拟运行（不消耗网络和点数）
```bash
npm run xhot -- "new model" --dry-run
```

### 4. 正式运行流水线
```bash
# 默认搜索 "new model"
npm run xhot

# 指定搜索话题
npm run xhot -- "deepseek r1"

# 自定义参数：抓取 12 个候选，仅筛选 48 小时内的推文，有头浏览器展示
npm run xhot -- "claude 3.7" --candidate-count 12 --max-age-hours 48 --headed

# 跳过视频渲染，仅收集热点素材和评估报告
npm run xhot -- "sora video" --skip-video
```

---

## 🛠️ CLI 参数说明

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `[query]` | 搜索话题关键词 | `"new model"` |
| `-o, --out-dir <path>` | 自定义输出产物目录 | `./artifacts/xhot-<timestamp>-<rand>/` |
| `--candidate-count <n>`| 评估网格中的候选推文数量 | `12` |
| `--max-age-hours <n>` | 候选推文的最大时效限制（小时） | `72` |
| `--headed` | 显示浏览器窗口界面（用于排错或确认登录） | `false` |
| `--headless` | 强制无头模式 | `true` |
| `--skip-video` | 跳过最终解说视频渲染阶段 | `false` |
| `--tts-voice <name>` | Edge-TTS 解说音色名称 | `zh-CN-YunxiNeural` |
| `--tts-rate <rate>` | 语音语速调整（如 `+10%`, `-5%`） | `+0%` |
| `--profile-dir <path>` | 自定义 Chromium Profile 路径 | `./.chromium-profile` |
| `--dry-run` | 模拟各阶段流程，产出样例报告 | `false` |

---

## 🏗️ 项目架构

```
xhot/
├── .env -> ../VideoGen/.env   # 软链接复用 .env
├── package.json
├── tsconfig.json
├── tools/
│   └── edge_tts_synth.py      # Edge-TTS Python 合成脚本
├── src/
│   ├── cli.ts                 # CLI 命令行入口
│   ├── index.ts               # 模块统一导出入口
│   ├── env.ts                 # .env 配置加载器
│   ├── xhot/                  # XHot 核心流水线实现
│   │   ├── auth.ts            # X 平台鉴权与登录
│   │   ├── search.ts          # 搜索推文与卡片截图
│   │   ├── grid.ts            # 拼图网格组装 (Sharp)
│   │   ├── eval.ts            # 多模态 VL 顶尖评估
│   │   ├── harvest.ts         # 冠军素材深度采集
│   │   ├── video.ts           # 视频分镜与素材组装
│   │   └── contracts.ts       # 数据契约定义
│   ├── explainer/             # 解说视频生产模块
│   ├── tutorial/              # OpusVideo Canvas 播放器与渲染器
│   ├── browser/               # Chromium 持久化会话与 CDP 封装
│   ├── llm/                   # 多模态 LLM 客户端
│   ├── pipeline/              # 流水线执行调度与报告
│   └── utils/                 # 工具库 (yt-dlp, ffmpeg, cookies, 日志)
└── tests/
    └── xhot-pipeline.test.ts  # 完整单测与集成测试
```
