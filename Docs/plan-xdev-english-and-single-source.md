# Plan: xdev 输出英文 + 一篇文章只引用一条推文

## 需求

1. 最终成稿必须是英文（现在不可靠：`11-26` 那篇是中文，`10-48` 那篇是英文，同一个 prompt）
2. 一篇文章只引用一条推文，且在多条候选里挑**阅读量更大**的那条

## 现状

### 英文不可靠

`analyzer.ts` 的写作 prompt 里已经写了：

```
## CRITICAL LANGUAGE REQUIREMENT:
- The ENTIRE article MUST be written 100% in fluent, professional, idiomatically natural ENGLISH.
```

但 `validateArticleBody()` 只校验长度、套话、空断言、结构，**不校验语言**，所以模型输出中文也能通过 → 直接成稿。

### 会选中两条推文

`analyzer.ts:271`：

```ts
const validIndices: number[] = Array.isArray(parsed.selectedIndices)
  ? parsed.selectedIndices.slice(0, 2)     // ← 最多 2 条
  : [];
```

`selectedTopics[0]` 用于写作，`selectedTopics[1]` 只喂给 `crossTopicTransitionZh`——而这个字段全仓库无人使用（只有定义和赋值）。实测 `11-26` 那轮选了两条：

```
Michael Guo (@Michaelzsguo)  .../status/2116882047025164466
Shruti (@heyshrutimishra)    .../status/2117155993671098371
```

正文只用了第一条，第二条纯属浪费，且让标题/摘要可能混入第二个话题。

## 改动

### 1. 只保留阅读量最高的那一条（`analyzer.ts`）

构建完 `selectedTopics` 后：

```ts
if (selectedTopics.length > 1) {
  const best = [...selectedTopics].sort((a, b) => (b.tweet.views ?? 0) - (a.tweet.views ?? 0))[0];
  // 日志：保留 X views，丢弃 Y views
  selectedTopics.length = 0;
  selectedTopics.push(best);
}
```

### 2. 语言硬门（`analyzer.ts::validateArticleBody`）

```ts
const cjk = (body.match(/[\u4e00-\u9fff]/g) || []).length;
const total = body.replace(/\s/g, '').length;
if (total > 0 && cjk / total > 0.05) {
  issues.push(`正文不是英文（CJK 字符 ${cjk}/${total}）`);
}
```

命中后走现有重试路径（把 issues 拼回 prompt 重写一次），仍不合规就抛错——不兜底。

### 3. 标题也要英文（`execute.ts`）

草稿标题现在取 `evalResult.articleTitle`（中文）。改成从成稿 markdown 里取 H1：

```ts
const h1 = thoughtArticleMarkdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
title: h1 || evalResult.articleTitle || primaryTopic
```

写作 prompt 里明确要求 H1 是英文标题。

## 不做

- 不改 `executiveSummaryZh`（内部报告/摘要仍中文，只影响 Telegram 汇报，不进正文）
- 不改选稿打分逻辑（LLM 仍选 1~2 条，只是最终只保留阅读量最高的一条）
- 不加兜底：语言不合规就是失败，不用模板补

## 验证

- `npx tsc --noEmit`
- `npx tsx --test tests/xdev-*.test.ts`
- 重跑一轮：日志应出现「只保留阅读量最高的一条」，成稿 CJK 占比为 0，X 草稿标题为英文
