# 计划：强化 xdev 配图提示词与插图马卡龙配色（Macaron Color Palette）

## 用户需求
用户反馈目前的配图提示词效果不错，但颜色还不够丰富，需要强化强调使用**马卡龙配色（Macaron color palette / rich soft pastel tones）**。

## 涉及文件
1. `AIGC-pipeline/src/pipelines/xdev/execute.ts`：
   - 题图（Header Image）生成提示词：目前为 `Apple System Blue (#0071E3) and indigo accent lighting... crisp light off-white background (#F8FAFC)`，需要升级为色彩更丰富层次感更强、明快清新的马卡龙配色风格（rich Parisian macaron color palette: pistachio mint, soft pastel coral peach, lavender lilac, creamy lemon buttercup, powder cyan, and delicate rose gradients）。
2. `AIGC-pipeline/src/pipelines/xdev/svg-builder.ts`：
   - 文章内嵌架构图和流程图（Architecture & Sequence SVG）：在配色指引（Accents）中强调马卡龙多色搭配（rich Macaron pastel accents: pistachio green #86EFAC/#34D399, soft coral blush #FDA4AF/#FB7185, pastel lavender lilac #C4B5FD/#A78BFA, powder sky cyan #7DD3FC/#38BDF8, creamy pastel lemon #FDE047, and warm sand peach #FED7AA），保持高级现代质感的同时拥有更加丰富明快的马卡龙色彩层次。

## 实施步骤
1. 修改 `execute.ts` 中的 `headerImage` prompt，加入明确且丰富的马卡龙配色指令（Rich French macaron color palette with harmonious multi-tone pastels）。
2. 修改 `svg-builder.ts` 中的架构图与时序图 prompt，同步提升配色的丰富度与马卡龙色阶。
3. 增加单元测试或运行现有测试套件验证 Prompt 纯英文约束与测试全部通过。
