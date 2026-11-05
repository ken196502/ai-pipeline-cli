# Plan: 强化 Xdev 个人技术专家人称视角 (I/my) 与结尾严格收口结合点

## 背景与问题
用户指出两个关键问题：
1. **人称代词**：文章通篇出现 "we / our"，要求在提示词中明确强调“我是个人技术专家 / 独立架构师”，通篇叙述视角必须是第一人称单数 **"I / my / me"**，禁止使用虚伪或论文式的 "we / our"。
2. **结合点收尾散漫**：当前生成的文章在结尾容易跑题发散，既然前面与个人工程实践碰撞出了结合点（practice collision lens），**文章最后就必须收敛并聚焦在这个结合点上进行总结收尾**，而不是结尾又发散去聊其他无关事项。

## 详细改造设计

### 1. 提示词约束修改 (`AIGC-pipeline/src/pipelines/xdev/analyzer.ts`)
1. **明确叙述视角（Narrative Voice）**：
   - 明确角色设定：**"You are a seasoned individual software architect / principal engineer writing an in-depth technical essay from your own personal practice."**
   - 强制第一人称单数：必须使用 **"I", "my", "in my architecture"**。严禁使用学术论文式的 "we", "our", "us"（除非引用原推特团队本身）。
2. **强化结合点收尾（Practice Collision Convergence in Conclusion）**：
   - 目前 `closingInstruction` 只简单要求总结。
   - 修改 `closingInstruction`：
     - 如果存在 `collisionLens`：**最后一节（Conclusion / Architectural Synthesis）必须将论点完全收拢并聚焦于这个具体的碰撞结合点**。
     - 结尾必须落地为个人工程实践的判断：解释为什么这个结合点是解决前文痛点的决定性工程锚点，给出作者个人的架构落地方案或裁决，**禁止在结尾发散引入新的概念或泛泛而谈的套话**。
3. **正文校验器（validateArticleBody）防退化**：
   - 在校验逻辑中增加对非引用性 "we / our" 的检测或提示警告，确保模型输出遵循第一人称 "I"。

## 涉及文件
- `AIGC-pipeline/src/pipelines/xdev/analyzer.ts`
- `AIGC-pipeline/tests/xdev-author-voice.test.ts` (单测覆盖)
