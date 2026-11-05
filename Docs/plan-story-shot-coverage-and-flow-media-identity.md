# Plan — 剧本先行 / 同场景多机位 / Flow 媒体身份账本

Status: implemented (unit-tested; live Flow run pending)
Run analysed: `artifacts/flowtutor/flowTutor-1793720826350-iv53k8`
Log: `artifacts/flowtutor-logs/flowtutor-run-20261103-1047.log`

## 0. 用户裁决（本次改动的唯一依据）

| # | 原“问题” | 用户裁决 | 本次动作 |
|---|----------|----------|----------|
| 1 | 素材只有 3 张设定卡 + 1 条负向词 + 1 个单镜头提示词，LLM 硬凑 6 镜 | **成立**：允许再调一次 LLM，先用「抽取提示词 + 示例视频解说词」编一个短视频剧本 | 新增独立 **Story Plan（剧本/分镜规划）** LLM 阶段，作为第二次 LLM 调用的权威输入 |
| 2 | `inferTransition` 用标点推断，6 镜全锁成 `cut` | **不成立**：短视频本来就是很多 cut | **不改** transition 推断逻辑；只把 cut 的备注措辞改成“同一场景换机位”，不改成 continuous |
| 3 | 首尾帧视觉变化太大（特写跳全景） | **不成立**：差别大不是问题；问题是不同镜头应是**同一场景的不同机位**，而不是一个机位反复变化 | 新增 **一镜一机位 + 同场景多机位覆盖** 规则（prompt + 剧本校验器） |
| 4 | 生成 Clip 6 首尾帧时把 Clip 5 的 Tile 当新图下载 | **成立，大 bug** | 新增 **run 级媒体身份账本**，按“全部已消费媒体”排除，并加内容哈希兜底 |

## 1. 证据（#4 根因）

脚本 `9-flow-video-script.json`：

- clip-005 start = `b2f44b14-…`（774246 B），end = `9325206b-…`（712700 B）
- clip-006 start/end 记录的 key 与 URL **完全等于 clip-005**
- `md5(clip-006-start.jpg) == md5(clip-005-start.jpg)`，`md5(clip-006-end.jpg) == md5(clip-005-end.jpg)`

日志：

```
clip-006 start-image: baseline image cards on canvas: 8 (17 known keys)
clip-006 start-image: recorded image card "9325206b…"(=clip5 END) is no longer an image card … falling back
clip-006 start-image: new image card created on canvas   ← 秒回，且 03/04 evidence png 字节相同
clip-006 start-image: … clip-006-start.jpg (774246 bytes)  ← 正是 clip5 START
clip-006 end-image:   … clip-006-end.jpg   (712700 bytes)  ← 正是 clip5 END
```

结论：`waitForNewImageTile` 的“新鲜度”只对比**本次调用开始时挂载在画布上的卡片集合**
（`knownImageKeys = canvasKeys + excludeKeys + referenceKey`）。

- Clip 6 生 **start**：只排除了 reference（clip5 end），没排除 clip5 start → 命中 clip5 start。
- Clip 6 生 **end**：只排除了 `excludeKeys=[clip5 start]` 与 reference，没排除 clip5 end → 命中 clip5 end。

只要上一片段的首/尾图不在本次 baseline 里（虚拟化画布回收、页面重挂、`/asb/` 代理 URL、
视频卡 poster 短暂被判定为 image），就会被当成“新图”。这是身份域太小的问题，不是单点 race。

## 2. 改动设计

### 2.1 Story Plan 阶段（#1）

新文件 `src/research/script/story-plan.ts`：

- `StoryPlanSchema`（zod）：`logline / synopsis / hasNarration / scenes[] / shots[] / characters / backgrounds`
  - `scenes[]`: `sceneId / location / timeOfDay / lighting / cast[] / summary`
  - `shots[]`: `shotIndex / sceneId / beat / shotSize / cameraAngle / cameraHeight / lens /
    cameraPosition / cameraMove / screenDirection / blocking / actionStart / actionEnd /
    narrationLine / continuity`
- `buildStoryPlan(params)`：一次 `chatJsonObject`，输出剧本；`validateStoryPlan` 校验；
  违规时**显式**做一次修复调用（把违规清单回灌），仍违规则抛 `LLM_RESPONSE_INVALID`
  （不静默降级）。
- `validateStoryPlan(plan, expectedClipCount)` 硬规则：
  1. `shots.length === expectedClipCount`，`shotIndex` 为 1..N 连续；
  2. 每个 shot 的机位字段齐全（shotSize/cameraAngle/cameraPosition/cameraMove/
     screenDirection/blocking/actionStart/actionEnd）；
  3. `sceneId` 必须存在于 `scenes[]`，每个 scene 至少被 1 个 shot 覆盖；
  4. `cameraMove` 只能是**单一连续运动**：出现 `cut to / jump cut / smash cut / montage /
     then … then` 等即违规；
  5. 同场景相邻两镜不得使用完全相同的机位签名（shotSize+cameraAngle+cameraPosition）
     —— cut 必须真的换机位；
  6. `characters` / `backgrounds` 主定义必须存在（尺度一致性依赖占位符展开）。

