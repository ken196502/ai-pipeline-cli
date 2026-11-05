# Plan: xdev 实践碰撞点池化 + 个人经验框定 + 单点选取

## Background & Problem
当前 xdev 成稿在 `analyzer.ts` 中把"以 Git-backed CLI Repo 作为 Multi-Agent 执行与可追溯基石"这一条**硬编码**为唯一的「实践碰撞」视角，并在 `generateCreativeSparkInsights`(Stage 3.5) 与 `synthesizeFocusedArticle`(Stage 6) 里反复引用。

用户反馈两个问题：
1. **误读为推文内容**：成稿把这条视角写成客观技术论断，读起来像推文本身的主张，实际这是**作者（用户）的个人工程实践经验与建议**。需要明确框定为"基于我的工程实践，我强烈建议…"，并与"推文讲了什么"清晰区分。
2. **碰撞点太单一且应可多选**：用户希望再补充两个碰撞点（a. 复用现成设施 Telegram/tmux 比重建架构更稳定易验证；b. 共享工作区而非记忆，因为模型趋势是把 agentic search 能力内化），并且**每期推文只挑一个最贴合的碰撞点进行碰撞，不要全部堆上**。

## Goal
把"实践碰撞点"从单点硬编码改造为**可扩展的池（pool）**，并按推文主题**每期只选取单个最契合点**；同时在所有相关 prompt 中明确"这是作者个人实践经验/建议"的框定，杜绝被误读为推文主张。

## Implementation

### 1. 新增 `src/pipelines/xdev/practice-collision.ts`
定义数据类型与碰撞点池：
```ts
export interface PracticeCollisionPoint {
  id: string;
  titleEn: string; titleZh: string;
  experienceStatementZh: string;   // 作者个人经验/建议（明确第一人称）
  experienceStatementEn: string;
  sparksLensZh: string;            // 给 Stage3.5 碰撞 LLM 的指导
  synthesisLensEn: string;         // 给 Stage6 成稿 LLM 的指导
  relevanceHints: string[];        // 契合度关键词（LLM 失效时的兜底）
}
export const PRACTICE_COLLISION_POINTS: PracticeCollisionPoint[];
export function selectCollisionPointId(text: string, topic: string): string; // 解析 LLM 选取 + 关键词兜底
```
三个碰撞点：
- `git-cli-repo`（现有，重构措辞为第一人称经验，强调生产验证、非推文主张）
- `existing-infra`：复用 Telegram/tmux 等已验证、易观测设施，优于从零重建调度/通知/进程管理架构（稳定、易验证/定位）。
- `shared-workspace-not-memory`：协作状态放可共享可检视工作区而非模型记忆/隐式上下文；理由是模型底座趋势是把 agentic search 内化，记忆方案边际价值下降，显式工作区始终可控/可审计/可重放。

### 2. 改造 `analyzer.ts` — `generateCreativeSparkInsights`
- 把"单一硬编码 bedrock"替换为：**把整池碰撞点（id + 标题 + 经验陈述）** 一起交给 LLM。
- 指令要求 LLM **只选取本期推文/议题最契合的那一个 `id`**，并针对该点产出四维剖析（契合点 / 推文技术映射 / 与该实践冲突或合拍 / 冲突解决与结合提升）。
- 新增框定指令："这是作者（我）的工程实践经验与建议，**不是**推文本身的主张；碰撞时明确区分'推文讲了什么'与'我的实践心得'。"
- 解析 LLM 选出的 `id`（用 `selectCollisionPointId` 校验 + 关键词兜底），写入 `CreativeSparkAnalysis.selectedCollisionPointId`。`hasMeaningfulFit` 逻辑保持不变（无契合点则走纯推文推进）。

### 3. 改造 `analyzer.ts` — `synthesizeFocusedArticle`
- `creativeSparksBlock` 头部与 `collisionInstruction` 不再写死 Git-backed CLI，改为**使用被选碰撞点的 `synthesisLensEn`**（按 `selectedCollisionPointId` 取对应点）。
- 在英文成稿 prompt 增加**全局框定指令**：引用该实践视角时必须显式声明为"作者个人工程经验与建议（e.g. 'Based on my own production experience, I strongly recommend…'）"，**绝不允许**将其表述为源推文的主张；清晰分离"推文论点"与"作者心得"。
- 标题/章节与引用来源校验逻辑不变。

### 4. 改造 `execute.ts` — Stage 3.5
- 日志文案更新为"结合实践碰撞点池，选取最契合点生成四维洞见"。
- 把 `selectedCollisionPointId` 写进 `creative-sparks-*.md` 归档（便于回溯哪期选了哪个点）。

### 5. 测试 `tests/xdev-practice-collision.test.ts`（新增）
- 池含 3 个点且 id 唯一；`selectCollisionPointId` 在 LLM 输出缺失/非法时按关键词兜底命中正确点；框定文案包含第一人称/个人经验标记。

## Verification
- `npx tsc --noEmit` 或 `pnpm exec tsc -p tsconfig.json --noEmit` 通过。
- 跑 `tests/xdev-practice-collision.test.ts` 通过。
- 可选：用上次 run 的归档产物（creative-sparks/grok-response/素材/头图/SVG）**单独重跑 Stage3.5+Stage6+Stage6.5+Stage7**，把已发出的那篇成稿用新逻辑重生成并重新投递 inspilot（新建 X 草稿）。该重跑在命名 tmux 会话中进行，不轮询，由 webhook 回传结果。

## Out of Scope
- 不改 X 发布策略（仍 DRAFT 不发布）。
- 不改 SVG/头图生成、Grok、抓取等其它 stage。
- 不改动"无契合点则纯推文推进"的优雅降级逻辑。
