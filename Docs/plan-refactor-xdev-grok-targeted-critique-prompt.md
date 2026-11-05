# Plan: 重构 Grok 调研提示词：结合点论证或无结合点时的定向批判

## 背景与问题
当前 Stage 4 中传给 Grok 的 `grokPrompt`：
- 有结合点时仅粗暴截取 100 字，未引导 Grok 去搜索支撑该结合点落地的行业权威实践与反例；
- 无结合点时退化为宽泛的通用技术搜索，完全没有去调研批判方向（即 LLM 动态编排一切的失败案例、上下文膨胀问题，以及规划与实施隔离、Pipeline/结构化上下文/沙盒执行的工业界方案）。

## 设计方案
在 `AIGC-pipeline/src/pipelines/xdev/execute.ts` 中根据 `creativeSparks.hasMeaningfulFit` 分支构造专精化的 `grokPrompt`：

1. **分支 A：有结合点碰撞时（`hasMeaningfulFit === true`）**
   - 目标：调研该结合点落地结论在工业界和学术界的具体实践与佐证。
   - 调研重点：
     - 结合点核心结论（`creativeSparks.resolutionOrSynergy`）；
     - 检索类似方案在主流大厂（如 Anthropic, OpenAI, Cursor, GitHub 等）或学术界的落地经验、性能对比与权衡；
     - 附带真实 markdown 链接。

2. **分支 B：无结合点时（`hasMeaningfulFit === false`，批判视角）**
   - 目标：直接调研针对原主题机制的批判视角与工程边界。
   - 调研重点：
     - 批判业界“让 LLM 动态编排一切”遭遇的实际生产事故与系统失效（如上下文爆炸/污染、死循环、工具调度冲突、不可预测性）；
     - 调研将“脑洞/计划（Planning）与执行（Execution）进行物理上下文隔离”的成熟工程方案；
     - 调研采用“确定性 AI 工作流/Pipeline + 严格结构化上下文 + 沙盒（Sandbox）隔离执行”的顶尖工程团队经验（如 Devin, SWE-bench top performers, Anthropic Workflows 等）；
     - 附带真实 markdown 链接。

## 涉及文件
- `AIGC-pipeline/src/pipelines/xdev/execute.ts`
- `AIGC-pipeline/tests/xdev-grok-prompt.test.ts`