在 `reorchestrateExtractedPrompts()` 中：`useLlm !== false` 时先跑 Story Plan，
再把 `storyPlan` 作为**权威分镜表**注入第二次 LLM 调用；第二次调用只负责“把分镜写成
imagePrompt / endImagePrompt / visualPrompt”，不得改写故事、不得增删镜头。

`GenerateScriptParams` 增加 `transcript`，让剧本阶段能吃到示例视频解说词
（`segments[].text` 优先，缺失时用 transcript cues）。

### 2.2 保留 cut（#2）

- `inferTransition()` 一行不改。
- `buildTransitionNote('cut')` 措辞改为：“同一场景换机位（new camera setup in the SAME
  location）”，避免把“cut”误导成“换场景”，与 #3 的规则对齐。

### 2.3 一镜一机位 + 同场景多机位（#3）

两处 prompt（剧本 pass + 写提示词 pass）都把用户原话作为**头条硬规则**写入（中英双语，避免歧义）：

> DIFFERENT SHOTS = DIFFERENT CAMERA POSITIONS OF THE SAME SCENE（不同镜头 = 同一场景的不同机位），
> NOT one camera position that keeps changing（而不是一个机位反复变化）。
> ACROSS shots（每次 cut）：机位/角度/景别变，布景/站位/道具/光线/服装/屏幕方向不变；
> INSIDE one shot：机位不变，一个位置、一个角度、一个景别、一个镜头、一次连续运镜。

`prompts.ts` 的 reorchestration system prompt 新增 `SHOT CONTINUITY & CAMERA COVERAGE` 段：

- **ONE CAMERA SETUP PER CLIP**：每镜只有一个机位（高度/角度/镜头/距离），只允许一次连续
  运镜；禁止镜内切、禁止“先推再切”、禁止一个镜头里反复变化机位；末帧必须是该单次运镜
  能到达的画面。
- **COVERAGE, NOT RESET**：同一场戏的所有镜头共用同一布景、同一道具、同一时间/光线；
  cut 只换机位（更广揭示 / 更近给情绪 / 过肩给关系 / 反打给反应），保持 180° 轴线、
  视线匹配、角色站位与服装不变。
- **DEFAULT ONE LOCATION**：默认整条片只在抽取到的那一个场景里完成；只有故事确需时才换场
  （≤2 个场景）。
- **因果链**：每镜必须有 `beat`，且由上一镜结果触发。
- 输出 JSON 增加 `cameraSetup`（= 剧本里的机位签名）与 `locationId`，便于逐镜对齐校验。

`buildReorchestrationUserPrompt` 注入 `=== AUTHORITATIVE SHOT PLAN ===`（逐镜列出
beat/机位/动作起止/台词/连续性），并明确“Clip N 必须使用第 N 个 shot 的机位，不得改写”。

### 2.4 Flow 媒体身份账本（#4）

新文件 `src/flow/media-ledger.ts`：

- `MediaIdentityLedger`
  - `seedFromScriptClips(clips)`：把**全部**片段的 `imageUrl / endImageUrl / imageTileKey /
    endImageTileKey / videoUrl / localImagePath / localEndImagePath / localVideoPath /
    startFramePath` 归一化为 canonical token（uuid + origin+path + raw，见
    `canonicalMediaTokens`）全部入账；
  - `add(...refs)` / `has(ref)` / `ownerOf(ref)` / `snapshot()`；
  - 另维护 `keyframeHashes: Map<sha1, label>`，从已有 `localImagePath/localEndImagePath` 播种。
- `findCrossClipDuplicateKeyframes(clips)`：找出“两个片段记录同一张关键帧”的脏数据。

`src/flow/client/batch.ts` **和 `src/flow/client-ext.ts`（flowTutor 实际走的扩展模式，两份实现必须同步）**：

- 批次开始时先**修复历史脏脚本**：命中跨片段重复的槽位（如 clip-006 start == clip-005
  start）→ 清空 `imageUrl/imageTileKey`（或 end 侧）、删除陈旧本地图；同时把该片段
  `status` 重置为 `pending`、清空 `videoUrl/localVideoPath` 并删除旧 MP4（否则
  exactly-once 下载会保留错误渲染），落盘脚本后再计算 eligible 片段；
- 建账本（含已 completed 的片段 → resume 安全）；
- `generateClipImage` 的 **start 与 end 两次调用都**传
  `excludeKeys: mediaLedger.snapshot()`（不再只传 reference / 兄弟图）；
- 每次生成成功后把新身份写入账本 + 写入脚本（已有 `persistScript`）；
- 下载完成后做**内容兜底** `assertFreshKeyframe`：新关键帧 sha1 若与账本里**其它**片段的
  关键帧相同 → 抛错并指名是哪个片段（同片段自身的重复下载允许，属于 exactly-once 语义）；
