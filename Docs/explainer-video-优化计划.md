# explainer-video 模块优化计划

> 状态：计划稿，未开发。
> 范围：`src/modules/explainer-video/*`（编排层）+ `src/libs/player/*`（实际的 TTS / 播放器 / 渲染实现）。
> 两条硬约束：
> 1. **脚本 JSON 只放内容，效果单独配置**，两者独立加载、独立版本化。
> 2. **转场改用 WebGL shader 实现**，保留 Canvas2D 作为回退。

---

## 1. 现状

```
xhot / flowtutor 管线
  └─ modules/explainer-video
       ├─ video.ts     素材打包 + LLM 生成 storyboard（xhot 专用）
       └─ produce.ts   公共尾段：TTS → timeline → 播放器 bundle → 逐帧渲染 → 宫格图 → summary
            └─ libs/player
                 ├─ tts.ts       buildOpusVoiceTrack：逐行 TTS + 静音拼接，生成 voice 时序
                 ├─ player.ts    写出 HTML/CSS/JS；PLAYER_JS 是约 1800 行的模板字符串（Canvas2D 引擎）
                 └─ render.ts    Playwright 打开播放器，seek(t) → screenshot(PNG) → ffmpeg 分块编码 → 合并 → 混音
```

实测数据（`artifacts/flowtutor/flowTutor-1793604323391-9wvalm/tutorial`）：
- 成片时长 157.3s，30fps，共 4719 帧。
- `config.json` 写出时间 00:23，最后一个 chunk 完成时间 01:23，渲染约 **60 分钟，约 0.76 s/帧**（2 个 worker）。
- `explainer-player.html` 990KB，`config.json` 408KB。
- `.render-chunks/` 渲染结束后残留 5 个 chunk，共约 63MB。

---

## 2. 发现的问题

### 2.1 内容和效果耦合（对应约束 1）

| # | 位置 | 问题 |
|---|---|---|
| C1 | `contracts.ts` `ExplainerMetaSchema` | storyboard 的 `meta` 混了效果参数：`bg / accent / font / design / shotDur / shotTrans / clipTrans`。`clip.bg` 和 `shot.camera` 也是效果参数。 |
| C2 | `video.ts:206-215` 的 LLM prompt 示例 | 要求 LLM 输出 `meta.bg`、`meta.accent`、`clip.bg`。实际产物里 5 个 clip 全是 `#0B0F19`，说明 LLM 只是在照抄示例。 |
| C3 | `src/tutorial/storyboard.ts:93,125` | 要求 LLM 输出 `camera {zoom,x,y,roll}`，镜头运动由脚本决定。 |
| C4 | `player.ts:383-403` | 调色板 `PAL`、`HALATION / GRAIN / CA_PX / VIGNETTE / CONTRAST`、标题时序 `TITLE_IN/HOLD/OUT` 全部硬编码，无法配置。 |
| C5 | `player.ts:1130, 1184, 1453` | Flash 组件的 0.2s 切换间隔和霓虹青 `#00F0FF` 硬编码，不跟随主题色（flowtutor 用橙色主题时 flash 仍然是青色）。 |
| C6 | `player.ts:1874` `transType = L.next % 3` | 转场类型按 clip 序号取模，写死在代码里，无法配置。 |
| C7 | `player.ts:672, 1424, 1472`；`tts.ts` | 特殊组件靠魔法 ID 识别：`flash`、`flash:*`、`xhot-candidate-grid`、`final-ai-video`、`candidate-*` / `cand-*` 正则。TTS 也对 `final-ai-video` 做特殊处理。组件、素材、行为三者混在一起。 |
| C8 | `tts.ts:1071` | `buildOpusVoiceTrack` 直接把 `vStart/vDur/vLines` 写回 storyboard 的 clip/shot 对象，TTS 计算出的时序污染了内容对象。`config.json` 的 clips 部分因此有 127KB，而且 timeline 和 voice.json 里各存一份。 |
| C9 | `tts.ts:860` 与 `player.ts:403` | 时序常量分在两处，且不一致：TTS 只给标题留 `TITLE_SAFE=2.30s` 静音，播放器的标题卡要到 `0.55+2.80+0.70=4.05s` 才完全淡出。结果是旁白和第一行字已经出现，标题卡和暗色光晕还压在内容上 1.7s 左右（需截帧确认）。 |

