# Plan: 修复 x-editor 粘贴校验误判

## 现象

run `2026-11-02T10-47-50-393Z` Stage 6.5 报错：

```
⚠ [x-editor] paste #1 丢失（新增 0 块，预期 ≥1）
⚠ [x-editor] paste #2 丢失（新增 0 块，预期 ≥1）
⚠ [x-editor] paste #3 丢失（新增 0 块，预期 ≥1）
💥 [publish-to-x] 失败: [x-editor] 连续 3 次粘贴均未落盘（预期 ≥1 块）
```

## 根因（两层，第二层是真正的原因）

### 第一层：块数增量对单块 op 无效

`pasteHtmlVerified()` 只用**块数量增量**判断：

```ts
const minDelta = Math.max(1, expectedBlocks - 1);
if (delta >= minDelta) return;   // delta 只算 blocks
```

X 的 paste handler 遇到**单块 op**（开头那段 lead paragraph）时会直接填充
`ensureEmptyParagraph()` 准备好的空段落，不新建块 → `Δblocks = 0` → 判失败 →
重贴一遍（内容重复）→ 再判失败 → 3 次后抛错。

### 第二层：`readStructure()` 把每块文本截断到 120 字符

```ts
// x-article-editor.ts:129
const blocks: EditorBlock[] = raw.blocks.map((b: any) => ({
  ...
  text: b.text.slice(0, 120),   // ← 为报告而截断
}));
```

页内算好的 `chars` 是完整值，但 `blocks[].text` 被截到 120。
任何「把 block text 拼起来数字符」的校验，单块长段落永远只能看到约 104 个非空白字符
——这正是每次告警都显示「104 字符」的原因。

实测（`scripts/diag-xdev-paste10.ts`，粘贴 800 字符到新草稿）：

```
blocks: 1, innerTextLen: 800   ← DOM 里是完整的 800 字符
```

即粘贴**从未失败**，是两次测量都用了被截断的视图。

证据链：

1. 失败草稿 `2117209327257964544` 里 **确实有**引用块文字（4 blocks / 301 字符 ≈ 3 × 102，即三次重复粘贴）
2. `scripts/diag-xdev-paste4.ts` 用真实文章 md 重建 7 个 op，在**新建草稿 + 标题 + 封面图**的完整序列下重放：

```
op#0 html blocks=1  Δblocks=0  Δchars=102   ← 单块 op，块数不涨、文字涨了
op#2 html blocks=6  Δblocks=5  Δchars=574
op#4 html blocks=5  Δblocks=4  Δchars=475
op#6 html blocks=8  Δblocks=9  Δchars=925
result: ALL OPS LANDED
```

`op#0` 就是生产里报「新增 0 块」的那个 op。

## 改动

`src/pipelines/xdev/x-article-editor.ts`：

1. 新增 `structureChars(structure)` → 改为直接使用页内完整值 `structure.chars`（不再拼 block text）。
2. `pasteHtmlVerified()` 同时比较字符增量：

```ts
const minChars = Math.max(10, Math.floor(plain.replace(/\s/g, '').length * 0.8));
...
if (delta >= minDelta || deltaChars >= minChars) return;
```

3. 告警文案同时输出块数与字符数，下次再出问题能直接分辨是「真丢」还是「判据不足」。

## 不做

- 不改粘贴机制（`props.onPaste` 这条路径实测可用，diag4 全部 op 落盘）
- 不加超时 / 不改重试次数

## 验证

- `npx tsc --noEmit` ✅
- `npx tsx --test tests/xdev-publish-mode.test.ts` 4/4 ✅
- `scripts/diag-xdev-paste4.ts` 用真实文章 op 在新建草稿上重放：

```
op#0 html blocks=1 Δblocks=0 Δchars=782    ← 836 字符的 lead，93% 落盘
op#2 html blocks=5 Δblocks=4 Δchars=1849
op#4 html blocks=4 Δblocks=3 Δchars=1666
op#6 html blocks=8 Δblocks=11 Δchars=2591
result: ALL OPS LANDED
```

- 重跑全流程，Stage 6.5 应输出「✔ 正文写入完成」

## 副作用清理

diag 过程中在 X 上留下若干测试草稿（`2117209327257964544`、`2117210987615203328`、`2117213177138302976`、`2117214422477438976`、`2117214507089235968`、`2117214868516593664`、`2117214932626448384`、`2117214997210411008`、`2117215818861907968`、`2117216255262232578`）。不影响正式流程，可手动删除。
