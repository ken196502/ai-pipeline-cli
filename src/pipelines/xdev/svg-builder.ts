import pc from 'picocolors';
import { chat } from '../../libs/llm/client.js';
import { sanitizeSvg, assertWellFormedSvg, assertSvgHasContent, SvgXmlError } from '../../libs/svg/index.js';

function escapeXml(str: string): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Sanitize to pure English text for SVG elements */
function sanitizeEn(str: string, maxLen = 40): string {
  return escapeXml(
    String(str || '')
      .replace(/[\u4e00-\u9fff]/g, '')
      .replace(/["<>]/g, '')
      .trim()
      .slice(0, maxLen)
  );
}

export function buildHeaderBannerSvg(topicTitle: string): string {
  const cleanTitle = sanitizeEn(topicTitle, 45) || 'Distributed Multi-Agent Architecture';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 860 210" width="100%" height="auto" style="border-radius: 16px; margin: 16px 0; border: 1px solid #E2E8F0; box-shadow: 0 8px 24px -4px rgba(15, 23, 42, 0.06);">
  <defs>
    <linearGradient id="appleHeaderBg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#FFFFFF"/>
      <stop offset="60%" stop-color="#F8FAFC"/>
      <stop offset="100%" stop-color="#F1F5F9"/>
    </linearGradient>
    <filter id="softShadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#0F172A" flood-opacity="0.04"/>
    </filter>
  </defs>

  <rect width="860" height="210" fill="url(#appleHeaderBg)" rx="16"/>
  <rect x="44" y="32" width="220" height="26" rx="13" fill="#EEF2FF" stroke="#C7D2FE" stroke-width="1"/>
  <circle cx="56" cy="45" r="4" fill="#4F46E5"/>
  <text x="68" y="49" fill="#4F46E5" font-size="11" font-weight="700" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', sans-serif" letter-spacing="0.6">SYSTEM PARADIGM 2026</text>
  <text x="44" y="94" fill="#0F172A" font-size="24" font-weight="800" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Inter', sans-serif" letter-spacing="-0.5">Autonomous Context Architecture</text>
  <text x="44" y="124" fill="#475569" font-size="14" font-weight="500" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', sans-serif">Self-Prompting Harness · Progressive Eviction · Deterministic State Ledger</text>
  <line x1="44" y1="152" x2="816" y2="152" stroke="#E2E8F0" stroke-width="1"/>
  <text x="44" y="181" fill="#0071E3" font-size="12" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', monospace" font-weight="600">Focus: ${cleanTitle}</text>
  <text x="816" y="181" fill="#64748B" font-size="12" text-anchor="end" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif" font-weight="500">Google &amp; Apple Clean Engineering Standard</text>
</svg>`;
}

/**
 * Extracts the `<svg>…</svg>` payload from an LLM reply.
 *
 * A missing closing tag means the reply was truncated; that is an error, not
 * something to paper over by appending `</svg>` (which is exactly how the
 * 2026-11-05 run ended up rasterising a blank image).
 */
function cleanSvgCode(raw: string): string {
  const cleaned = String(raw ?? '')
    .replace(/^```(?:xml|svg)?/i, '')
    .replace(/```$/i, '')
    .trim();
  const startIdx = cleaned.indexOf('<svg');
  if (startIdx === -1) {
    throw new Error(
      `[svg-builder] LLM output does not contain <svg> root element.\nRaw snippet:\n${cleaned.slice(0, 300)}`
    );
  }
  const endIdx = cleaned.lastIndexOf('</svg>');
  if (endIdx === -1) {
    throw new Error(
      `[svg-builder] LLM output has no closing </svg> after ${cleaned.length} chars — the diagram was truncated mid-output. Refusing to auto-close a partial SVG.`
    );
  }
  let svg = cleaned.slice(startIdx, endIdx + 6).trim();

  // Basic styling injection if missing (inline attribute only — never a <style> block).
  if (!svg.includes('border-radius')) {
    svg = svg.replace(
      '<svg',
      '<svg style="border-radius: 16px; margin: 18px 0; border: 1px solid #E2E8F0; box-shadow: 0 10px 28px -6px rgba(15, 23, 42, 0.05);"'
    );
  }
  return svg;
}

/** Visible primitives outside `<defs>` (markers/filters are not the diagram). */

/**
 * Sanitises, validates and content-checks one SVG candidate.
 * Throws with a precise reason instead of returning something librsvg may
 * silently render as an empty box.
 */
function finalizeSvg(raw: string, label: string): string {
  const extracted = cleanSvgCode(raw);
  const { svg, repairs } = sanitizeSvg(extracted);
  if (repairs.length > 0) {
    console.warn(
      pc.yellow(
        `  ⚠ [svg-builder] ${label}: 自动修复 ${repairs.length} 处 — ${repairs
          .map((r) => `${r.kind}(${r.detail})`)
          .join(' | ')}`
      )
    );
  }

  assertWellFormedSvg(svg, label);
  assertSvgHasContent(svg, label);
  return svg;
}

/**
 * One generation + at most one validator-driven regeneration.
 *
 * The retry is not a silent fallback: the validator's exact error (and the
 * offending lines) are fed back to the model, and if the second attempt is
 * still invalid the stage fails loudly.
 */
async function generateValidSvg(args: { prompt: string; label: string; task: string }): Promise<string> {
  const attempt = async (prompt: string, label: string): Promise<string> => {
    const res = await chat({
      messages: [{ role: 'user', content: prompt }],
      context: { stage: 'xdev', task: args.task },
      timeoutMs: 90_000,
      thinking: false,
    });
    if (res.finishReason === 'length') {
      throw new Error(
        `[svg-builder] ${label}: LLM output hit the token limit (finish_reason=length, completionTokens=${res.usage?.completionTokens ?? 'unknown'}) — the SVG was cut off mid-output`
      );
    }
    return finalizeSvg(res.content, label);
  };

  try {
    return await attempt(args.prompt, args.label);
  } catch (firstErr) {
    const firstMessage = firstErr instanceof Error ? firstErr.message : String(firstErr);
    console.warn(pc.yellow(`  ⚠ [svg-builder] ${args.label} 第 1 次生成不合格: ${firstMessage}`));
    console.log(pc.dim('  ↳ 把校验器错误原文回灌给 LLM 重新生成（仅一次，仍失败则让该阶段失败）'));

    const snippet = firstErr instanceof SvgXmlError && firstErr.snippet ? `\nOffending lines:\n${firstErr.snippet}` : '';
    const repairPrompt = `${args.prompt}

YOUR PREVIOUS ATTEMPT WAS REJECTED by a strict XML validator.
Validator error: ${firstMessage}${snippet}

Rewrite the ENTIRE diagram from scratch. Hard requirements:
- Complete, well-formed XML: every opened element has its closing tag.
- NO <style> blocks, NO CSS classes, NO <script>, NO <foreignObject>.
- All styling goes in inline attributes (fill, stroke, stroke-width, font-size, font-weight, font-family, opacity).
- Real geometry must be present: at least 12 of <rect>/<path>/<line>/<circle>/<text>, not only <defs>.
- Do not repeat element definitions or emit unused declarations.
- Output ONLY the raw <svg>...</svg> element. No prose, no markdown fences.`;

    return attempt(repairPrompt, `${args.label} (repair)`);
  }
}

/** Shared design brief: keeps the two diagram prompts from drifting apart. */
const VISUAL_BRIEF = `AESTHETIC & TECHNICAL RULES:
- ViewBox: 0 0 900 460 (width="100%" height="auto").
- Clean Apple / Google Material 3 engineering look on an off-white canvas (#F8FAFC), crisp borders (#E2E8F0), soft shadows.
- Rich macaron accents: Pistachio mint (#6EE7B7 / #34D399), coral peach (#FDA4AF / #FB7185), lilac (#C4B5FD / #A78BFA), sky cyan (#7DD3FC / #38BDF8), buttercup lemon (#FDE047), Apple System Blue (#0071E3).
- Typography via inline attributes only: font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif".
- Concrete technical annotations: real metrics, failure states, protocol labels, component badges.

STRICT COMPLIANCE (a strict XML validator rejects the output otherwise):
- Output ONLY the raw <svg>...</svg> element. No markdown fences, no prose.
- 100% English text, ZERO Chinese characters.
- NO <style> blocks, NO CSS classes, NO <script>, NO <foreignObject>: every visual property must be an inline attribute.
- Every opened element must be closed; self-close empty elements (<rect .../>).
- 12–60 visible elements total. Do NOT emit unused definitions or repeated declarations.
- Text content must not contain raw < or & characters.`;

/**
 * Generate a bespoke, highly customized architectural vector diagram (SVG)
 * directly from the synthesized article's exact technical content and data points.
 * Completely free-form SVG generation: NO rigid card-box templates, NO fallbacks.
 */
export async function generateArchitectureSvgFromArticle(context: {
  topicTitle: string;
  articleTitle: string;
  articleBody: string;
  creativeSparks?: string;
}): Promise<string> {
  const prompt = `You are a world-class principal system architect, technical visual journalist, and master SVG designer.
Your task is to design an exquisite, bespoke, topic-tailored ARCHITECTURAL VECTOR DIAGRAM in raw SVG code to accompany the following technical article.

CRITICAL VISUAL DESIGN PRINCIPLES:
1. ABSOLUTELY NO GENERIC TEMPLATES: DO NOT just draw 4 identical rectangles in a horizontal row. That is completely banned.
2. BESPOKE VISUAL METAPHOR: Choose a spatial layout and visual metaphor that truly reflects the technical reality of this specific article:
   - If comparing single-agent vs multi-agent/pipeline: Use a side-by-side or funnel comparison showing metrics (e.g. 14/70 bugs vs 66/70 bugs, context overflow vs distributed verification).
   - If depicting loop folding / progressive disclosure: Show a central continuous loop absorbing modular skills on-demand with deferred tool search.
   - If depicting Git-backed deterministic state: Illustrate state transitions feeding into linear commit logs and branch protection rules.
3. ${VISUAL_BRIEF}

Article Title: ${context.articleTitle}
Core Topic: ${context.topicTitle}
Key Insights: ${context.creativeSparks ? context.creativeSparks.slice(0, 1000) : ''}

Article Content Excerpt:
${context.articleBody.slice(0, 4500)}`;

  return generateValidSvg({ prompt, label: 'architecture-svg', task: 'svg-architecture-bespoke' });
}

/**
 * Generate a bespoke, highly customized interaction sequence or execution flow diagram (SVG)
 * directly from the synthesized article's exact handshakes and failure/recovery paths.
 * Completely free-form SVG generation: NO rigid 4-lifeline templates, NO fallbacks.
 */
export async function generateSequenceSvgFromArticle(context: {
  topicTitle: string;
  articleTitle: string;
  articleBody: string;
  creativeSparks?: string;
}): Promise<string> {
  const prompt = `You are a world-class principal system architect, technical visual journalist, and master SVG designer.
Your task is to design an exquisite, bespoke, topic-tailored INTERACTION TIMELINE & WORKFLOW DIAGRAM in raw SVG code to accompany the following technical article.

CRITICAL VISUAL DESIGN PRINCIPLES:
1. ABSOLUTELY NO GENERIC TEMPLATES: DO NOT draw a trivial 4-column swimlane with identical step lines unless the workflow specifically calls for that exact structure.
2. AUTHENTIC WORKFLOW & DATAFLOW:
   - Illustrate the exact actors, protocols, validation loops, and handshakes discussed in the article text.
   - Clearly delineate where execution succeeds vs where stochastic failure / context loss occurs.
   - Highlight state persistence (e.g. Git commits, verification gates, consensus voting).
3. ${VISUAL_BRIEF}

Article Title: ${context.articleTitle}
Core Topic: ${context.topicTitle}
Key Insights: ${context.creativeSparks ? context.creativeSparks.slice(0, 1000) : ''}

Article Content Excerpt:
${context.articleBody.slice(0, 4500)}`;

  return generateValidSvg({ prompt, label: 'sequence-svg', task: 'svg-sequence-bespoke' });
}

// Backward-compatible exports for unit tests
export function buildArchitectureSvg(topicTitle: string): string {
  const cleanTitle = sanitizeEn(topicTitle, 45) || 'Multi-Agent Subsystem Architecture';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 380" width="100%" height="auto" style="border-radius: 16px; margin: 18px 0; border: 1px solid #E2E8F0;">
  <rect width="900" height="380" fill="#F8FAFC" rx="16"/>
  <text x="36" y="50" fill="#0071E3" font-size="12" font-weight="700" font-family="-apple-system, sans-serif">ARCHITECTURE BLUEPRINT</text>
  <text x="36" y="78" fill="#0F172A" font-size="20" font-weight="800" font-family="-apple-system, sans-serif">${cleanTitle}</text>
</svg>`;
}

export function buildSequenceSvg(topicTitle: string): string {
  const cleanTitle = sanitizeEn(topicTitle, 45) || 'Interaction Sequence';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 380" width="100%" height="auto" style="border-radius: 16px; margin: 18px 0; border: 1px solid #E2E8F0;">
  <rect width="900" height="380" fill="#F8FAFC" rx="16"/>
  <text x="36" y="50" fill="#4F46E5" font-size="12" font-weight="700" font-family="-apple-system, sans-serif">INTERACTION TIMELINE</text>
  <text x="36" y="78" fill="#0F172A" font-size="20" font-weight="800" font-family="-apple-system, sans-serif">${cleanTitle}</text>
</svg>`;
}