### 2.2 正确性 bug

| # | 位置 | 问题 |
|---|---|---|
| B1 | `player.ts` `locate()` | i=0 时 `prev=(i-1+N)%N`，所以视频**前 1 秒是从最后一章转场进第一章**。已截帧确认：0.3s 处画面是 "FINAL AI VIDEO SHOWCASE"，上面叠着第一章标题。这是 OpusVideo 循环播放逻辑遗留下来的。 |
| B2 | `render.ts:422` | 断点续跑只判断 chunk 文件大于 10KB，不校验 timeline。改了脚本或效果后重渲染，会直接复用旧 chunk，拼出新旧混合的视频。渲染成功后也不清理 `.render-chunks`。 |
| B3 | `player.ts:726, 1822` | 胶片颗粒用 `Math.random()` 生成，违反文件头声明的确定性 seek 契约：同一帧渲染两次结果不同，各 chunk/tab 的噪声也不连续。 |
| B4 | `produce.ts:348,365` | xhot 路径用的是宽松的 `ExplainerStoryboardSchema`，没有用已有的 `buildExplainerStoryboardSchema`（会绑定素材 ID 和图标名）。LLM 拼错的 visualRef 会静默退化成一个空心方框图标。 |
| B5 | `render.ts:186` vs `produce.ts` | 默认引擎不一致：render 默认 firefox，produce 默认 chromium。编码 preset 也不一致：`EXPLAINER_DEFAULTS.preset='medium'`，render 内部默认 `'ultrafast'`。 |
| B6 | `render.ts:208` | 硬编码了 `/home/piagent/.cache/ms-playwright/...` 路径。 |
| B7 | `video.ts` / `produce.ts` | 素材拷贝失败被 `catch {}` 吞掉，没有任何日志。`CreateExplainerVideoOptions.profileDir / width / height` 部分字段传入后没有被使用。 |

### 2.3 性能

| # | 位置 | 问题 |
|---|---|---|
| F1 | `player.ts:1816` `grade()` | 每帧 `getImageData` 读回 1920×1080，再用 JS 逐像素做色差、肩部压缩、对比度、暗角和颗粒（约 200 万像素 × 几十次运算），然后 `putImageData`。另外 `new Uint8ClampedArray(d)` 每帧复制约 8MB。这很可能是单帧最大的开销（需 profile 确认）。 |
| F2 | `player.ts:1796` `halate()` | 每帧对全屏 Canvas 做 `blur(27px)` 滤镜，CPU 光栅化下很慢。 |
| F3 | `render.ts` | 每帧走 `page.screenshot({type:'png'})`：浏览器合成、PNG 编码、经 CDP 传输，ffmpeg 再解码 PNG。 |
| F4 | `player.ts` 转场分支 | 转场期间 `drawBG` 和 `drawContent` 各执行两遍。 |
| F5 | `tts.ts` | 逐行串行合成，每段静音都单独起一次 ffmpeg 进程生成（同一时长的静音会重复生成）。 |
| F6 | `player.ts` `writeExplainerPlayer` | HTML 里 config/voice/icons/assets/timeline 以 `explainer-*` 和 `tutorial-*` 两套 ID 各嵌入一次。另外写出 4 个 legacy 别名文件和一些兼容用的空 DOM。 |

### 2.4 代码结构

- `PLAYER_JS` 是 TS 文件里的模板字符串：没有类型检查、没有 lint，正则必须写成双反斜杠（`\\s`），容易出错，也没法单独测试。
- `drawShot` 按顺序串接 flash / final / prompt / landscape / 标准双栏五个分支，新增一种布局就要改主流程。
- 遗留代码较多：`normalizeTimeline` 里的 scenes 转换、`buildChatCard` / `legacyColumnCheck` 的 `void` 占位、以及大量 `Tutorial*` 类型别名。

