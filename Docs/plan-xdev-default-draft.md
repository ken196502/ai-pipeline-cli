# 计划：xdev 默认只填草稿，不再默认发布到 X

## 现状

- `src/pipelines/xdev/contracts.ts:36`：`publishMode` 默认 `'publish'`。
- `src/pipelines/xdev/cli.ts:29`：只有 `--draft-only` 或 `--publish-mode draft` 才进草稿，否则一律点 Publish。
- `src/pipelines/xdev/execute.ts:233`：`options.publishMode || 'publish'` 再次兜底成发布。

结果：一条 `npm run xdev` 就会把文章真发到 X 上，误触成本高。

## 目标

1. **默认 = 草稿**：填好 X Article 编辑器、截图校验，但**不点 Publish**。
2. 想发布必须显式要求：`--publish` 或 `--publish-mode publish`。
3. `--draft-only` 保留为最高优先级的保险开关（与 `--publish` 同时给出时仍然走草稿）。
4. 启动时打印本次目标，避免误以为已经发布。

## 改动

### `src/pipelines/xdev/contracts.ts`

- `publishMode` 默认值 `'publish'` → `'draft'`。
- 新增纯函数 `resolvePublishMode({ draftOnly, publish, publishMode })`：
  - `draftOnly === true` → `'draft'`（最高优先级，安全优先）
  - `publish === true` → `'publish'`
  - `publishMode === 'publish'` → `'publish'`
  - 其余 → `'draft'`
  抽成纯函数是为了不启动浏览器就能单测。

### `src/pipelines/xdev/cli.ts`

- 新增 `--publish`（默认 false，说明「默认只填草稿」）。
- `--publish-mode <mode>` 默认值改为 `draft`，说明里写明默认值。
- `--draft-only` 文案改为「显式草稿（默认已是草稿，此开关用于覆盖 --publish）」。
- 用 `resolvePublishMode(...)` 取代原来的三元表达式。
- 启动打印：`Article target: DRAFT (pass --publish to publish)` 或 `PUBLISH`。

### `src/pipelines/xdev/execute.ts`

- Stage 6.5 的兜底 `options.publishMode || 'publish'` → `'draft'`，与契约默认一致。

### `tests/xdev-publish-mode.test.ts`（新增）

- `XDevPipelineOptionsSchema.parse({})` 的 `publishMode === 'draft'`。
- `resolvePublishMode` 六种组合（空、`--publish`、`--publish-mode publish`、`--draft-only`、`--draft-only + --publish`、`--draft-only + --publish-mode publish`）。
- 断言 `--draft-only` 永远赢。

## 不做

- 不删 `--publish-mode`（保留脚本兼容）。
- 不改 Stage 7 的 Telegram 导出/通知逻辑。
- 不改 `publishToX`（是否进 Stage 6.5）语义。

## 验证

1. `npx tsc --noEmit` 通过。
2. `npx tsx --test tests/xdev-publish-mode.test.ts` 通过。
3. 全量 `tests/*.test.ts` 不新增失败（已知 `telegram-bot-routing.test.ts:362` 为改动前既有失败）。
