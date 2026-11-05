# 计划：完全移除本地历史制品归档去重，仅以 X 线上已发布文章为准

## 现状与问题分析
用户指出：如果使用本地历史制品归档（`loadXDevHistory` 读取 `artifacts/xdev/**/xdev-summary-*.json`），那些本地测试跑批、或者因草稿保存失败、未真正发布到 X 的历史运行制品，也会被当做“已写过”而过滤，导致未真正发布的推文题材被错误去重和丢弃。

## 改造目标
1. 彻底移除 `loadXDevHistory` 以及对本地 `artifacts` 的去重依赖。
2. 保持去重的唯一且权威真相来源：通过浏览器检测登录账号在 `https://x.com/compose/articles` 的 **Published** tab（真实已发布文章）。
3. 清理代码中未使用的导入与旧逻辑，更新单元测试。

## 实施步骤
1. **修改 `execute.ts`**：
   - 移除 `loadXDevHistory` 的导入（保留 `splitByHistory`）。
   - 确保去重仅由 `loadAccountPublishedHistory(browser)` 获取线上已发布历史后执行 `splitByHistory`。
2. **清理/重构 `history.ts`**：
   - 移除或废弃 `loadXDevHistory` 函数，明确文档说明唯一真相来源为 X 线上已发布文章。
3. **更新单元测试 `xdev-history.test.ts`**：
   - 移除针对本地 summary 文件夹读取的过时测试，保留 `tweetIdFromUrl`、`splitByHistory` 等纯逻辑测试。
4. **测试验证**：
   - 运行测试确保套件 100% 通过。