- dry-run 不会修改脚本；脏数据修复在真正运行前完成（日志会逐条打印被重做的片段）。

`src/flow/client/single.ts` 与 `client-ext.ts#generateVideo`：end-image 调用同样走账本
（start 身份先入账再生成 end）。

`src/flow/dom.ts` `waitForNewImageTile` 与 `client-ext.ts#waitForNewImageTile`：

- 候选卡的身份 token 必须**不在** baseline ∪ caller excludes 中（已有）；
- 新增 `guard.submittedAt` + `minGenerationMs`（默认 3000ms）：提交后立刻返回的旧卡直接
  拒绝（真实 Flow 生图需要数十秒）；
- 周期刷新与最终 reload 救援路径同样受 `tooEarly` 约束。

### 2.6 LLM thinking off

剧本 pass、写提示词 pass、tutorial storyboard 三处 LLM 调用都显式传 `thinking: false`
（`chat_template_kwargs.enable_thinking=false`，见 `src/libs/llm/client.ts`；本仓库
`.env` 为 `LLM_API_STYLE=chat`，所以该开关生效；Responses API 路径不支持此开关）。
剧本/提示词 pass 是 schema 约束的机械转换，思考流只增加延迟与漂移。

### 2.7 测试

`tests/script-story-plan.test.ts`（11 例）：

- 剧本 prompt 必含解说词与机位要求；
- 校验器能抓：镜数不符、机位缺字段、sceneId 不存在/未覆盖、cameraMove 含 cut、
  cameraMove 内改景别、同场景相邻同机位、场景数 > 2；
- 写 prompt 阶段必须把剧本当权威（含 master 占位符、locationId/cameraSetup 回显要求）。

`tests/flow-media-ledger.test.ts`（4 例）：

- 账本能从 clip5 的首/尾图 URL+key 播种（含 URL 重签后仍命中）；
- `excludeKeys` 快照同时包含 clip5 start/end（本次 bug 的回归测试）；
- `findCrossClipDuplicateKeyframes` 精确报出 `6:start<-5` / `6:end<-5`；
- 关键帧哈希兜底能识别重复字节。

### 2.8 验收

1. `npx tsc --noEmit` ✅
2. `npx tsx --test tests/script-story-plan.test.ts tests/flow-media-ledger.test.ts` ✅ 15/15
3. 全量非浏览器测试 `202/202` ✅（`inspect-x-account.test.ts` 为既有浏览器测试，与本次改动无关）
4. 真实跑一次 flowTutor：日志中 clip-N 的 start/end 生成必须各自出现**不同的**
   `new image card` 身份，且 `generated-clips/*.jpg` 的 md5 互不相同；
   `9-flow-video-script.json` 里 `storyPlan.shots` 与 `clips` 逐镜机位一致。

### 2.9 复核修正（2026-11-04，按用户二次裁决）

用户澄清：“同一场景不同切镜”指同一场景内，在不同主体的特写与中/远景之间切换是正常的，
所以首尾帧差别大不是问题。据此：

- **去掉“一镜一机位 / 镜内不得变景别 / 相邻不得同机位”等硬规则**（剧本 pass 与写提示词 pass）。
  现在的规则：同一场景内景别、角度、焦点主体可以自由切换，单个片段首尾帧也可以差别很大；
  不能漂移的是场景本身——布景布局、服装、道具状态、光线、角色站位。
- **删除关键词校验器**（`MULTI_SHOT_MOVE_RE` / `SETUP_IN_MOVE_RE` / 机位签名重复 / 场景数 ≤ 2）。
  镜头质量交给 LLM 按 prompt 判断；`validateStoryPlan` 只保留下游依赖的结构检查：镜数、
  shotIndex 顺序、sceneId 引用、场景被覆盖、必填字段、主定义存在、continuous 片段不得换场景。
- **语言**：只规定“输出 JSON 的所有值必须是英文”，删掉“与参考视频同语言”的说法。
- **剧本 pass 扩展为完整剧本**：先决定几个场景；每个场景写清 location/setting（地标布局）、
  时间光线、cast、props（初始状态）、blocking（开场站位朝向）、performance（逐拍演绎）、
  changes（场景结束时的变化）；每个镜头写清镜头参数、focusSubject、startFrame/endFrame 构图、
  blocking 与 blockingChange、动作起止、表演、`dialogue[]`（speaker/line/delivery）、
  `narrationLine`（TTS 文本，缺失时由 dialogue 拼出；无旁白片全部清空）。
- `clipTransitions` 传入剧本 pass：continuous 片段接着上一段视频继续，必须同场景、从上一镜尾帧开始。

## 3. 不做的事

- 不改 `inferTransition`（cut 是合理的）。
- 不为“景别跨度大”设限制（用户明确否决）。
- 不引入静默 fallback：剧本/校验/身份任一环节失败都要显式报错。
