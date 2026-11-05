# 实施计划：explainer-video 内容/效果分离 + 运行时拆分 + WebGL 转场

> 依据：`Docs/explainer-video-优化计划.md`（P0 → P4）。
> 状态：P0/P1/P2/P3 已实现并验证；P4 部分完成（见文末进度）。

## 交付物一览

| 阶段 | 交付物 |
|---|---|
| P0 | `player.ts` locate 首帧修复、seeded 颗粒、`render.ts` chunk hash manifest + 清理、xhot 严格 storyboard 校验、引擎/preset 统一、硬编码路径清理、吞异常改 warning |
| P1 | 新增 `src/libs/player/style.ts`（`ExplainerStyleSchema` + 预设 + 合并/覆盖）；`contracts.ts` 新增 `StoryboardContentSchema` / `migrateLegacyStoryboard()` / `attachVoiceTimings()`；`tts.ts` 改纯函数（时序全部来自 style）；`produce.ts` 新增 `style` 选项并写出 `storyboard.json / style.json / voice.json`；播放器读 `explainer-style`；组件化 `component:flash` / `component:final-showcase`；两处 LLM prompt 去掉效果字段；CLI `--style` |
| P2 | `PLAYER_JS` 拆成 `src/libs/player/runtime/*.js`，esbuild 打成 IIFE；`drawShot` 改布局注册表；删除 `tutorial-*` 双份嵌入、别名文件、兼容 DOM、scenes 转换 |
| P3 | `runtime/gl.js`（WebGL 后期 + shader 转场，Canvas2D 自动回退）、`runtime/transitions/*.glsl`（7 个，gl-transitions 接口）、`?transitionLab=1` 预览页 |
| P4 | 帧导出/转场去重复绘制/ETA 日志/TTS 静音缓存 + 并发合成 |

## 关键决策

1. **style.json 与 storyboard.json 同在本次产物目录**（`explainer/`），内置预设模板放 `src/libs/player/styles/`。
2. **转场选择**：`style.transitions.clip.mode = "sequence"`（默认，按 pool 顺序轮换）或 `"seed"`（按 seed 伪随机）。`overrides` 可把某个转场固定到指定 clip/shot（例如进入最后一章用 `radialBloom`）。
3. **标题时序唯一来源**：`style.timing.titleIn/titleHold/titleOut`，TTS 的 `titleSafe = titleIn + titleHold + titleOut + titleSafePad(0.1)`。默认 0.55/1.10/0.55 → 2.30s，与现有音频时长完全一致，同时修掉标题卡压内容的 1.7s（C9）。
4. **渲染器**：`post.renderer = "webgl" | "canvas2d"`。探测 `webgl2`（GLSL ES 1.00 shader，兼容 gl-transitions 写法）失败则自动回退 canvas2d 并打 warning。Linux/macOS 渲染机有 GPU，不使用 SwiftShader 参数。
5. **组件化**：`component:flash` / `component:final-showcase`。素材用 `tags` 选择（`components.flash.pool = "tag:candidate"`），旧魔法 ID（`flash`、`flash:*`、`xhot-candidate-grid`、`final-ai-video`）在加载时映射并打一次 deprecation warning。
6. **TTS 纯函数**：`buildOpusVoiceTrack` 不再写回 clip/shot；播放器运行时合并 voice。`qa.ts` 用 `attachVoiceTimings()` 在内存里补时序。
7. **删除 legacy 输出**：`tutorial-*` 别名文件/ID、`window.__tutorial`、`scenes` 转换、兼容 DOM。已 grep 确认 `tests/`、`scripts/`、`src/`（除 `src/tutorial/` 遗留树）无依赖。

## 验收

- P0：首帧为第一章标题；改 narration 重渲染不复用旧 chunk；同帧 seek 两次截图逐像素一致。
- P1：同 storyboard 两个 style 出两种风格；同 style 两份 storyboard 风格一致；旧 storyboard 迁移后能渲染；新 storyboard 无效果字段（单测）。
- P2：拆分前后同一 timeline 10 个时间点截帧 diff 为 0；HTML 体积下降。
- P3：每个转场 progress 0/0.5/1 截帧符合预期；WebGL 不可用自动回退且能出片；benchmark 记录 canvas2d / webgl 单帧耗时。
- P4：对 `flowTutor-1793604323391-9wvalm` 重渲染记录总耗时；音画对齐误差 ≤ 1 帧。

## 测试

新增 `tests/explainer-style.test.ts`（style 合并/覆盖、旧格式迁移、storyboard 无效果字段、chunk hash 失效、locate 首帧、组件映射）。

---

## 进度（2026-11-03）

### 已完成并验证

