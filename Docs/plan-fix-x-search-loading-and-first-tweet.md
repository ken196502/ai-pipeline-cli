# 计划：修复 X 搜索时间线等待加载与账号真实发布历史去重

## 核心发现与根因定位
1. **加载延迟导致第一批推文（包括排在首位的 DeepSeekHarness 2.7M）完全被漏扫**：
   - 经实测，Firefox 打开 `https://x.com/search?q=...` 后，X 的客户端渲染需要 **6~7 秒** 才能把第一批 `article[data-testid="tweet"]` 挂载到 DOM 上（前 4~5 秒只有骨架屏和 spinner）。
   - 原代码 `await browser.pause(4500)` 在第 1 轮滚动时 `rawArticles.length` 为 **0**，直接跳过了首屏最关键的推文，接着执行 `window.scrollBy(0, 1800)` 滚到了下面，导致排在首屏顶部的推文直接被滚走、漏掉。
   - **解法**：进入搜索页后，不能只傻等固定 4500ms，必须显式等待推文元素出现（`waitForTweetArticles(browser)`，轮询至出现 `article[data-testid="tweet"]` 或超时最多 15s），确保首屏推文 100% 完整被解析。

2. **历史记录来源修正：以线上已发布文章为准**：
   - 目前 `loadXDevHistory` 是遍历本地 `artifacts/xdev/` 下的所有运行目录（包括本地调试、草稿生成）。而用户实际上在 X 账号上**尚未点击发布过任何文章**，本地目录却导致“已写过”被误判。
   - **解法**：在启动时或通过浏览器直接检查线上账号已发布文章（`Published`），或者提供配置选项让历史去重以实际线上发布为准，不让本地测试目录污染选题。

## 改进方案与步骤
1. **重构 `src/pipelines/xdev/scraper.ts` 加载等待逻辑**：
   - 增加 `waitForTweets(browser, timeoutMs = 15000)`：
     ```ts
     async function waitForTweets(browser: Browser, timeoutMs = 15000): Promise<boolean> {
       const deadline = Date.now() + timeoutMs;
       while (Date.now() < deadline) {
         const count = await browser.execute(() => document.querySelectorAll('article[data-testid="tweet"]').length);
         if (count > 0) return true;
         await browser.pause(800);
       }
       return false;
     }
     ```
   - 无论是初次打开搜索页，还是滚动后，都确保等待网络数据加载与 DOM 渲染完成，彻底杜绝首屏第一条推文因为渲染延迟被跳过的问题。

2. **修复滚动中的新元素加载等待**：
   - 滚动后等待 `article[data-testid="tweet"]` 的增加或内容刷新，确保每次滚动的批次都能稳定被处理。

3. **测试验证**：
   - 运行针对搜索页与 DeepSeekHarness 抓取的脚本，验证首屏第一条推文稳定被抓取；
   - 运行单元测试保证无语法或逻辑破坏。
