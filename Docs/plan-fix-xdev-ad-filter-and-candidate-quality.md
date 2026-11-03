# xdev 广告与垃圾推文硬过滤及候选质量增强方案

## 1. 根因分析
1. **爬虫层（Stage 1）广告识别极其简陋**：
   - 仅检查 DOM 文本是否包含官方推广词 `Sponsored` / `Promoted` / `Ad`。
   - 大量 Web3 发币、空投、Token 炒作推文（如 `Mint free via Binance Agentic Wallet`、`#IAO`、`$TOKEN`、`airdrop` 等）被视为“有效推文”，占满了 `tweetsPerKeyword` 配额。
   - 导致爬虫早早停止翻页，最终交给 LLM 的 5 条推文中竟然有 2-3 条是发币垃圾，有效推文只剩 1-2 条。
2. **LLM 审稿人（Stage 2）无“宁缺毋滥”门禁与硬性技术范围限定**：
   - 强行要求 LLM “必须挑选出 1 个”，导致在候选池全为垃圾/偏题时，LLM 强行把单一模型 API 水印合规文档（`grok-4.20-multi-agent` 的 EU AI Act 免责条款）脑补为“多智能体输出治理”。
   - 缺乏对“单纯蹭模型名”、“API 服务条款/计费/水印”的显式否决规则。

## 2. 修复方案
1. **Stage 1 爬虫层：增加程序化硬核垃圾/广告/发币过滤（Spam & Crypto Hard Filter）**：
   - 在 `scraper.ts` 中，对提取出的推文文本和作者信息执行程序化检测。
   - 过滤特征库：
     - Web3 / 发币 / 炒币：`mint free`, `airdrop`, `token`, `#iao`, `#ico`, `presale`, `binance`, `dex`, `solana`, `pump.fun`, `memecoin`, `yield`, `wallet`, `web3`, `staking`, `defi` 等。
     - 纯营销引流 / 抽奖 / 互粉：`giveaway`, `follow & rt`, `retweet to win` 等。
   - 命中上述特征直接 `filteredAdCount++` 并 `continue`，**绝不计入 `collectedForThisKeyword`**！
   - 确保抓取到的必须是真正的技术候选推文，抓满目标数量才停止。
2. **扩大候选数量与质量**：
   - 将 `tweetsPerKeyword` 从 5 提升到 8，确保即使经过深度过滤后，依然有充足的高质量候选交给 LLM。
3. **Stage 2 审稿人：严格判定多智能体架构与协同工程，禁止脑补单一模型 API**：
   - 提示词中明文禁止：
     - 禁止选择单一模型的 API 说明文档、版本更名、水印合规、计费、服务条款。
     - 必须是真正的 Multi-Agent 架构协同问题（通信协议、任务拆解、拓扑编排、状态同步、协同死锁与冲突裁决等）。
   - 增加“宁缺毋滥”机制：若所有候选均不符合多智能体工程标准，明确允许且要求返回空数组，触发流水线 Fail-Fast 报警，绝不强行编造。