---

## 3. 目标设计：内容与效果分离

### 3.1 三类文件，各管一件事

| 文件 | 由谁产出 | 内容 | 禁止出现 |
|---|---|---|---|
| `storyboard.json`（脚本） | LLM | 章节 `id / kicker / title / subtitle`；镜头 `id / elements[[phrase, visualRef]] / narration[]`；visualRef 只能是素材 ID、图标名、图表名或组件引用（如 `component:flash`） | 颜色、字体、时长、相机、转场、任何时间字段 |
| `style.json`（效果） | 预设 + 人工 | 主题、排版、时序、组件参数、转场、后期、相机运动；可以按 clip/shot id 做局部覆盖 | narration 和 phrase 文案 |
| `voice.json`（时序） | TTS | 每行的 aStart/aDur/words，shot/clip 的 start/dur | 不回写 storyboard |

播放器启动时读取 `storyboard + style + voice + assets` 四份数据，各自独立。

`style.json` 与 `storyboard.json` 一样，每次运行写到本次产物目录（`explainer/` 下）。代码里的内置预设放在 `src/libs/player/styles/`，只作为模板，运行时复制进产物目录。

### 3.2 `style.json` 结构草案

```jsonc
{
  "version": "1",
  "extends": "preset:ember-dark",          // 内置预设：ember-dark / cyan-tech / apple-clean ...
  "theme": {
    "bg": "#0B0F19", "accent": "#00F0FF",
    "palette": { "bone": "#EEE9DF", "ash": "#9C978F", "graphite": "#5E5B57", "ember": "#FF8A3D" },
    "font": "\"D-DIN Exp\", Inter, system-ui, sans-serif"
  },
  "timing": {
    "titleIn": 0.55, "titleHold": 1.2, "titleOut": 0.55,   // 唯一来源，TTS 的 titleSafe 从这里推导
    "lineGap": 0.12, "shotGap": 0.18, "clipTail": 0.5,
    "shotTrans": 0.8, "clipTrans": 1.0
  },
  "components": {
    "flash":       { "interval": 0.2, "punch": 0.04, "shutter": 0.22, "border": "accent" },
    "finalShowcase": { "tag": "FINAL AI VIDEO SHOWCASE" },
    "subtitleBanner": { "enabled": false }
  },
  "camera": { "mode": "auto-drift", "zoomRange": [1.0, 1.06], "rollMax": 0.01 },
  "transitions": {
    "clip": { "mode": "sequence", "pool": ["directionalWarp", "lumaGlitch", "radialBloom"], "seed": 7 },
    "shot": { "type": "conveyor" },
    "visualSwap": { "type": "slide-fade" }
  },
  "post": {
    "renderer": "webgl",                 // webgl | canvas2d
    "halation": 0.30, "halationTint": "#FF2E0A",
    "grain": 0.05, "chromaticAberration": 2.0, "vignette": 0.35, "contrast": 1.05
  },
  "overrides": {
    "clip:c3_showcase": { "transitions": { "clip": { "type": "radialBloom" } } },
    "shot:s0_1": { "camera": { "mode": "static" } }
  }
}
```

合并优先级：内置默认 < 管线预设（`xhot` 和 `flowtutor` 各一份）< 运行目录下的 `style.json` < CLI 参数（`--style <path>`、`--transition <name>`）。

### 3.3 组件化替代魔法 ID

- 脚本中写 `component:flash` 或 `component:final-showcase`，素材池在 style 中声明，例如 `components.flash.pool = "tag:candidate"`。素材在打包时带上 `tags: ['candidate']`，替代当前的 `candidate-*` 文件名正则。
- 为兼容旧脚本，加载时把 `flash`、`flash:candidates`、`xhot-candidate-grid` 映射为 `component:flash`，把 `final-ai-video` 映射为 `component:final-showcase`，并输出一次 deprecation 警告。
- TTS 中"成片自带声音、不叠加旁白"的规则改由组件声明 `audio: "source"`，不再硬编码 `final-ai-video`。

