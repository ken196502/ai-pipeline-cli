/**
 * Practice-collision point POOL for the xdev article pipeline.
 *
 * These are the author's (operator's) *personal engineering experience and
 * recommendations* — explicitly NOT claims made by the source tweet. The article
 * must frame them in the first person ("Based on my own production experience, I
 * strongly recommend…") and clearly separate them from what the tweet argues.
 *
 * Selection rule (see `selectCollisionPointId`): for every article we pick the
 * SINGLE point most relevant to that tweet's topic — we never pile all of them on.
 */

export interface PracticeCollisionPoint {
  /** Stable id, also used as the selection token in LLM output. */
  id: string;
  titleEn: string;
  titleZh: string;
  /** Author's personal experience/recommendation, first-person (Chinese). */
  experienceStatementZh: string;
  /** Same, English, for the article-synthesis lens. */
  experienceStatementEn: string;
  /** Guidance injected into the Stage-3.5 sparks (collision) prompt. */
  sparksLensZh: string;
  /** Guidance injected into the Stage-6 article-synthesis prompt. */
  synthesisLensEn: string;
  /** Keywords used for the fallback relevance scoring. */
  relevanceHints: string[];
}

export const PRACTICE_COLLISION_POINTS: PracticeCollisionPoint[] = [
  {
    id: 'git-cli-repo',
    titleEn: 'Git-backed CLI Repo as the Execution & Traceability Bedrock',
    titleZh: '以 Git-backed CLI Repo 作为执行与可追溯基石',
    experienceStatementZh:
      '基于我的工程实践，我强烈建议把多 Agent 协作的「执行」与「可追溯性」建立在 Git-backed CLI Repo 之上：让每一次 Agent 决策、工具调用、状态迁移都落为确定性 CLI 命令、结构化 Spec 与 Git 提交，做到端到端可追溯与执行确定性。这是我在生产环境里反复验证过的做法，并不是推文本身的主张。',
    experienceStatementEn:
      'Based on my own engineering practice, I strongly recommend grounding multi-agent execution and traceability in a Git-backed CLI Repo: every agent decision, tool call, and state transition becomes a deterministic CLI command, a structured spec, and a Git commit — yielding end-to-end traceability and execution determinism. This is a lesson I have validated repeatedly in production, not a claim made by the source tweet.',
    sparksLensZh:
      '把上述作者个人实践经验作为碰撞镜头，分析本期推文机制如何与「Git-backed CLI Repo 执行基石」契合或冲突。碰撞时务必明确区分「推文讲了什么」与「我的实践心得是什么」。',
    synthesisLensEn:
      'Integrate the following author\'s personal engineering experience and recommendation as a collision lens: {{EXPERIENCE_EN}}. Frame it explicitly as the author\'s own production lesson (e.g., "Based on my own production experience, I strongly recommend…"). Never present it as a claim made by the source tweet; clearly separate what the tweet argues from what the author has learned.',
    relevanceHints: [
      'multi-agent', 'agent', 'collaboration', 'state', 'state management',
      'tool', 'tool-call', 'tool-use', 'regression', 'replay', 'traceability',
      'audit', 'determinism', 'deterministic', 'execution', 'workflow',
      'scheduling', 'drift', 'spec', 'commit', 'diff',
    ],
  },
  {
    id: 'existing-infra',
    titleEn: 'Leverage Existing Infrastructure (Telegram, tmux) Over Rebuilding',
    titleZh: '复用现成设施（Telegram / tmux）而非重建架构',
    experienceStatementZh:
      '基于我的工程实践，我强烈建议优先复用已经验证、易观测的现成设施（如用 Telegram 做告警与控制面、用 tmux 做长任务隔离与可观测），而不是从零重造一套调度 / 通知 / 进程管理架构。现成设施更稳定，出问题也更易验证与定位——这是我在多个生产流水线里踩坑后沉淀下来的经验，而非推文的主张。',
    experienceStatementEn:
      'Based on my own engineering practice, I strongly recommend reusing proven, observable existing infrastructure (e.g., Telegram as the alerting/control plane, tmux for long-running-task isolation and observability) rather than rebuilding scheduling/notification/process-management architecture from scratch. Existing tools are more stable and far easier to verify and debug when something breaks — a lesson I learned the hard way across several production pipelines, not a claim made by the source tweet.',
    sparksLensZh:
      '把上述作者个人实践经验作为碰撞镜头，分析本期推文机制如何与「复用现成设施优于重建」契合或冲突。碰撞时务必明确区分「推文讲了什么」与「我的实践心得是什么」。',
    synthesisLensEn:
      'Integrate the following author\'s personal engineering experience and recommendation as a collision lens: {{EXPERIENCE_EN}}. Frame it explicitly as the author\'s own production lesson (e.g., "Based on my own production experience, I strongly recommend…"). Never present it as a claim made by the source tweet; clearly separate what the tweet argues from what the author has learned.',
    relevanceHints: [
      'notification', 'alert', 'telegram', 'tmux', 'infrastructure',
      'deployment', 'observability', 'monitoring', 'long-running', 'process',
      'orchestration', 'control plane', 'operations', 'ops', 'reliability',
      'incident', 'scheduling', 'isolation', 'logging',
    ],
  },
  {
    id: 'shared-workspace-not-memory',
    titleEn: 'Shared Workspace, Not Memory',
    titleZh: '共享工作区而非记忆',
    experienceStatementZh:
      '基于我的工程实践，我强烈建议把 Agent 之间的协作状态放在可共享、可检视的工作区（文件 / 仓库 / 产物），而不是塞进模型记忆或隐式上下文。原因在于模型底座的发展趋势是把 agentic search 这类能力内化进模型本身，记忆型方案的边际价值会持续下降；而显式工作区始终可控、可审计、可重放。这是我对多 Agent 架构演进的判断与建议，不是推文的主张。',
    experienceStatementEn:
      'Based on my own engineering practice, I strongly recommend placing inter-agent collaboration state in a shared, inspectable workspace (files / repo / artifacts) rather than stuffing it into model memory or implicit context. The reasoning: foundation models are trending toward internalizing capabilities like agentic search, so memory-centric schemes lose marginal value over time, whereas an explicit workspace stays controllable, auditable, and replayable. This is my judgment on multi-agent architecture evolution, not a claim made by the source tweet.',
    sparksLensZh:
      '把上述作者个人实践经验作为碰撞镜头，分析本期推文机制如何与「共享工作区而非记忆」契合或冲突。碰撞时务必明确区分「推文讲了什么」与「我的实践心得是什么」。',
    synthesisLensEn:
      'Integrate the following author\'s personal engineering experience and recommendation as a collision lens: {{EXPERIENCE_EN}}. Frame it explicitly as the author\'s own production lesson (e.g., "Based on my own production experience, I strongly recommend…"). Never present it as a claim made by the source tweet; clearly separate what the tweet argues from what the author has learned.',
    relevanceHints: [
      'memory', 'context', 'context-window', 'shared', 'workspace', 'knowledge',
      'rag', 'search', 'agentic', 'internalize', 'long-term', 'persistence',
      'collaboration', 'state', 'recall', 'forgetting',
    ],
  },
];

