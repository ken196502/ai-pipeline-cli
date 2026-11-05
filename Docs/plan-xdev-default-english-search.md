# Plan: Xdev 搜索默认限定英文内容 (lang:en)

## 背景与需求
用户要求：Xdev pipeline 的搜索默认只搜英文内容。

## 分析与设计
1. **搜索实现位置**：
   - `AIGC-pipeline/src/pipelines/xdev/scraper.ts` 中的 `scrapeTweetsForKeywords`。
   - 目前拼接 URL：`https://x.com/search?q=${encodeURIComponent(keyword)}&f=${rank}`。
   - 如果关键词中未指定 `lang:`，默认自动追加 `lang:en`。
   - 保证日志打印输出清晰明确，让用户看到最终实际检索的 query（例如 `Agent system lang:en`）。
2. **CLI / Contracts**：
   - 检查 `AIGC-pipeline/src/pipelines/xdev/contracts.ts` 与 `cli.ts`：是否需要预设或者保持灵活性。
   - 保持关键词本身干净，在 `scraper.ts` 中规范化处理：如果查询词没有显式指定 `lang:...`，则自动追加 `lang:en`。
   - 增加纯函数辅助方法（例如 `buildSearchQuery(keyword: string): string`），方便单元测试覆盖。
3. **测试**：
   - 针对 `buildSearchQuery` 编写单元测试，验证：
     - 普通英文/通用词 -> 自动追加 `lang:en`
     - 已经带有 `lang:en` 或其他语言限定的词 -> 保持原样不重复添加
     - 多个关键词各自正确处理
   - 运行测试并验证编译。

## 涉及文件
- `AIGC-pipeline/src/pipelines/xdev/scraper.ts`
- `AIGC-pipeline/tests/xdev-search-lang.test.ts` (新建测试)
