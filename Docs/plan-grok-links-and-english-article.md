# Plan: Grok Citation Links, English Article Synthesis with Tweet Source Links

## 1. Requirements
1. **Grok Prompt**:
   - Instruct Grok to attach real reference links / source URLs for all cited claims, papers, blog posts, and engineering reports.
2. **Article Synthesis (LLM Stage)**:
   - Full article must be written 100% in professional English.
   - Any tweet reference or material quotation must include the original tweet link (`tweet.tweetUrl` / source link).
3. **Execution**:
   - Build TypeScript project.
   - Run xdev pipeline inside a named tmux session (`xdev-pipeline`).
   - Report the tmux attach/view/kill commands and notification details to the user.

## 2. Changes
- `AIGC-pipeline/src/pipelines/xdev/execute.ts`:
  - Enhance `grokPrompt` to require inline/markdown links for sources.
  - Check `synthesizeFocusedArticle` prompt to mandate pure English language output, and ensure input data includes tweet URLs so the LLM can cite them directly.
- `AIGC-pipeline/src/pipelines/xdev/prompts.ts` (or relevant synthesis prompt file):
  - Update system prompt & user prompt to strictly write in English.
  - Require markdown links to the original tweets (e.g. `[Author on X](https://x.com/...)`).

## 3. Verification & Execution
- Run `npm run build` in `AIGC-pipeline`.
- Launch tmux session `xdev-pipeline`.
- Provide status commands to the user.