### 3.4 迁移与兼容

- `ExplainerStoryboardSchema` 拆成 `StoryboardContentSchema`（严格模式，碰到效果字段时报 warning 并剥离）和 `ExplainerStyleSchema`。
- 读取旧 storyboard 时，`meta.bg/accent/font/shot*/clip*`、`clip.bg`、`shot.camera` 自动迁移到 style 的 `overrides` 中，旧产物可以重新渲染。
- 删除 `video.ts` 和 `tutorial/storyboard.ts` 两处 LLM prompt 中关于 meta 颜色和 camera 的要求，prompt 只描述内容结构，token 也会相应减少。
- `buildOpusVoiceTrack` 改为纯函数，只返回 `voiceData`，不修改传入的 clips；播放器在运行时把 voice 合并到 clips 上。

---

## 4. Shader 转场可行性

### 4.1 结论：可以做，而且收益不只是转场

代码注释里标的 "SHADER 1/2/3"（`player.ts:1870+`）实际是 Canvas2D 模拟：用 globalAlpha、平移和 clip 裁剪实现。改成真正的 WebGL 有两个收益：
1. **转场**：可以做像素级效果（位移扭曲、亮度擦除、色散故障、径向溶解等），这些 Canvas2D 做不到。
2. **后期**：`halate()` 和 `grade()` 可以一起移到 fragment shader 里。这两步目前在 CPU 上逐像素计算（F1、F2），移到 GPU 后预计单帧耗时会明显下降（需 benchmark 验证）。

### 4.2 架构

```
Canvas2D（保留现有绘制代码）
  drawBG + drawContent(cur)  ──► 离屏 canvas A ──┐ texImage2D
  drawBG + drawContent(next) ──► 离屏 canvas B ──┤
                                                 ▼
WebGL2 输出画布 #stage（preserveDrawingBuffer: true）
  Pass 1  transition.frag : mix(A, B, progress)  → FBO
          （非转场帧直接透传 A，或跳过这一 pass）
  Pass 2  post.frag : halation（可分离高斯两次 pass 或 mip 降采样）
                      + 色差 + 肩部压缩 + 对比度 + 暗角 + 颗粒 + flash
  → 屏幕
```

