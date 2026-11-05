# Plan: Xdev 无结合点时的默认批判视角与严格收口

## 背景与需求
用户明确指示：
- 如果没有匹配到具体的结合点（hasSparks === false），文章不应该泛泛而谈或自由发散。
- **默认批判视角**：直接往**批判方向**写——批判当前大多数 Agent 框架试图让 LLM 编排一切（让 LLM 既做规划又做执行、既当大脑又当管家），注定以混乱（上下文污染、幻觉失控、死循环）收场。
- **核心工程主张**：必须将**脑洞/规划（Brainstorming & Planning）**与**执行/实施（Execution & Implementation）**做**严格的上下文隔离（Strict Context Isolation）**。
- **收尾要求**：文章必须最终收敛并收尾在这一核心主张上，给出具体的工程隔离落地建议，严禁发散。

## 设计细节
1. **修改 `AIGC-pipeline/src/pipelines/xdev/analyzer.ts`**：
   - 更新 `collisionInstruction` 的 fallback（无结合点分支）：
     - 明确核心批判框架：批判“LLM 试图编排一切（Omnipresent LLM Orchestrator）”的行业反模式。
     - 引入“规划与执行上下文物理隔离”的工程原则：规划阶段（脑洞、方案推演）与实施阶段（代码修改、工具调用、环境验证）不可共用一个大上下文，避免杂音与状态爆炸。
   - 更新 `closingInstruction` 的 fallback（无结合点分支）：
     - 最后一节（Conclusion / Architectural Takeaway）严格收口在“规划与实施的严格上下文隔离”上。
     - 给出落地建议（例如：分阶段落盘、只传递确定性契约/计划、无状态工人执行）。
     - 严禁引入任何未经前文论证的发散概念。
2. **测试验证**：
   - 运行单测确认改动无语法及结构问题。

## 涉及文件
- `AIGC-pipeline/src/pipelines/xdev/analyzer.ts`
- `AIGC-pipeline/tests/xdev-author-voice.test.ts`
