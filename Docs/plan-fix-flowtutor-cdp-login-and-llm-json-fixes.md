# Plan: FlowTutor 三处真实故障修复（CDP 启动 / 登录 / LLM JSON）

> 来源：`/mnt/share/VM/Docs/plan-flowtutor-cdp-login-and-llm-json-fixes.md`（2026-11-01 实测记录）。
> 本文件为落地到本仓库的执行版计划，供 codex 实施。

## 0. 现状核实（2026-11-01 07:4x）

| 计划项 | 当前代码状态 |
|---|---|
| F1 LLM JSON 加固 | **未修复**：`src/research/script/generator.ts:440` 仍用裸 `chat()` + `extractJsonObject()`，失败即抛 `LLM_RESPONSE_INVALID`（05:40 运行日志第 11/11 阶段实测复现） |
| F2 CDP 超时/孤儿 | **未修复**：`src/libs/browser/session.ts:282` 仍为 `timeoutMs = 20_000`；超时仅 `throw`，不杀子进程 |
| F3 孤儿浏览器复用 | **未修复**：`src/libs/browser/session.ts` 无 `adoptOrphanBrowser`；`launcher.ts:730` 仅 `isSessionAlive()` |
| F4 登录破坏会话 | **未修复**：`src/libs/browser/direct-login.ts:12-17` 无条件 `Storage.clearDataForOrigin(... 'all')`；密码框后固定等待，无 `/challenge/` 分支；失败路径静默 |

已具备的复用件：
- `src/libs/llm/json-chat.ts` → `chatJsonObject()`：JSON mode + 平衡括号抽取 + 2 次修复重试 + 耗尽抛 `LLM_RESPONSE_INVALID`。
- `src/research/llm/json-chat.ts` → research 包装版（把 `LLMError` 转 `AppError`），签名 `chatJsonObject(req, customConfig) => { value: unknown }`。
- `src/libs/browser/session.ts` → `killProcessTree(pid, signal)`、`clearSessionInfo()`、`readSessionInfo()`、`isPidAlive()`、`isCDPEndpointAlive(port, ms)`。

## 1. 修复项

### F1 — LLM 结构化输出走加固通道（`src/research/script/generator.ts`）

- `reorchestrateExtractedPrompts()` 内把：
  ```ts
  response = await chat({ ... }, env);
  ...
  const extracted = extractJsonObject(response.content);
  if (!extracted.ok || ...) { throw LLM_RESPONSE_INVALID }
  ```
  改为：
  ```ts
  const { value } = await chatJsonObject({
    messages: [...],
    model: env.llmModel,
    context: { stage: 'script', task: 'reorchestrate-prompts' },
    temperature: 0.2,
    timeoutMs: 300_000,
    task: 'prompt re-orchestration',
  }, env);
  ```
  从 `../../research/llm/json-chat.js`（相对本文件为 `../llm/json-chat.js`）导入。
- 保留 catch：`AppError` 直接透传并 `notifyLlmUnavailableAndExit` + throw；其它错误按现状包成 `LLM_REQUEST_FAILED`。
- 删除因此不再使用的 `extractJsonObject` import（若别处仍在用则保留）。
- 后续 `val` 类型断言改为基于 `value`。**不得**保留任何"解析失败就退回确定性模板"的分支（项目禁止 fallback）。

### F2 — CDP 启动超时可配 + 失败杀进程（`src/libs/browser/session.ts`）

`spawnDetachedChromium()`：
1. `timeoutMs` 默认 90_000，可由 `process.env.CDP_START_TIMEOUT_MS` 覆盖；解析失败或 < 5000 时回落默认。
2. 轮询循环中每轮检查 `isPidAlive(pid)`，若进程已退出 → 立即 `throw new Error('Chromium exited before CDP was ready (PID ...)')`，不再白等。
3. 超时或异常路径统一：`killProcessTree(pid, 'SIGKILL')` + `clearSessionInfo(profileDir)`，然后 rethrow。用 `try/catch` 包裹轮询段，确保无孤儿。

### F3 — 收养孤儿浏览器（`session.ts` 新增 + `launcher.ts` 接入）

新增 `export async function adoptOrphanBrowser(profileDir: string): Promise<BrowserSessionInfo | null>`：
1. 读 `<profileDir>/SingletonLock`（内容格式 `hostname-pid`，取最后一个 `-` 之后为 pid；hostname 含 `-` 时不能用 `split('-')[0]`）。
2. `isPidAlive(pid)` 否则返回 null。
3. 读 `/proc/<pid>/cmdline`（`\0` 分隔），必须同时包含 `path.resolve(profileDir)` 与 `--remote-debugging-port=<port>`；任一缺失返回 null（避免误杀用户手动打开的浏览器）。
4. `isCDPEndpointAlive(port)` 存活才继续。
5. `saveSessionInfo(profileDir, { port, profileDir: resolve(profileDir), pid, wsEndpoint, createdAt: now })`，`console.log('[browser] Adopted orphan browser pid ... on port ...')`，返回 session。
6. 非 Linux（无 `/proc`）时安全返回 null。

`launcher.ts`：`launchBrowser()` 中把
```ts
let sessionCheck = await isSessionAlive(profileDir);
```
改为先 `await adoptOrphanBrowser(profileDir)`，再 `isSessionAlive(profileDir)`（收养结果直接作为 alive 分支，不必二次探测）。命中即走既有复用分支。

### F4 — 登录不破坏已有会话 + 不半路返回（`src/libs/browser/direct-login.ts`）

1. 清理前先检查：`page.context().cookies(['https://www.youtube.com','https://accounts.google.com'])`，若存在 `SAPISID`/`SID`/`LOGIN_INFO` 任一 → **跳过** `Storage.clearDataForOrigin`，打印 `[direct-login] 检测到已有认证 cookie，跳过破坏性清理`；否则才清（保留原逻辑）。
2. 点选账号后，把"固定 `waitForTimeout(2000)` + `waitForSelector(密码框, 10s)`"改为**最长 15s 轮询**：
   - 出现密码框（`input[name="Passwd"], input[type="password"]`）可见 → 填密码；
   - URL 含 `/challenge/` 或出现 `#totpPin`、`[data-challengeid]` → 打印明确原因（如 `[direct-login] 需要二次验证/挑战页，自动登录无法继续`）并**立即 `return false`**，不得 `goto` 离开；
   - 超时 → 打印 `[direct-login] 未出现密码框也未出现挑战页（当前 URL: ...）` 并 `return false`。
3. 所有失败路径（含 catch）都打印具体原因，不再静默 `return false`。

## 2. 明确不做

- 不引入任何 fallback（LLM 失败不套模板、浏览器起不来不假装 cookie 有效、TTS 失败不静音）。
- 不改动正在运行的流水线进程；修复只对下次运行生效。
- 不动与这三项无关的既有未提交改动（`src/pipelines/xdev/`、`tools/`、其它 plan 文件）。

## 3. 验收

1. `npx tsc --noEmit` 通过；`npm test` 全绿（至少 `tests/flowtutor-pipeline.test.ts` 与 tts 相关用例不回归）。
2. `grep -n "responseFormat" src/libs/llm/client.ts` 确认 `chatJsonObject` 路径生效；`grep -n "adoptOrphanBrowser" src/libs/browser/*.ts` 有定义与调用。
3. 静态自检：`session.ts` 默认超时为 90000 且支持 `CDP_START_TIMEOUT_MS`；`direct-login.ts` 无 `goto` 出现在 challenge 分支之后。
4. 输出一份 `Docs/flowtutor-fix-report.md`，列出每项改动的文件:行号与验证命令输出摘要。
