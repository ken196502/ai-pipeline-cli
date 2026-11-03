# Plan: Fix xdev Pipeline Article Tone, Grok Highlights Extraction, and Bright English SVG/Image Generation

## Problem Statement
The user explicitly clarified: the target is modifying the **xdev pipeline source code**, not manually fixing an individual generated artifact.
Key issues in the pipeline:
1. **Article synthesis tone**: Produced long, academic, rambling treatises with meaningless transition filler (e.g. "The core thesis is clear:").
2. **Missing sharp highlights/innovations**: The pipeline didn't instruct Grok and the synthesis LLM to explicitly dig up and extract core highlights and counter-intuitive innovations from reference material.
3. **SVG & diagram text**: Embedded Chinese text in diagrams and SVGs, looking clumsy and inconsistent with international tech articles.
4. **Color aesthetic**: The generated images and SVGs had dull, muddy, drab palettes instead of modern, crisp, bright, high-contrast aesthetics (Electric Cyan, Neon Violet, Emerald Glow).

## Pipeline Architectural Changes

### 1. `src/pipelines/xdev/analyzer.ts`
- **Grok Prompt Enhancement**: Instruct Grok to explicitly unearth the **top technical highlights and non-consensus innovations** with authoritative references/links.
- **Article Synthesis Prompt Overhaul**:
  - Remove all academic treatise fluff, meaningless filler transitions (explicitly banning "The core thesis is clear:").
  - Frame the article as a sharp, pragmatic engineering essay/reflection focused purely on **highlights, breakthrough mechanics, and architectural novelties**.
  - Direct, punchy, conversational yet authoritative.

### 2. `src/pipelines/xdev/svg-builder.ts`
- Ensure all SVG templates (`buildHeaderBannerSvg`, `buildArchitectureSvg`, `buildSequenceSvg`):
  - Strictly contain **100% English text and labels**.
  - Use vibrant, modern, high-contrast, luminous color palettes:
    - Primary: Electric Cyan (`#00f2fe`), Sky Blue (`#38bdf8`)
    - Accent: Neon Violet (`#c084fc`, `#7f00ff`), Emerald Glow (`#10b981`)
    - Background: Deep Dark Sleek Slate (`#080c14` / `#0b0f19`) with radiant glow filters and subtle gradient borders (`rgba(0, 242, 254, 0.25)`).

### 3. `src/pipelines/xdev/image-generator.ts` (or prompt injection in execute.ts)
- Inject modern, bright, luminous art direction into the header image prompt:
  - "Luminous electric cyan and neon violet vibrant colors, glowing cyber nodes, glassmorphism prisms, high contrast, clean modern tech aesthetic, ultra crisp, vivid lighting, sleek minimalist digital art, no text, 8k".

## Verification Plan
1. Run unit/integration tests to verify pipeline builds and contracts hold.
2. Verify TypeScript type-checking (`npx tsc --noEmit`).
3. Ensure git status tracks modified pipeline files and plan document.