export function getCollisionPoint(id: string): PracticeCollisionPoint | undefined {
  return PRACTICE_COLLISION_POINTS.find((p) => p.id === id);
}

export const DEFAULT_COLLISION_POINT_ID = PRACTICE_COLLISION_POINTS[0].id;

/**
 * Resolve which collision point to use for an article.
 *
 * Priority: (1) an explicit `selectedCollisionPointId: <id>` token parsed from
 * the LLM's collision output; (2) keyword-relevance fallback over the topic +
 * LLM text; (3) the first pool entry as a final default.
 */
export function selectCollisionPointId(llmText: string, topic: string): string {
  const poolIds = PRACTICE_COLLISION_POINTS.map((p) => p.id);

  const explicit =
    llmText.match(/selectedCollisionPointId\s*[:=]\s*["']?([a-z0-9-]+)["']?/i) ??
    llmText.match(/碰撞点\s*[:：]\s*["']?([a-z0-9-]+)["']?/i);
  if (explicit && poolIds.includes(explicit[1])) return explicit[1];

  const hay = `${topic} ${llmText}`.toLowerCase();
  let best = DEFAULT_COLLISION_POINT_ID;
  let bestScore = -1;
  for (const p of PRACTICE_COLLISION_POINTS) {
    let score = 0;
    for (const hint of p.relevanceHints) {
      if (hay.includes(hint.toLowerCase())) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = p.id;
    }
  }
  return best;
}
