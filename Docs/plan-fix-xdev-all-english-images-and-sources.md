# Plan: 彻底根除 xdev 配图与附录中文残留（全英文流水线）

## 问题现象与根因定位

用户反馈在上一轮 xdev 产物中：
1. **封面图/配图依然包含中文**：
   - 经实测审查 `header-image-2026-11-02T14-48-15-718Z.png`，左上角赫然印有中文大字：`上下文与代码变更的原子性绑定`。
   - 根因：在 `execute.ts:216`，生成生图 Prompt 时硬编码注入了中文变量：
     `primaryTopic = evalResult.selectedTopics[0].topicTitle`
     由于前期阶段（Stage 3 审稿/选题）让 LLM 输出的 `topicTitle` 是中文（如“上下文与代码变更的原子性绑定”），图像生成模型（`sensenova-u1.5-lite`）看到 prompt 中有中文词组，就直接在画面左上方渲染出了中文排版！
2. **文末附录与引用仍然包含中文**：
   - 在 `article-document.ts:244` 与 `252-259`：
     - `text: \`—— \${source.authorName}（@\${source.authorHandle}），\${when}原推文：\${source.tweetUrl}\``
     - `const items = [\`原推文（@\${source.authorHandle}）：\${source.tweetUrl}\`];`
     - `blocks.push({ type: 'heading', level: 2, text: '信源与延伸阅读' });`
     - `blocks.push({ type: 'paragraph', text: '未命名长文' })`（默认兜底）
   - 根因：`article-document.ts` 内构建开头引用出处和末尾信源附录的所有结构化块，硬编码了中文词汇（`原推文：`、`信源与延伸阅读`）。在全英文长文末尾，直接拼接了中文的 `## 信源与延伸阅读`。
3. **HTML 导出模板语言与标题写死中文**：
   - 在 `html-exporter.ts:47-51`：
     - `<html lang="zh-CN">`
     - `<title>Multi-Agent 架构演进与落地真谛</title>`
   - 导致生成的最终 html 标头也是中文。

---

## 修复目标

1. **生图 Prompt 绝无中文字符**：
   - Stage 3 选题结构（`analyzer.ts`）在 `topics` 项下明确要求输出英文议题 `topicTitleEn`（或在 `execute.ts` 构造 image prompt 时抽取英文主题 / H1 title）。
   - 生图 prompt 严禁拼接任何中文 `topicTitle` 或中文变量，并在传入 `generateImageFromEnv` 前加入硬校验，若包含 CJK 字符直接抛错或严格过滤为纯英文。
   - `buildHeaderBannerSvg` 与 SVG 蓝图若使用 `topicTitle`，也统一使用英文 `topicTitleEn`，确保所有图片和矢量图绝对不含哪怕一个汉字。
2. **`article-document.ts` 全面英文国际化（根据文章语言或默认英文）**：
   - 引言段落签名改为英文：
     `—— ${source.authorName} (@${source.authorHandle}), ${when}Original Post: ${source.tweetUrl}`
   - 文末章节标题与列表项改为英文：
     - 标题：`## Sources & Further Reading`
     - 列表项：`Original post (@${source.authorHandle}): ${source.tweetUrl}`
   - 缺省标题：`Untitled Article`
3. **HTML 导出模板英文适配**：
   - `<html lang="en">`
   - `<title>${options.title || 'Technical Architecture & Engineering Insights'}</title>`
4. **全链路 CJK 校验网关**：
   - 在 `publisher.ts` 或 `article-document.ts` 的 `validateDocument`，以及准备交付草稿前，对最终长文的所有 blocks（包括引文、正文、章节、文末信源）做严苛的 CJK 检测：
     如果检测到除作者原名外的汉字字符数超过 0，视为致命缺陷直接拦截！

---

## 实施步骤

1. **修改 `src/pipelines/xdev/analyzer.ts` & `src/pipelines/xdev/contracts.ts`**：
   - 为 topic 结构增加 `topicTitleEn`。
   - 在 LLM 选题 prompt 中，除了中文摘要供内部汇报外，明确要求输出英文主标题与英文议题概括（`topicTitleEn`），用于生图、SVG 与技术博文主脉络。
2. **修改 `src/pipelines/xdev/execute.ts`**：
   - Header image prompt 采用 `topicTitleEn`（或成稿 H1 标题），杜绝任何中文字符传入生图模型。
   - SVG 生成调用 `generateSvgArchitectureDiagram` 与 `generateSvgSequenceDiagram` 时传入 `topicTitleEn`。
3. **修改 `src/pipelines/xdev/article-document.ts`**：
   - 将原推文引文、`信源与延伸阅读`、`原推文（@...）` 全部重构成专业英文规范（`Sources & Further Reading`, `Original post (@...)` 等）。
4. **修改 `src/pipelines/xdev/html-exporter.ts`**：
   - 替换写死的 `<title>Multi-Agent 架构演进与落地真谛</title>` 为动态文章标题。
   - 将 `<html lang="zh-CN">` 改为 `<html lang="en">`。
5. **单元测试与全流程覆盖**：
   - 在 `tests/xdev-*.test.ts` 中新增针对 `buildArticleDocument`、`image-generator` prompt、`html-exporter` 的纯英文回归测试断言，确保 0 个中文字符逃逸。
