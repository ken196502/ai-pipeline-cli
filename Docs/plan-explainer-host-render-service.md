# Plan: Explainer 视频宿主机 GPU 渲染服务（Host Render Service）

> 本文件为**规划文档**，不包含实现代码（仅示意性片段）。实现时请严格按本计划逐文件落地。
> 语言约定：正文中文，代码/标识符/路径英文。

---

## 1. 背景与目标（Context & Goal）

### 1.1 现状（Hard facts）

- VM 为 ARM64 Debian，CPU 极慢（measured：software GL，~773 ms/frame）。在 VM 上做 Playwright 逐帧渲染**不可行**。
- 现有宿主机渲染方案（`src/libs/player/host-script.ts` 的 `writeHostRenderScript()`）：
  - 向每个 run 目录写入 `render-on-host.command` + `host-render/render.mjs`。
  - 人工在 macOS 宿主（共享目录 `/mnt/share/VM`）**双击** `.command`，由宿主完成：static server → Playwright 逐帧抓帧 → ffmpeg 编码 → 旁白 mux → grid。
  - 痛点：**需要人手双击**，不能在 pipeline 里自动触发，无法流水线化。
- 网络拓扑：VM 默认网关即宿主 `192.168.64.1`（Apple Silicon macOS）。共享目录 `/mnt/share/VM` **两端同路径可见**。
- 现有 GPU 管道：`resolveChromiumGlMode()` / `chromiumGlArgs()`（`src/libs/player/render.ts`），模式 `default|gpu|vulkan|swiftshader`；CLI 侧已有 `--explainer-gl`（`src/pipelines/xhot/cli.ts`，写入 `process.env.EXPLAINER_CHROMIUM_GL`）。
- 渲染入口：`renderExplainerVideo()`（`src/libs/player/render.ts`），被 `produceExplainerVideo()`（`src/modules/explainer-video/produce.ts`）调用。
- 技术栈：Node/TS、ESM、`playwright-core`、`ffmpeg`。

### 1.2 目标

在**宿主机（macOS, Apple Silicon）**上运行一个**常驻 HTTP 渲染服务**，带 **GPU 启动参数**；让 pipeline **优先调用该服务**完成 explainer 渲染，取代"人工双击 .command"。VM 负责编排与产出素材，宿主负责重活（GPU 加速逐帧渲染）。

---

## 2. 服务设计（Host Render Service）

### 2.1 形态

- 常驻进程：`node host-render/server.mjs --port 8790 --gpu gpu|metal|vulkan|swiftshader|default --token <secret> --bind 192.168.64.1`
- 复用现有 `host-render/render.mjs` 的渲染核心（static server → Playwright 抓帧 → ffmpeg → mux），把它从"一次性脚本"重构为"可被 server 复用的渲染函数"（见 §7 的 `render-core.mjs`）。
- `--gpu` 到 Chromium flags 的映射（宿主为 Apple Silicon，`metal` 为新增别名）：
  - `default` → `[]`（Chromium 自选）
  - `gpu` → `--use-gl=angle --use-angle=gl --enable-gpu --enable-gpu-compositing`
  - `metal` → `--use-gl=angle --use-angle=metal --enable-gpu --enable-gpu-compositing`（Apple Silicon 首选）
  - `vulkan` → `--use-gl=angle --use-angle=vulkan ...`
  - `swiftshader` → `--use-gl=angle --use-angle=swiftshader`（软件兜底，仅显式指定时用）
  - 与 `chromiumGlArgs()` 语义对齐；`metal` 为宿主端扩展，不回写 VM 端的 `ChromiumGlMode`。
- 启动后**大声打印**：bind 地址、端口、GPU 模式、实际解析到的浏览器可执行文件、token 是否启用、允许的 job 根目录。

### 2.2 HTTP 端点（契约）