| 阶段 | 状态 | 验证方式 |
|---|---|---|
| P0 B1 首帧契约 | ✅ | `locateClip()` 抽到 `runtime/timeline.js`，core.js 只做薄封装；单测 + 截帧确认 t=0.3s 起是第一章标题卡，不再从末章转场进来 |
| P0 B2 chunk 失效 | ✅ | `.render-chunks/manifest.json` 记录 `timeline + player + explainer/style/voice` 的 sha256；hash 不一致或缺少 manifest 时清空旧 chunk；单测覆盖 |
| P0 B3 确定性颗粒 | ✅ | `initNoise(seed)` + `hash21`，同一帧两次 seek 逐像素一致 |
| P0 B4 xhot 严格校验 | ✅ | 走 `buildExplainerStoryboardSchema`（素材 ID + 图标名） |
| P0 B5/B6/B7 | ✅ | 默认引擎统一 chromium、preset 统一 `medium`；硬编码 Playwright 路径删除；素材拷贝失败抛错而不是 `catch {}` |
| P1 内容/效果分离 | ✅ | `style.ts` + `StoryboardContentSchema` + `migrateLegacyStoryboard()` + `attachVoiceTimings()`；产物目录同时写 `style.json / voice.json / storyboard.json` |
| P1 CLI | ✅ | `--style <path|preset:name>`、`--transition <name>`：tutorial CLI（含 `--rebuild`）、flowtutor（`--tutorial-style/--tutorial-transition`）、xhot（`--explainer-style/--explainer-transition`）、explainer-video 模块 |
| P2 运行时拆分 | ✅ | `PLAYER_JS` → `runtime/{core,env,layout,components,bg,post,media,gl,util,timeline}.js`，esbuild 打成 IIFE；`LAYOUTS` 注册表；legacy `tutorial-*` 输出全部删除 |
| P3 WebGL 后期 + shader 转场 | ✅ | 7 个转场（directionalWarp / lumaGlitch / radialBloom / crossZoom / dreamyZoom / displacement / emberBurn）；`?transitionLab=1` 预览页；WebGL 不可用回退 canvas2d |
| P3 渲染器日志 | ✅ | `[render] player renderer: webgl (ANGLE ...)` + 播放器 warning 一并输出 |
| P4 TTS 提速 | ✅ | 逐行并发（默认 2）+ 静音按时长缓存复用 |
| P4 帧导出 | ✅ | 默认 raw RGBA 回读（`-f rawvideo`），比 PNG 截图快 30%；host 脚本同步 |
| P4 ETA 日志 | ✅ | `n/总帧 · s/frame · ETA mm:ss` |

### 本轮修掉的真实 bug

1. **shader 编译失败**：`uniform vec2 ratio` 与 shader 里 `vec2(ratio, 1.0)` / `centered.x *= ratio` 的写法冲突（`radialBloom` / `displacement` / `emberBurn` 全部编译失败 → 转场期间直接抛错）。改为 gl-transitions 约定的 `uniform float ratio` + `uniform1f`。
2. **shader 报错不可定位**：`compile()` 现在把驱动日志里的行号对应的源码行一起抛出。
3. **磁盘上的 storyboard 仍带效果字段**：`StoryboardContentSchema.parse()` 会把 `meta.bg/accent/font/shot*` 的默认值重新补回去，导致写盘的 `storyboard.json` 依然“不纯”。新增 `storyboardForDisk()`，`produce.ts` 与 tutorial 产物写入都经过它（单测断言 `collectStoryboardEffectFields()` 为空）。
4. **xhot 干跑测试过期断言**：`report.md` / `result.json` 在 `0f792b2` 已统一为 `FINAL_REPORT.*`，测试同步更新。
5. **`--rebuild` 对旧产物直接报错**：现在改为先用 `migrateLegacyStoryboard()` 把 `explainer.json` 里的效果字段迁移成 `style.json` 再渲染（抽成 `resolveRebuildStyle()` 并有单测），真正的空产物才报错。

### 实测数据（本机 SwiftShader 软件 GL，1920×1080）

| 项目 | 改造前 | 改造后 |
|---|---|---|
| `explainer-player.html` | 990 KB | 456 KB |
| 单帧 seek（canvas2d） | — | 181.7 ms avg / 485.1 ms p95 |
| 单帧 seek（webgl） | — | 105.1 ms avg / 404.3 ms p95 |
| 单帧 PNG 截图 | — | 656 ms |
| 单帧 raw 回读 | — | 362 ms（PSNR 63.7 dB vs PNG，视觉一致） |
| 端到端 150 帧 · canvas2d + raw | — | **0.522 s/帧** |
| 端到端 150 帧 · webgl + raw | — | **0.572 s/帧** |
| 端到端 150 帧 · canvas2d + png | — | 0.816 s/帧 |
| 端到端 150 帧 · webgl + png | — | 0.812 s/帧 |
| 旧全量渲染基线 | 0.76 s/帧（2 worker ≈ 1.5 s/帧/worker） | — |

结论：
1. **帧导出改成 raw RGBA 回读**（`render.ts` 默认 `frameExport: 'raw'`，`EXPLAINER_FRAME_EXPORT=png` 可回退），单帧端到端快 **30%**；host 渲染脚本同步改造。
2. 软件 GL（SwiftShader）下把后期搬到 GPU 收益有限（seek 181→105 ms），端到端与 canvas2d 基本持平；硬件 GL 机器才会拉开差距。

### 待办（P4 剩余）

1. 转场期间 `drawBG` 重复绘制（F4）。
2. 用完整 `flowTutor-1793604323391-9wvalm` 产物跑一次全量重渲染，记录总耗时与音画对齐（本次只跑了 150–600 帧切片）。
3. canvas2d 与 webgl 画面尚未做到逐像素一致（PSNR ≈ 33 dB，主要是颗粒与 halation 强度差异），需要按 `post` 参数逐项对齐。
4. 硬件 GL 渲染机上重跑 `scripts/bench-explainer-render.ts`，确认 GPU 路径的 seek 收益能体现在端到端耗时上。
