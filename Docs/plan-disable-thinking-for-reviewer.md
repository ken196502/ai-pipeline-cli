# Plan: 按请求关闭 Qwen 思考（仅审稿阶段）

## 现状与实测

`.env` 里 `LLM_REASONING_EFFORT=minimal`，但：

1. `LLM_API_STYLE=chat` 时该变量**从未进入请求体**（只有 `buildResponsesBody` 用它）。
2. 即使手工加到 chat body，模型也**忽略**它。同一 prompt（`17*23`）实测：

| 请求参数 | reasoning 字符数 |
|---|---|
| 不带参数 | 203 |
| `reasoning_effort: "low"` | 197 |
| `reasoning_effort: "minimal"` | 208 |
| `reasoning_effort: "none"` | 249 |
| `chat_template_kwargs: {"enable_thinking": false}` | **0** |

结论：Qwen3.8-Flash-Next 这个部署既不认 `low` 也不认 `minimal`，唯一有效开关是 `chat_template_kwargs.enable_thinking`。

后果：Stage 2 审稿单次调用流式思考 13 分钟、1.08 MB SSE；Stage 6 写稿同样。

## 方案（选项 2）

只关审稿，不关写作：

- Stage 2 `tweet-eval-selection`（20 条里挑 1~2 条）→ `thinking: false`
- Stage 6 `article-synthesis` → 保持默认（开思考）

## 改动

1. `src/libs/llm/types.ts`：`ChatRequest` 增加可选 `thinking?: boolean`。
2. `src/libs/llm/client.ts`：`rawFetchRequest` 构造 chat body 时，若 `args.thinking === false`，写入
   `body.chat_template_kwargs = { enable_thinking: false }`。responses 分支不动。
3. `src/pipelines/xdev/analyzer.ts:184` 的 `requestSelection` 传入 `thinking: false`。

## 不做

- 不改 `.env`（`LLM_REASONING_EFFORT` 保留原值，明确它对本模型无效，避免再被误认为生效）
- 不改 Stage 6（初版结论，已被下面的追加实验推翻）
- 不加任何超时 / abort / 复读检测

## 追加：写作阶段（Stage 6）也关

用户要求「先试 low，不行就关」。用真实写作 prompt（3 段技术小节，`max_tokens: 800`）各跑 3 次：

| 参数 | reasoning 字符 | 耗时 |
|---|---|---|
| 不带参数 | 1439 / 850 / 757 | 22s / 20s / 33s |
| `reasoning_effort: "low"` | 402 / 462 / **2776** | 15s / 18s / 44s |
| `reasoning_effort: "minimal"` | 686 | 35s |
| `enable_thinking: false` | **0** | 15s |

`low` 有一次跑到 2776，比任何 baseline 都高 —— 波动远大于参数影响，不可控。结论：写作阶段同样关思考，`analyzer.ts:476` 加 `thinking: false`。

背景：思考开着时该调用曾跑 26 分钟 / 13.8 万字符 reasoning，逐句自查（`Potential issue: … Good.` 出现 429 次），不收敛。

## 验证

- `npx tsc --noEmit`
- 一次性真实调用：`chat({ thinking: false })` 应无 `[llm] 🧠` 输出、耗时显著下降
- 下一次 xdev run：Stage 2 秒级完成，Stage 6 也应在 1~2 分钟内出稿（无 `[llm] 🧠` 长流）
