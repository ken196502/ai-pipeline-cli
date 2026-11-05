# Implementation Plan: Fix Source Citations, SVG Markdown Escaping, and Context-Aware Header Illustration in xdev

## Background & Issues Identified
1. **Source Citation Issue**: The synthesized blog references user commentary tweets (e.g. `cxuan (@criscxuan)`) instead of citing the underlying primary source article that the tweet is reviewing (Anthropic / Claude engineering guide: *"Building agents: When to fold subagents into your main agent loop"* at `https://claude.com/resources/articles/building-agents-when-to-fold-subagents-into-your-main-agent-loop`).
   - Need to update the prompt templates in `src/pipelines/xdev/analyzer.ts` and the source detection logic so that when a tweet discusses or links an external report/article, the synthesized article prioritizes and cites the original canonical research/article as the primary source, while treating the tweet as an industry discussion signal.
2. **SVG Rendering Failure in HTML**: In `multi-agent-thinking-*.html`, the inline SVGs failed to render because `marked` treats indented lines after blank lines inside raw `<svg>` elements as Markdown code blocks (`<pre><code>...</code></pre>`), breaking SVG syntax.
   - Need to protect raw SVG blocks during HTML export in `src/pipelines/xdev/html-exporter.ts` (e.g. replacing `<svg>...</svg>` with HTML comment tokens or stripping empty lines/indentations before `marked.parse`, then reinserting clean SVG DOM elements).
3. **Header Image Subject Relevance**: The header image prompt currently uses a generic abstract prompt (`Sophisticated minimalist abstract technology 3D illustration... : ${primaryTopicEn}`) that yields pretty visual art with no conceptual connection to the article's core theme (Multi-Agent Main Loop folding, eliminating subagent context fragmentation, atomic state transitions).
   - Need to construct a prompt that directly visualizes the core architectural concept: a unified central processing loop collapsing fragmented sub-agent orbits into a coherent single-stream state machine, with clean technical iconography and conceptual depth.
4. **Artifact Fixes**: Regenerate the header image, fix the markdown/HTML citations to the Anthropic canonical article, fix the SVG rendering in the HTML, and test the standalone view.

## Execution Steps
1. Modify `src/pipelines/xdev/html-exporter.ts` to protect SVG blocks from markdown parsing code-block corruption.
2. Update `src/pipelines/xdev/analyzer.ts` and `src/pipelines/xdev/execute.ts`:
   - Enforce primary source citation rules in prompts: when external blog / canonical source exists (e.g., Anthropic, research papers), cite the canonical source and authoritatively analyze the thesis; do not treat a commentary tweet as the primary thesis author.
   - Refine header image prompt generation to reflect concrete architecture concepts (Main Loop folding, single context stream, collapsing subagent sprawl).
3. Fix the existing artifact `artifacts/xdev/2026-11-03T11-22-55-362Z/multi-agent-thinking-2026-11-03T11-22-55-362Z.md` and `multi-agent-thinking-2026-11-03T11-22-55-362Z.html`:
   - Replace tweet citations with the authoritative Anthropic canonical guide citations.
   - Re-export the HTML using the fixed SVG handling so SVGs render perfectly.
   - Generate a content-relevant header image with `generate_image` tool and replace the disconnected one.
4. Validate with headless browser or node script that SVGs render cleanly without `<pre><code>` wrappers.
