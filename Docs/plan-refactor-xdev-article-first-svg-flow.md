# Plan: Refactor xdev Pipeline Flow (Write Article First -> Generate Diagram From Real Text) & Eliminate Fallbacks

## Problems & Requirements
1. **Rule Violation: Fallbacks to hide problems**
   - In `src/pipelines/xdev/svg-builder.ts`, `generateContextualArchitectureSvg` and `generateContextualSequenceSvg` caught errors and silently fell back to `DEFAULT_ARCH_SPEC` and `DEFAULT_SEQ_SPEC`.
   - AGENTS.md rule: "No fallbacks to hide problems". If SVG spec generation or parsing fails, it must throw a clean, informative error (fail loudly) or retry with explicit feedback, never hide the failure behind static generic diagrams.
2. **Architecture Flaw: Drawing diagrams before writing the article**
   - Stage 5 was generating SVGs *before* the article was synthesized in Stage 6.
   - The SVG generator was only given short snippets (`topicTitle`, brief sparks), completely unaware of the actual system architecture, components, workflow, trade-offs, and terminology created in the article.
   - Result: The SVGs were disconnected from the article content.
3. **Correct & Logical Pipeline Order**:
   - **Stage 5 (Part A)**: Generate real header image from topic.
   - **Stage 5 (Part B)**: Synthesize full technical thought article first (with natural placeholders `{{HEADER_IMAGE}}`, `{{SVG_ARCH}}`, `{{SVG_SEQ}}`).
   - **Stage 6**: Extract the concrete architecture components, failure modes, lifelines, and execution steps *directly from the synthesized article body*. Pass the actual article sections into `generateArchitectureSvgFromArticle` and `generateSequenceSvgFromArticle`.
   - **Assemble**: Splice the custom-tailored SVGs into the article markdown.
   - **Export & Dispatch**: Validate HTML rendering, fill X draft, and dispatch to Telegram (configured with `--notify inspilot`).

## Implementation Tasks
1. Update `src/pipelines/xdev/svg-builder.ts`:
   - Delete `DEFAULT_ARCH_SPEC` and `DEFAULT_SEQ_SPEC` fallback behavior.
   - If JSON parse or validation fails, throw an error immediately (no silent fallback).
   - Change input context to accept the actual synthesized article text (`articleMarkdown`, `articleTitle`, `topicTitle`, `creativeSparks`).
   - Design prompts that explicitly extract:
     - The 4 core architectural modules/layers analyzed in the article text.
     - The exact sequence interaction steps/handshakes described in the execution section of the article text.
2. Update `src/pipelines/xdev/analyzer.ts`:
   - Separate article synthesis from SVG insertion: `synthesizeFocusedArticleDraft` produces the pure markdown text.
   - `assembleArticleWithVisuals` inserts the header image and the generated SVGs into the markdown.
3. Update `src/pipelines/xdev/execute.ts`:
   - Swap the order:
     - Step 1: Synthesize article draft.
     - Step 2: Generate Header Image (using article's actual H1/theme).
     - Step 3: Generate Architecture & Sequence SVGs *from the synthesized article content*.
     - Step 4: Assemble finalized markdown and export HTML.
4. Verify by running unit tests and then launching the pipeline under a named tmux session `xdev-pipeline` with `--notify inspilot`.
