# Grok 额度耗尽与“假成功”瞒报问题彻底修复方案

## 1. 现场抓包与铁证（通过自动化测试真实截图定位）
在对 `x.com/i/grok` 的真实输入与点击交互进行截图审查（`artifacts/xdev/screenshots/grok-reply-poll-1.png`）后，彻底还原了现场：
1. **账号的 Grok 免费额度已经彻底耗尽**：
   - 页面中间弹出了大卡片：`More Grok with Premium: You have reached your Grok usage limit. Upgrade for more access.`
   - 右下角弹出了灰色 Toast：`Shared links could not be loaded. [Try again]`
2. **为什么流水线“不行了还能跑完”？（严重瞒报漏洞）**：
   - `askGrok()` 在等待回复时，使用 DOM 查找最长文本，把错误弹窗和 Toast 文本（121 字符）当成了“Grok 回答”。
   - 冒烟测试 `xdev-grok-smoke.ts` 和 `askGrok()` 内部仅做了一个极其荒唐的判断：`if (reply.length >= 50) return success`。
   - 导致即便 Grok 已经彻底报额度超限罢工，系统依然把它当成“学术调研成功”，一路绿灯执行到最后，打勾发通知，严重违反了“No fallbacks to hide problems”原则。

## 2. 修复措施
1. **硬核拦截配额超限与系统弹窗（Fail-Fast）**：
   - 在 `bidi-driver.ts` 中显式检测 `You have reached your Grok usage limit`、`More Grok with Premium`、`Shared links could not be loaded`、`Upgrade for more access`。
   - 一旦检测到上述任何字样，**直接判定为致命失败并抛出明确错误**，严禁返回给下游！
2. **冒烟测试与驱动同步设防**：
   - `xdev-grok-smoke.ts` 捕获到额度超限直接抛出 `FATAL: Grok quota exhausted` 并退出码 1，在冒烟阶段就直接阻断流水线启动。
3. **清理测试遗留脚本**。
