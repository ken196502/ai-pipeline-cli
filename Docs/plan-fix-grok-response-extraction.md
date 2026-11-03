# Plan: Fix Grok Response Extraction and Streaming Completion Detection

## 1. Problem Diagnosis
In artifact `AIGC-pipeline/artifacts/xdev/2026-11-02T06-05-41-890Z/grok-response-2026-11-02T06-05-41-890Z.md`, the extracted response text was truncated to:
```text
Searched the web
dev.to
auravcs.com
agentconn.com
+25
Browsed https://arxiv.org/html/2605.20563v1
...
```
This is only Grok's intermediate "web browsing status / citation pill block", not the actual AI synthesis response text.

### Root Cause in `bidi-driver.ts`:
1. **Flawed streaming completion detection**:
   `bidi-driver.ts` used:
   ```ts
   if (grokReply.length > 200) {
     const stillStreaming = await browser.execute(() => Boolean(document.querySelector('[aria-busy="true"], [data-testid*="loading" i]')));
     if (!stillStreaming) break;
   }
   ```
   On x.com Grok:
   - When Grok performs live web search, the search status / source link pill list (`Searched the web... Browsed ...`) reaches > 200 characters.
   - During search/thinking phase, `[aria-busy="true"]` is not present; instead x.com displays a `button[aria-label="Stop"]` or `[data-testid*="stop"]` / loading spinner.
   - Because `stillStreaming` evaluated to `false` while `grokReply.length > 200`, the loop prematurely exited on Poll 4~7 while Grok was still thinking or only outputting search indicators.

2. **Crude DOM query**:
   The code queried `div, p, span` and sorted by length without targeting the assistant message bubble or excluding tool/search metadata pills.
   In Grok's transcript layout:
   - The user turn has class `group/user` or text matching prompt.
   - The assistant turn is contained in `div.group` / assistant message container.
   - Crucially, Grok indicates generation completion when the `Stop` button (`button[aria-label="Stop"]`, `button[aria-label*="Stop" i]`, `[data-testid*="stop" i]`) disappears after having appeared, or when the send button/textarea is re-enabled for input.

## 2. Solution
1. **Accurate Generation Completion Detection**:
   - Track generation lifecycle: wait for generation to start (Stop button appears or response container changes) and wait until generation stops (Stop button disappears, `[aria-busy="true"]` absent, or textarea re-enabled/send button available).
   - Require waiting a minimum grace period and polling until text stabilizes (no change across polls) or Stop button disappears.
   - Max poll timeout: up to 120s (Grok web search + deep reasoning can take 30-50s).

2. **Precise Target Extraction**:
   - Identify the assistant response block in the Grok transcript (excluding user input bubble, header elements, noise elements).
   - If Grok begins with search pills or "Thought for Xs", retain the actual synthesis while ensuring the substantial content is captured.
   - Require that valid Grok response is not merely search status text (e.g. check that it does not consist solely of `Searched the web\n... Browsing...`).

3. **Verify with Smoke Test**:
   - Run `tools/xdev-grok-smoke.ts` and verify it extracts the full Grok synthesis with length > 500 chars and actual text.
   - Re-run the target query to verify that the extracted content contains the rich technical analysis rather than just the search pill summary.