- **Shader 接口沿用 gl-transitions 规范**：`vec4 transition(vec2 uv)`，配合 `getFromColor / getToColor / progress / ratio`。[gl-transitions](https://github.com/gl-transitions/gl-transitions) 社区有 100 多个现成转场，按其仓库标注为 MIT 许可，可以挑选后 vendor 到 `src/libs/player/runtime/transitions/*.glsl`，参数通过 style 中的 `params` 传入 uniform。
- **首批转场**：
  - 把现有三种迁移为真 shader：`directionalWarp`、`lumaGlitch`（扫描线加 RGB 偏移）、`radialBloom`（带噪声边缘的径向擦除）。
  - 新增：`crossZoom`、`dreamyZoom`、`displacement`（用噪声纹理做位移）、`emberBurn`（自定义，烧边加橙色辉光，契合当前主题）。
- **镜头内的视觉切换**（右栏 prev→cur，`bCellA/bCellB`）也能复用同一个 transition pass 和 shader 库。镜头级转场目前是左右栏元素各自位移，属于排版动画，继续保留在 Canvas2D。
- **确定性**：
  - `progress` 只由时间 `t` 决定。
  - 噪声用 `hash(uv, frameIndex, seed)` 计算，同时修掉 B3。
  - seek(t) 的契约不变：等待媒体 seek 完成后再画一帧，再 `gl.finish()`。

### 4.3 运行环境风险

| 风险 | 处理 |
|---|---|
| 本地 Chromium 是 155 版。Chrome 从 M139 起取消了 SwiftShader 软件 WebGL 的自动回退，没有 GPU 时创建 WebGL 上下文会失败（[Chromium SwiftShader 文档](https://github.com/chromium/chromium/blob/main/docs/gpu/swiftshader.md)、[Samsung 策略说明](https://developer.samsung.com/browser/policy/enable-unsafe-swift-shader.html)） | macOS 和 Linux 渲染机都有 GPU，WebGL 走硬件加速，不需要 SwiftShader 启动参数。WebGL 探测失败时仍回退到 Canvas2D。 |
| WebGL 不可用 | 播放器启动时探测 `canvas.getContext('webgl2')`，失败则回退到现有 Canvas2D 实现并打印警告；也可以用 `post.renderer: "canvas2d"` 强制走旧路径。 |
| 文字经过纹理采样后变糊 | 纹理和画布 1:1 像素映射，采样时 uv 对齐到 texel 中心；非转场帧跳过 pass 1。 |
| 纹理上传开销（1080p RGBA 每帧约 8MB，转场期间 2 张） | GPU 下可以接受。软件 GL 下需要实测；如有必要，只在转场期间上传 B。 |
| 多 tab 并发时 WebGL 上下文数量 | 每个 tab 只有 1 个上下文，远低于浏览器上限。 |
| Firefox 引擎 | 已经设置了 `webgl.force-enabled`，需要单独跑一次验证。 |

---

## 5. 分阶段计划

### P0 正确性快修（独立小改动，可以先做）
1. **B1** `locate()`：t < clipTrans 时不做转场，直接显示 clip 0 的入场效果（标题卡加相机 settle）。
2. **B2** chunk 缓存键：对 `explainer.json + style.json + voice.json + 播放器 JS` 计算 hash，写到 `.render-chunks/manifest.json`，hash 不一致时清空重渲；成片合并成功后删除 `.render-chunks`（可通过环境变量保留，方便调试）。
3. **B3** 颗粒噪声改用 seeded PRNG，按帧号偏移。
4. **B4** xhot 路径改用 `buildExplainerStoryboardSchema`（传入素材 ID 和图标名），校验失败时把错误信息回传给 LLM 修复一次。
5. **B5 / B6 / B7**：统一默认引擎为 chromium，统一 preset 来源；删除硬编码路径；吞掉的异常至少打 warning；清理未使用的选项。

验收：首帧显示第一章标题而不是末章；修改 narration 后重渲染不会复用旧 chunk；同一帧 seek 两次的截图逐像素一致。

### P1 内容与效果分离（约束 1）
1. 新增 `src/libs/player/style.ts`：`ExplainerStyleSchema`、内置预设、`loadStyle()` 合并、`applyOverrides(clipId, shotId)`。
2. `contracts.ts` 拆出 `StoryboardContentSchema`，写旧格式迁移函数 `migrateLegacyStoryboard()`。
3. `tts.ts` 改为纯函数，时序常量全部从 `style.timing` 读取（顺便解决 C9）。
4. `produce.ts` 增加 `style?: ExplainerStyle | string` 选项，产物目录写出 `storyboard.json / style.json / voice.json`。
5. 播放器读取 `explainer-style` 数据块，替换所有硬编码常量（C4、C5、C6）。
6. 实现组件化：`component:flash` 和 `component:final-showcase`，素材带 tags（C7）。
7. 修改 `video.ts` 和 `tutorial/storyboard.ts` 的 prompt，删掉效果字段（C2、C3）。
8. CLI 增加 `--style <path>`。

验收：
- 用同一份 storyboard 配两个 style 能渲染出两种风格；用同一个 style 配两份 storyboard 风格保持一致。
- 旧产物（例如 `_archive/xhot/*/10-explainer-storyboard.json`）迁移后能正常渲染。
- 新生成的 storyboard 里不含任何效果字段（加单元测试断言）。

### P2 播放器运行时拆分（为 P3 铺路）
1. 把 `PLAYER_JS` 拆成真实源文件 `src/libs/player/runtime/*.js`（core/timeline、layout、components、bg、post、transitions），用 esbuild 打包成单个 IIFE，`writeExplainerPlayer` 读取打包结果（模块已经依赖 tsx，可以加一个构建步骤，或在运行时读取预构建文件）。
2. `drawShot` 改为布局注册表：`layouts = { standard, landscape, prompt, flash, finalShowcase }`。
3. 删除 legacy 输出：tutorial-* 双份嵌入和别名文件、兼容 DOM、`normalizeTimeline` 的 scenes 转换。删之前先 grep 确认 tests 和 scripts 是否依赖（`tests/modules.test.ts`、`scripts/re-render-*.ts`）（F6）。

验收：拆分前后同一 timeline 取 10 个固定时间点截帧，逐像素 diff 为 0（排除颗粒噪声，或固定 seed）；HTML 体积下降。

### P3 WebGL 后期 + Shader 转场（约束 2）
1. `runtime/gl.js`：上下文创建、探测、纹理和 FBO 管理、shader 编译缓存、回退开关。
2. `post.frag`：halation + grade，效果参数对齐现有 Canvas2D 版本，先追求和现有画面一致。
3. `transitions/*.glsl` 采用 gl-transitions 接口，实现首批 7 个转场；`style.transitions` 负责选择和传参。
4. 右栏视觉切换（visualSwap）接入 shader。
5. `launchRenderBrowser` 加上 WebGL 相关启动参数，启动后探测并在日志中写明实际使用的 renderer（硬件 GL / SwiftShader / canvas2d）。
6. 新增转场预览页 `explainer-player.html?transitionLab=1`：选择两段 clip，循环播放某个转场，便于调参。

验收：
- 每个转场在 progress 为 0 / 0.5 / 1 时截帧符合预期，进度为 0 和 1 时与非转场帧一致。
- WebGL 不可用时自动回退且能出片。
- benchmark：对同一 timeline，记录 canvas2d 和 webgl 两条路径的单帧耗时（`seek` 和 `screenshot` 分开统计）。

### P4 渲染管线与 TTS 提速
1. **帧导出**：评估用 `canvas.toBlob` 或 `gl.readPixels` 输出原始 RGBA 帧，经 `page.exposeBinding` 或 CDP 传给 ffmpeg（`-f rawvideo -pix_fmt rgba`），替代 PNG 截图（F3）。做 A/B benchmark 后再决定是否切换。
2. 转场期间避免重复绘制背景（F4）。
3. TTS 按行并发合成（限制并发数，保留顺序），静音按时长缓存复用，或改用 ffmpeg `adelay` / `apad` 一次性拼接（F5）。
4. 渲染进度日志加上 ETA 和每帧平均耗时。

验收：对 `flowTutor-1793604323391-9wvalm` 这份产物重新渲染，记录总耗时，与当前约 60 分钟对比；音画对齐误差不超过 1 帧。

---

## 6. 验证方法（各阶段通用）

- **固定回归样本**：一份 xhot 产物（`_archive/xhot/xhot-1792854286051-6uv3m5`）和一份 flowtutor 产物，用 `previewOnly` 加固定时间点截帧作为 golden image。
- **单元测试**：style 合并和覆盖、旧格式迁移、storyboard 中不得出现效果字段、chunk hash 失效判断、`locate()` 首帧行为。
- **benchmark 脚本**：`scripts/bench-explainer-render.ts`，渲染 300 帧，输出平均和 P95 单帧耗时。

---

## 7. 需要你确认的问题

1. **已确认**：`style.json` 与 `storyboard.json` 同在本次产物目录；内置预设作为模板放在 `src/libs/player/styles/`。
2. **已确认**：脚本不加 `mood` 等情绪标签，转场完全由 style 决定。
3. **已确认**：P2 删除 legacy 输出（`tutorial-*` 别名文件和 ID、`window.__tutorial`、旧 scenes 格式）。删除前仍要 grep `tests/` 和 `scripts/` 的引用，并一起改掉。
4. **转场选择策略**：默认按 pool 顺序轮换，还是按 seed 随机？是否需要某个转场固定只用于"进入最后一章"？
5. **已确认**：Linux 渲染机有 GPU，WebGL 直接走硬件加速，计划不考虑 SwiftShader。
6. **执行顺序**：P0 可以直接开始；P1 和 P3 都依赖 P2 的拆分，是否接受顺序 P0 → P1 → P2 → P3 → P4？