所有请求头需带 `Authorization: Bearer <token>`（§3）。统一 JSON（除产物下载为二进制流）。

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/healthz` | 健康检查。返回 `{ ok, version, gpu, browser, busy, queueLen, uptimeSec }`。**无需鉴权**（供短超时探活）。 |
| `POST` | `/jobs` | 提交渲染任务。body：`{ explainerDir, engine?, gpu?, crf?, preset?, fps? }`。`explainerDir` 必须是共享目录下绝对路径（§3 allow-list）。返回 `{ jobId }`。 |
| `GET` | `/jobs/:id` | 任务状态快照：`{ jobId, state, framesRendered, totalFrames, fps, message, error?, startedAt, finishedAt?, outputs? }`。`state ∈ queued|running|done|error|canceled`。 |
| `GET` | `/jobs/:id/events` | **SSE 流式进度**（`text/event-stream`）。事件 `progress`/`log`/`done`/`error`。用于把宿主进度喂回 VM 的 `onProgress`。 |
| `POST` | `/jobs/:id/cancel` | 取消任务：杀掉 Playwright/ffmpeg 子进程，置 `canceled`。返回 `{ ok }`。 |
| `GET` | `/jobs/:id/result/video` | 下载 `explainer-video.mp4`（也可直接写回共享目录，见 §2.4）。 |
| `GET` | `/jobs/:id/result/grid` | 下载 `explainer-grid.jpg`。 |

### 2.3 进度语义

- 渲染核心每 N 帧（与现有 `render.mjs` 一致，每 100 帧或末帧）推一条 `progress` 事件：`{ framesRendered, totalFrames }`。
- SSE 断线：client 以 `GET /jobs/:id` 轮询兜底（见 §4 的流式实现）。

### 2.4 产物回传（共享目录优先）

- 因 `/mnt/share/VM` 两端同路径可见，**首选**：server 直接把 `explainer-video.mp4` / `explainer-grid.jpg` 写回提交时传入的 `explainerDir`（即 VM 的 run 目录）。client 只需校验文件出现 + 大小 + `ffprobe` 时长 > 0。
- **兜底**：若 `explainerDir` 不在共享目录内（理论上被 allow-list 拒绝，不会发生），通过 `/result/*` HTTP 下载。保留端点以便跨机排障。

---

## 3. 鉴权与安全（Auth & Safety）

- **bind 地址**：默认 `--bind 192.168.64.1`（宿主在 VM 网段的接口）。禁止 `0.0.0.0`，除非显式传入。启动日志打印实际 bind。
- **shared secret token**：`--token <secret>`（或 env `RENDER_SERVICE_TOKEN`）。除 `/healthz` 外所有端点校验 `Authorization: Bearer`；不匹配返回 `401`。token 缺失时服务**拒绝启动并报错**（不允许无鉴权裸跑）。
- **job 目录 allow-list**：`explainerDir` 必须 `path.resolve` 后落在 `/mnt/share/VM/AIGC-pipeline/artifacts` 之下，且真实存在 `explainer.json` 与 `assets/narration.wav`。否则 `400`。杜绝任意路径读写。
- **单任务串行化（GPU 争用）**：单 GPU，不能并行渲染。服务内置**长度为 1 的执行槽** + FIFO 队列（可配 `--max-queue`，默认 1；队列满返回 `429`）。同一时刻只有一个 job `running`。
- **idle timeout**：`--idle-timeout <sec>`（默认 0 = 常驻）。>0 时，空闲超过阈值自动退出，释放 GPU/内存（适合按需拉起）。
- **job 超时**：单 job 墙钟上限 `--job-timeout <sec>`（默认 3600），超时杀子进程并置 `error`。
- **资源清理**：每个 job 结束（done/error/canceled）必须关闭 browser、static server、ffmpeg 子进程；进程退出时统一 teardown。

---

## 4. 仓库内 Client（TypeScript）

新增 `src/libs/player/render-service-client.ts`，导出 `renderViaService(params)` 及底层 `RenderServiceClient`。职责：

1. **探活（probe）**：`GET /healthz`，**短超时**（默认 1500ms，可配）。失败即判定服务不可用。
2. **提交（submit）**：`POST /jobs`，携带 `explainerDir`、`gpu`、`crf/preset/fps`。
3. **流式进度（stream）**：优先连 `GET /jobs/:id/events`（SSE），把 `{ framesRendered, totalFrames }` 转调已有 `onProgress(renderedFrames, totalFrames)` 回调；SSE 不可用或断开时降级为 `GET /jobs/:id` 轮询（默认 2s）。
4. **完成校验（verify）**：job `done` 后校验共享目录产物：`explainer-video.mp4` 存在、字节数 > 0、`ffprobe` 时长 ≈ `totalDurationSec`（容差）；`explainer-grid.jpg` 可选（缺失仅告警，与现有 grid "non-fatal" 一致）。
5. **错误与重试**：
   - 网络抖动（ECONNRESET/超时）对**探活与状态轮询**做有限重试（默认 3 次指数退避）；
   - job 本身返回 `error` **不重试**（宿主渲染失败是真实失败，必须冒泡）；
   - `401/400/429` 直接抛出明确错误（token 错 / 路径非法 / 队列满）。
6. **取消传播**：接受 `AbortSignal`，abort 时调用 `POST /jobs/:id/cancel` 并清理 SSE 连接。

接口示意（非最终实现）：

```ts
export interface RenderServiceOptions {
  baseUrl: string;            // e.g. http://192.168.64.1:8790
  token: string;
  gpu?: 'default' | 'gpu' | 'metal' | 'vulkan' | 'swiftshader';
  probeTimeoutMs?: number;    // default 1500
  pollIntervalMs?: number;    // default 2000
  signal?: AbortSignal;
}
export interface RenderViaServiceParams extends RenderServiceOptions {
  explainerDir: string;
  timeline: { resolution: { width: number; height: number }; fps: number; totalDurationSec: number };
  outVideoPath: string;
  crf?: number; preset?: string;
  onProgress?: (rendered: number, total: number) => void;
}
export async function probeRenderService(o: RenderServiceOptions): Promise<boolean>;
export async function renderViaService(p: RenderViaServiceParams): Promise<RenderExplainerVideoResult>;
```

---

## 5. 集成点（`renderExplainerVideo()` 路由，无静默兜底）

修改 `src/libs/player/render.ts` 的 `renderExplainerVideo()`，在函数**最前面**加路由决策：

### 5.1 触发条件

服务被"配置"视为以下任一：
- env `EXPLAINER_RENDER_SERVICE`（URL），可选 `EXPLAINER_RENDER_SERVICE_TOKEN`；或
- 新增可选参数 `params.renderService = { url, token, gpu }`（由 `produceExplainerVideo` 透传，CLI 注入）。

### 5.2 决策与**大声日志**（关键：no silent fallback）

```
if (serviceConfigured) {
  log: "[render] render service configured: <url> (gpu=<mode>) — probing /healthz ..."
  healthy = await probeRenderService(...)
  if (healthy) {
    log: "[render] ROUTING TO HOST RENDER SERVICE <url> (gpu=<mode>)"  // 明确说明走服务
    return await renderViaService(...)
  } else {
    // 配置了却探活失败：fail fast，绝不静默回退本地
    throw new Error(
      "[render] render service <url> is CONFIGURED but UNHEALTHY (probe failed). " +
      "Refusing to silently fall back to the slow VM renderer. " +
      "Fix the host service, or unset EXPLAINER_RENDER_SERVICE / pass --local-render to render locally."
    )
  }
}
log: "[render] no render service configured — rendering locally on this machine"
// ...既有本地逐帧渲染逻辑原样保留...
```

### 5.3 服务配置但宕机时的明确行为

- **fail fast**：抛出上面的明确错误（符合项目铁律：禁止隐藏问题的兜底）。
- **用户如何显式选择本地渲染**：
  - 不设置 / `unset EXPLAINER_RENDER_SERVICE`；或
  - 新增显式开关 `--local-render`（CLI）/ `params.forceLocalRender = true`，此时**跳过服务路由**，直接本地渲染，并打印 `"[render] --local-render set — bypassing render service"`。
- `renderViaService` 内部产物校验失败同样 fail fast（不回退本地）。

### 5.4 透传链

`cli.ts` → `executeXHotPipeline`/`createExplainerVideo` options → `produceExplainerVideo` options → `renderExplainerVideo` params。沿途新增可选字段 `renderService?: { url; token; gpu }` 与 `forceLocalRender?: boolean`，默认全部可选、不破坏既有签名。

---

## 6. CLI 与脚本（CLI Surface & Launchers）

### 6.1 VM 侧 CLI（`src/pipelines/xhot/cli.ts`，`attachXHotOptions`）

新增选项（与现有 `--explainer-gl` 并存）：
- `--render-service <url>` → 设 `process.env.EXPLAINER_RENDER_SERVICE`
- `--render-service-token <token>` → 设 `process.env.EXPLAINER_RENDER_SERVICE_TOKEN`
- `--render-gpu <mode>` → 透传服务端 GPU 模式（`default|gpu|metal|vulkan|swiftshader`）；未设时沿用 `--explainer-gl`
- `--local-render` → 设 `forceLocalRender`，显式本地渲染
- 处理位置：在现有 `if (opts.explainerGl) process.env.EXPLAINER_CHROMIUM_GL = ...` 附近统一注入 env / baseOptions。

### 6.2 package.json 脚本

- `"render-service": "node host-render/server.mjs"` —— 但注意：`host-render/*.mjs` 是**生成产物**，不是源文件。因此脚本改为运行**源模板导出**的启动器更稳妥：
  - 新增 `src/libs/player/render-service-entry.ts`（thin wrapper，便于 `tsx` 直接起本地开发用服务做联调）：`"render-service": "tsx src/libs/player/render-service-entry.ts"`。
  - 宿主生产环境仍用随 bundle 生成的 `host-render/server.mjs`（零项目依赖，只靠 `playwright-core` + 内置模块），由 `.command` 启动（§6.3）。

### 6.3 宿主启动器（镜像现有 `.command` UX）

在 `writeHostRenderScript()` 产物目录**额外生成** `start-render-service.command`（可双击），内容要点：
- 检查 `node`/`ffmpeg` 存在（复用现有 `.command` 的 `fail()` 风格）。
- 读取同目录 `.render-service.env`（可选）获取 `RENDER_SERVICE_TOKEN`/端口/GPU，或用内置默认。
- 执行：`node "<dir>/host-render/server.mjs" --port 8790 --gpu metal --bind 192.168.64.1 --token "$RENDER_SERVICE_TOKEN"`
- 常驻前台输出日志；`trap` 处理 `INT/TERM` 优雅退出（关子进程）。
- 与现有 `render-on-host.command` 并列，保留后者作为"单次人工渲染"兜底 UX。

> 说明：`server.mjs` / `render-core.mjs` 的**内容模板**写在 `host-script.ts`（与现有 `HOST_RENDERER_SOURCE` 同机制），在每次 explainer 生成时落盘。token/port/gpu 走 CLI/env，不硬编码进模板。

---

## 7. 文件清单（Create / Modify，含职责）

### 新建（Create）

| 路径 | 职责 |
| --- | --- |
| `src/libs/player/render-service-client.ts` | VM 侧 client：`probeRenderService` / `renderViaService` / `RenderServiceClient`（探活、提交、SSE/轮询进度、取消、产物校验）。 |
| `src/libs/player/render-service-entry.ts` | 本地开发/联调用的服务启动器（`tsx` 直跑），解析 `--port/--gpu/--token/--bind`，调用共享渲染核心。 |
| `Docs/plan-explainer-host-render-service.md` | 本计划文档（已在 `Docs/`）。 |
| （生成产物，模板位于 `host-script.ts`）`host-render/server.mjs` | 宿主常驻 HTTP 服务：端点、鉴权、allow-list、单任务串行队列、idle/job 超时、SSE 进度、产物回写共享目录。 |
| （生成产物，模板位于 `host-script.ts`）`host-render/render-core.mjs` | 从现有 `render.mjs` 抽出的可复用渲染函数（static server → Playwright 抓帧 → ffmpeg → mux → grid），供 server 与单次 `.command` 共用。 |
| （生成产物）`start-render-service.command` | 双击启动宿主服务的 bash 启动器（镜像现有 `.command` UX）。 |

### 修改（Modify）

| 路径 | 改动 |
| --- | --- |
| `src/libs/player/render.ts` | `renderExplainerVideo()` 顶部加服务路由（§5）；新增 `params.renderService`/`forceLocalRender`；大声日志；fail-fast（无静默回退）。本地渲染逻辑原样保留。 |
| `src/libs/player/host-script.ts` | 新增 `server.mjs` / `render-core.mjs` 模板常量；把现有 `HOST_RENDERER_SOURCE` 重构为调用 `render-core.mjs`；`writeHostRenderScript()` 额外产出 `start-render-service.command`；导出新文件名常量。 |
| `src/modules/explainer-video/produce.ts` | 把 `renderService`/`forceLocalRender` 透传进 `renderExplainerVideo()`。 |
| `src/modules/explainer-video/contracts.ts` | `ExplainerProduceOptions` / `CreateExplainerVideoOptions` 增加可选 `renderService?` / `forceLocalRender?`。 |
| `src/pipelines/xhot/cli.ts` | `attachXHotOptions` 新增 `--render-service` / `--render-service-token` / `--render-gpu` / `--local-render`；在 `handleXHotCommand` 注入 env / baseOptions。 |
| `src/pipelines/xhot/contracts.ts`（如存在相应 options 类型） | 增加对应字段透传（若编排层需要）。 |
| `package.json` | 新增 `"render-service": "tsx src/libs/player/render-service-entry.ts"` 脚本。 |
| `.gitignore` | 追加生成产物/运行期文件忽略：`host-render/`、`*.command`、`.render-service.env`、`render-service.log`（见 §10 铁律）。 |

> 说明：`host-render/` 产物已落在 run 目录（`artifacts/...`，已被 `artifacts/` 忽略）；此处显式再加一条根级忽略，确保任何位置生成的 `host-render/` 与 `.command`/`.env` 都不入库。

---

## 8. 测试计划（Testing，含精确命令）

> 铁律：测试起的任何进程（服务/浏览器/ffmpeg）测试后必须清理（§10）。

### 8.1 单元测试（client probe / retry / error）

新增 `tests/render-service-client.test.ts`（`node:test` + 内置 `http` 起 fake server）：
- probe 成功 / 探活超时 / 非 200 → 返回布尔正确。
- 提交返回 `jobId`；轮询状态直至 `done`，`onProgress` 收到递增 `rendered/total`。
- job `error` → 抛出且**不重试**；`401`/`400`/`429` → 对应明确错误。
- 网络抖动（fake server 首次 reset）→ 探活/轮询有限重试后成功。
- `AbortSignal` → 触发 `cancel` 调用。

命令：
```bash
cd /mnt/share/VM/AIGC-pipeline
npx tsx --test tests/render-service-client.test.ts
```

### 8.2 集成测试（fake service 全流程）

新增 `tests/render-service-integration.test.ts`：起一个**假服务**（不跑真浏览器，直接把一个预置的小 mp4/jpg 写入临时 `explainerDir`，并通过 SSE 发若干 `progress` 后发 `done`），验证 `renderViaService` 端到端：提交 → 进度回调 → 产物校验（`ffprobe` 时长 > 0）→ 返回 `RenderExplainerVideoResult`。服务在 `after()` 钩子里关闭。

命令：
```bash
cd /mnt/share/VM/AIGC-pipeline
npx tsx --test tests/render-service-integration.test.ts
```

### 8.3 宿主真实端到端冒烟（host smoke，手动一次）

在 **macOS 宿主**上：
```bash
# 1) 起服务（前台，Metal GPU）
cd /mnt/share/VM/AIGC-pipeline/<某个已有 artifacts run>/explainer
node host-render/server.mjs --port 8790 --gpu metal --bind 192.168.64.1 --token testtoken &
SVC_PID=$!

# 2) 从 VM 探活 + 提交一帧级小时长 run（或用已有 run）
curl -s http://192.168.64.1:8790/healthz
```
在 **VM** 上用真实 pipeline 冒烟：
```bash
cd /mnt/share/VM/AIGC-pipeline
EXPLAINER_RENDER_SERVICE=http://192.168.64.1:8790 \
EXPLAINER_RENDER_SERVICE_TOKEN=testtoken \
npx tsx src/cli.ts xhot --resume "<已有 runDir>" --render-gpu metal
```
清理（务必）：
```bash
kill "$SVC_PID" 2>/dev/null || true   # 在宿主执行
# 或在服务端用 --idle-timeout 让其自动退出
```
验收：VM 日志出现 `ROUTING TO HOST RENDER SERVICE`；run 目录出现 `explainer-video.mp4`（`ffprobe` 时长 ≈ 旁白时长）；无遗留 node/ffmpeg 进程。

### 8.4 回归

```bash
cd /mnt/share/VM/AIGC-pipeline
npm run build
npm test
```
确认不配置服务时本地渲染路径不变（`--local-render` 与未配置 env 行为一致）。

---

## 9. 风险与回滚（Risks & Rollback）

### 风险
- **GPU 争用/崩溃**：Apple Silicon 上 ANGLE-Metal 偶发不稳。缓解：单任务串行；`gpu/metal` 后以 `rendererInfo` 断言实际后端（复用 render.ts 既有断言思路），非预期后端 fail fast。
- **SSE 断连导致进度假死**：已用状态轮询兜底；并设 `job-timeout` 墙钟上限。
- **共享目录一致性**：NFS/9p 缓存可能导致 client 看不到刚写的 mp4。缓解：写完 `fsync` + client 轮询文件大小稳定后再校验。
- **鉴权泄漏**：token 走 env/`.render-service.env`（已 gitignore），不入日志明文（只打印"token 启用"）。
- **端口占用/防火墙**：启动失败大声报错；`--bind`/`--port` 可配。
- **与 `acquirePipelineLock` 的交互**：渲染服务在宿主，不抢 VM 的 Chromium profile 锁；需确认不引入新锁冲突（走服务时 VM 不再本地起渲染浏览器）。

### 回滚
- 代码层：新增字段/选项全部可选，默认关闭。**不设置** `EXPLAINER_RENDER_SERVICE` 即完全回到既有本地渲染行为。
- 运行层：`--local-render` 一键绕过服务。
- 物理回滚：revert 本次改动的文件（§7 列表）即可，`host-render/` 为生成产物，删除 run 目录即清除。

---

## 10. 必须重申的编码铁律（Coding Rules — MUST）

- **禁止隐藏问题的兜底（no silent fallback）**：服务配置但探活失败 → **fail fast** 并给出明确可操作错误；绝不静默切回慢速 VM 渲染。路由决策与原因必须**大声日志**。
- **测试后清理所有进程**：单测/集成/冒烟启动的 server、浏览器、ffmpeg 子进程必须在测试 teardown / `kill` 中全部回收，不留僵尸进程与占用端口。
- **生成数据进 `.gitignore`**：`host-render/`、`*.command`、`.render-service.env`、`render-service.log` 及所有媒体产物均不得入库（§7 已列 `.gitignore` 改动）。
- **计划文档位于 `Docs/`**：本文件为 `Docs/plan-explainer-host-render-service.md`。

---

## 11. 验收标准（Acceptance Criteria）

- [ ] 宿主可用 `node host-render/server.mjs --port 8790 --gpu metal --bind 192.168.64.1 --token <t>` 启动常驻服务，启动日志打印 bind/port/gpu/浏览器路径/token 启用/allow-list 根目录。
- [ ] `GET /healthz` 无需鉴权且短超时可探活；其余端点无/错 token 返回 `401`。
- [ ] `explainerDir` 不在 `/mnt/share/VM/AIGC-pipeline/artifacts` 下返回 `400`（allow-list 生效）。
- [ ] 单 GPU 串行：并发提交时第二个任务排队或 `429`，不会并行渲染。
- [ ] `--idle-timeout` / `--job-timeout` 生效：空闲自动退出、超时 job 被杀并置 `error`。
- [ ] VM 侧 `renderViaService` 能提交任务、经 SSE（断线则轮询）把进度喂入 `onProgress`、支持取消、完成后校验共享目录 `explainer-video.mp4`（`ffprobe` 时长 > 0）。
- [ ] `renderExplainerVideo()`：配置且健康 → 日志出现 `ROUTING TO HOST RENDER SERVICE` 并走服务；配置但宕机 → **fail fast** 明确报错，无静默回退；`--local-render`/未配置 → 本地渲染且日志说明。
- [ ] CLI 新增 `--render-service` / `--render-service-token` / `--render-gpu` / `--local-render` 可用并正确注入 env/options。
- [ ] `package.json` 新增 `render-service` 脚本；`writeHostRenderScript()` 产出 `start-render-service.command`（可双击、含 node/ffmpeg 检查与优雅退出）。
- [ ] `npx tsx --test tests/render-service-client.test.ts` 与 `tests/render-service-integration.test.ts` 全绿。
- [ ] 宿主真实端到端冒烟产出有效 mp4 且测试后无遗留进程。
- [ ] `npm run build` 通过；`npm test` 回归通过；不配置服务时行为与改动前一致。
- [ ] `.gitignore` 已忽略 `host-render/` / `*.command` / `.render-service.env` / `render-service.log`；无生成产物被提交。

---

## IMPLEMENTATION NOTES

### What was implemented

| File | Status | Notes |
| --- | --- | --- |
| `src/libs/player/render-service-client.ts` | created | `RenderServiceClient`, `probeRenderService`, `renderViaService`, `verifyRenderedVideo`, `waitForStableFile`, `resolveRenderServiceGpuMode`, `RenderServiceError`. Fetch-based (Node 24), SSE + polling fallback, bounded retries for probe/status only, 401/400/429 mapped to explicit errors, artifact verification with ffprobe. |
| `src/libs/player/render-service-entry.ts` | created | `npm run render-service` wrapper. Materialises the generated templates under `.tmp/render-service/` and spawns `host-render/server.mjs`, forwarding SIGINT/SIGTERM and the exit code. |
| `src/libs/player/host-script.ts` | modified | Added `HOST_RENDER_CORE_SOURCE` (`render-core.mjs`), `HOST_RENDER_SERVER_SOURCE` (`server.mjs`), `start-render-service.command`. `render.mjs` is now a thin CLI over `render-core.mjs`. `writeHostRenderScript()` writes all five files and returns their paths. |
| `src/libs/player/render.ts` | modified | `renderExplainerVideo()` routes to the service first; `renderService` / `forceLocalRender` params added; loud routing logs; fail-fast when configured-but-unhealthy or token missing. Local render path untouched. |
| `src/modules/explainer-video/produce.ts` | modified | Passes `renderService` / `forceLocalRender` through. |
| `src/modules/explainer-video/video.ts` | modified | Same pass-through in `createExplainerVideo()`. |
| `src/modules/explainer-video/contracts.ts` | modified | Optional `renderService` / `forceLocalRender` on both option types. |
| `src/pipelines/xhot/cli.ts` | modified | `--render-service`, `--render-service-token`, `--render-gpu`, `--local-render`; injects env + `baseOptions`; resume path forwards them too. |
| `src/pipelines/xhot/contracts.ts` | modified | Optional `renderService` / `forceLocalRender` in `XHotPipelineOptionsSchema`. |
| `src/pipelines/xhot/execute.ts` | modified | Forwards both fields to `createExplainerVideo()`. |
| `src/pipelines/xhot/resume.ts` | modified | Forwards both fields to `renderExplainerVideo()`. |
| `src/libs/player/index.ts` | modified | Re-exports the client. |
| `package.json` | modified | `"render-service": "tsx src/libs/player/render-service-entry.ts"`. |
| `.gitignore` | modified | `host-render/`, `*.command`, `.render-service.env`, `render-service.log`. |
| `tests/render-service-client.test.ts` | created | 11 tests (probe, timeout, non-200, ECONNRESET retry, polling progress, SSE, no-retry on job error, 401/400/429, abort→cancel, routing fail-fast, missing token). |
| `tests/render-service-integration.test.ts` | created | Fake service writes a real MP4 into the shared dir, streams SSE progress, client verifies duration and copies to the VM-side path. |

### Decisions / deviations from the plan

1. **`render-service-entry.ts` spawns the generated server** instead of importing a TS service implementation. The production service must stay dependency-minimal and lives in the `host-script.ts` templates; duplicating ~700 lines in TS would guarantee drift. The wrapper regenerates the templates into `.tmp/render-service/` (gitignored) and executes exactly the file the macOS host runs.
2. **Host default engine is `chromium`** (plan was silent). GPU flags (`--use-angle=metal` etc.) only exist for Chromium; `--engine firefox` is still supported and **rejects** `--gpu != default` loudly instead of silently ignoring the flags. The old generated `render.mjs` preferred Firefox when installed; that default changed.
3. **Grid is generated on the host with ffmpeg** (`fps=…,scale=…,tile=3x3`) because `sharp` (native) cannot load from the VM's `node_modules` on macOS. Grid failure is non-fatal and logged, matching `produce.ts` behaviour. `produce.ts` still rebuilds the grid on the VM for the report.
4. **Artifact verification tolerance** is `max(1.5 s, 2 % of timeline duration)`. Files are read only after their size is stable across two polls (NFS/9p guard).
5. **HTTP result fallback downloads to `outVideoPath`**, not to the invisible shared path, so the fallback actually works when the share is not mounted.
6. **`silentVideoPath`** in the returned result is the host's `explainer-silent.mp4` when visible, otherwise `''` (the service does not transfer the intermediate).
7. **Cancellation** is implemented in the client (`AbortSignal` → `POST /jobs/:id/cancel`). `renderExplainerVideo()` itself still has no `signal` parameter, so the pipeline currently cancels only by terminating the job on the host (job timeout / service shutdown).
8. **Extra safety**: the service refuses to start without a token, refuses `--bind 0.0.0.0` unless `RENDER_SERVICE_ALLOW_ANY_BIND=1`, and refuses to start when the default engine's browser is not found.
9. **No lint script exists** in this repo (no ESLint/Prettier/Biome config or binary). Static checking is `npx tsc --noEmit` (same compiler settings as `npm run build`).

### How to run the service

Host (macOS), one-time setup in the explainer bundle directory:

```bash
# <runDir>/explainer/.render-service.env  (gitignored)
RENDER_SERVICE_TOKEN=change-me
RENDER_SERVICE_PORT=8790
RENDER_SERVICE_GPU=metal
RENDER_SERVICE_BIND=192.168.64.1
```

Then double-click `start-render-service.command` in `<runDir>/explainer/`, or run:

```bash
node <runDir>/explainer/host-render/server.mjs \
  --port 8790 --gpu metal --bind 192.168.64.1 --token "$RENDER_SERVICE_TOKEN"
```

VM side:

```bash
cd /mnt/share/VM/AIGC-pipeline
EXPLAINER_RENDER_SERVICE=http://192.168.64.1:8790 \
EXPLAINER_RENDER_SERVICE_TOKEN=change-me \
npx tsx src/cli.ts xhot --resume "<runDir>" --render-gpu metal
# or explicitly local:
npx tsx src/cli.ts xhot --resume "<runDir>" --local-render
```

Local development of the service on the VM:

```bash
npm run render-service -- --port 8790 --bind 127.0.0.1 --gpu default --token devtoken \
  --allow-root /mnt/share/VM/AIGC-pipeline/artifacts
```

### Verification performed

```bash
npx tsc --noEmit
# exit 0

npm run build
# exit 0

npx tsx --test tests/render-service-client.test.ts
# 11 tests, 11 pass

npx tsx --test tests/render-service-integration.test.ts
# 1 test, 1 pass

npm test
# 272 tests, 272 pass, 0 fail
```

Live smoke of the generated server on this VM (`--bind 127.0.0.1 --gpu default`):
`/healthz` → 200 JSON with bind/gpu/browser/queue info; unauthenticated `POST /jobs` → 401;
path outside the allow-list → 400; unknown job → 404; SIGTERM → graceful shutdown, no
leftover `node`/`ffmpeg` processes (verified with `ps`).

### Remaining manual steps

1. Start the service on the **macOS host** (double-click `start-render-service.command` or the `node` command above) and confirm the startup banner shows the expected bind/port/GPU/browser/allow-list.
2. Run the real end-to-end smoke from §8.3 against an existing run and confirm `ROUTING TO HOST RENDER SERVICE` plus a valid `explainer-video.mp4` (ffprobe duration ≈ narration duration).
3. Keep the VM-side `.render-service.env` out of version control (already gitignored) and rotate the token if it was ever pasted into a log.
