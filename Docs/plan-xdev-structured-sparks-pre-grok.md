# 计划：xdev 引入实事求是的前置碰撞与自然回退机制（以 Git-backed CLI Repo 作为 Multi-Agent 共同维护的执行工具与可追溯基石）

## 核心原则
- **核心工程实践定义**：
  “以 Git-backed CLI Repo 作为 Multi-Agent 共同维护的执行工具与可追溯基石：让多个 Agent 共同维护、操作和演进同一个 CLI 工具流代码仓库，使每一次 Agent 决策、工作流调度、工具执行与代码变动都作为确定性的 CLI 命令、结构化 Spec 与 Git 提交，做到端到端全生命周期的严格可追溯性与执行确定性”。
- **实事求是，杜绝生搬硬套（Graceful Fallback）**：
  - 如果推文与多智能体协同、状态管理、注意力漂移、工具执行、可重放性等底层机制**有深刻契合点**，则进行深度碰撞，提炼出 4 维度高价值灵感，并在 Grok 检索与成稿中深入体现。
  - **如果推文属于独立或特定垂直领域，没有明显的碰撞契合点，则实事求是标记为“无显著契合点”，完全按照原推文本身的事实、数据与技术逻辑推进成稿，不强行牵扯，确保内容严谨可信。**

## 关键代码变动
1. `analyzer.ts` 中的 `generateCreativeSparkInsights`：
   - 增加实事求是判定与 `hasMeaningfulFit` 布尔字段。
   - 提示词明确要求若无显著交集，不得强行拉郎配。
2. `analyzer.ts` 中的 `synthesizeFocusedArticle`：
   - 判断 `hasSparks = creativeSparks?.hasMeaningfulFit && creativeSparks?.rawText`；
   - 若 `hasSparks` 为真，则注入 4 维洞见与碰撞指导；
   - 若为假，则采用纯素材严谨成稿逻辑，避免任何生硬套用。
3. `execute.ts`：
   - Grok 检索提示词根据 `creativeSparks.hasMeaningfulFit` 决定是否附加碰撞落地衍生查询词。
