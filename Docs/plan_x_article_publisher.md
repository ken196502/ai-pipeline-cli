# 重构 X Article 发布器与草稿测试方案

## 背景与问题回顾
1. **没配图**：旧清洗逻辑使用正则剥离了所有 `<svg>` 与 `![]()`，导致正文仅输入纯文本段落；
2. **没引用**：未注入结构化推文信源引用，且清洗过程截断了 `>` 引言与作者行；
3. **没头没尾**：直接从第二句开始，缺少工程背景引入与总结推导。

## 方案设计与实现

### 1. Markdown 结构化保留与富文本转换 (`article-document.ts`)
- 放弃暴力正则过滤正文；
- 解析 Markdown 为严格的语义 Block：`heading`、`paragraph`、`quote`、`list`、`divider`、`image`；
- 标题下方强制注入原文推文的真实验证引用块（`quote`），明确标注作者、Handle、原文链接；
- 末尾自动生成「信源与延伸阅读」板块，形成闭环。

### 2. 剪贴板富文本注入与草稿生成 (`x-article-editor.ts`)
- **富文本注入机制**：X Articles 编辑器基于 Draft.js。直接粘贴纯文本无法保留 H2/Quote/List，而通过触发 React Props 的 `onPaste` 并携带清洗后的 `text/html`（`<h2>`, `<blockquote>`, `<ul>`, `<p>`, `<a>`），X 编辑器可原生精准将其还原为 Draft.js 对应的富文本 Block；
- **媒体内嵌机制**：
  - SVG 图表与生成图自动栅格化为高质量 PNG；
  - 正文中图片按原版顺序定位，通过 X 编辑器内嵌媒体接口完成上传与光标处内嵌；
- **草稿安全模式 (`mode: 'draft'`)**：
  - 自动化流程只填充文章内容、插入配图、等待自动保存（Draft / Last saved just now）；
  - **绝不点击发布按钮**，保留草稿 URL 供人工核验；
  - 自动化捕获滚动长截图送检。

### 3. 测试与验证状态
- 执行工具：`tools/x-article-draft-test.ts`
- 成功在 X 线上生成长文草稿（Edit URL: `https://x.com/compose/articles/edit/2117100398431670272`）；
- 已完成 4 张完整视口长截图抓取并同步发送至 Telegram；
- 结构验证：
  - Heading: 6
  - Quote: 1（信源推文）
  - Images: 3（内嵌技术架构与时序图）+ 1（顶部宽幅封面图）
  - Dividers: 2
  - Paragraphs: 13
