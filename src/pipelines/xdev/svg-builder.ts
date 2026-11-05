import pc from 'picocolors';
import { chat } from '../../libs/llm/client.js';

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

function cleanSvgCode(raw: string): string {
  let cleaned = raw
    .replace(/^```(?:xml|svg)?/i, '')
    .replace(/```$/i, '')
    .trim();
  const startIdx = cleaned.indexOf('<svg');
  if (startIdx === -1) {
    throw new Error(`[svg-builder] LLM output does not contain <svg> root element.\nRaw snippet:\n${cleaned.slice(0, 300)}`);
  }
  let endIdx = cleaned.lastIndexOf('</svg>');
  if (endIdx === -1) {
    // If output ended slightly truncated, auto-close
    cleaned = cleaned.slice(startIdx) + '\n</svg>';
  } else {
    cleaned = cleaned.slice(startIdx, endIdx + 6).trim();
  }

  // Basic styling injection if missing
  if (!cleaned.includes('border-radius')) {
    cleaned = cleaned.replace('<svg', '<svg style="border-radius: 16px; margin: 18px 0; border: 1px solid #E2E8F0; box-shadow: 0 10px 28px -6px rgba(15, 23, 42, 0.05);"');
  }
  return cleaned;
}

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
3. VISUAL QUALITY & TOKENS:
   - ViewBox: 0 0 900 460 (width="100%" height="auto")
   - Aesthetics: Clean Apple / Google Material 3 engineering aesthetic with a rich, luminous Macaron pastel palette. Off-white canvas (#F8FAFC), crisp subtle borders (#E2E8F0), soft drop-shadow filters, elegant multi-tone pastel linear gradients.
   - Accents (Rich Macaron Palette): Pistachio mint (#6EE7B7 / #34D399), Soft coral peach (#FDA4AF / #FB7185), Lilac lavender (#C4B5FD / #A78BFA), Powder sky cyan (#7DD3FC / #38BDF8), Creamy buttercup lemon (#FDE047), and Apple System Blue (#0071E3) for primary anchors. Ensure diverse, rich multi-color coding across nodes and lanes.
   - Clean Typography: font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif".
   - Rich technical annotations: concrete metrics, failure states, protocol labels, component badges.
4. STRICT COMPLIANCE:
   - Output ONLY the raw <svg>...</svg> code.
   - NO markdown code block wrapper (\`\`\`xml or \`\`\`svg).
   - 100% English text, ZERO Chinese characters.

Article Title: ${context.articleTitle}
Core Topic: ${context.topicTitle}
Key Insights: ${context.creativeSparks ? context.creativeSparks.slice(0, 1000) : ''}

Article Content Excerpt:
${context.articleBody.slice(0, 4500)}`;

  const res = await chat({
    messages: [{ role: 'user', content: prompt }],
    context: { stage: 'xdev', task: 'svg-architecture-bespoke' },
    timeoutMs: 90_000,
    thinking: false,
  });

  const svg = cleanSvgCode(res.content);
  // Verify basic SVG sanity
  if (!svg.includes('viewBox') || !svg.includes('</svg>')) {
    throw new Error(`[svg-builder] Generated architecture SVG failed sanity check (missing viewBox or closing tag).`);
  }
  return svg;
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
3. VISUAL QUALITY & TOKENS:
   - ViewBox: 0 0 900 460 (width="100%" height="auto")
   - Aesthetics: Clean Apple / Google Material 3 engineering aesthetic with a rich, luminous Macaron pastel palette. Off-white canvas (#F8FAFC), crisp subtle borders (#E2E8F0), soft drop-shadow filters, elegant multi-tone pastel linear gradients.
   - Accents (Rich Macaron Palette): Pistachio mint (#6EE7B7 / #34D399), Soft coral peach (#FDA4AF / #FB7185), Lilac lavender (#C4B5FD / #A78BFA), Powder sky cyan (#7DD3FC / #38BDF8), Creamy buttercup lemon (#FDE047), and Apple System Blue (#0071E3) for primary anchors. Ensure diverse, rich multi-color coding across lifelines, validation gates, and message tokens.
   - Clean Typography: font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif".
   - Clear sequence markers, badges, and step callouts.
4. STRICT COMPLIANCE:
   - Output ONLY the raw <svg>...</svg> code.
   - NO markdown code block wrapper (\`\`\`xml or \`\`\`svg).
   - 100% English text, ZERO Chinese characters.

Article Title: ${context.articleTitle}
Core Topic: ${context.topicTitle}
Key Insights: ${context.creativeSparks ? context.creativeSparks.slice(0, 1000) : ''}

Article Content Excerpt:
${context.articleBody.slice(0, 4500)}`;

  const res = await chat({
    messages: [{ role: 'user', content: prompt }],
    context: { stage: 'xdev', task: 'svg-sequence-bespoke' },
    timeoutMs: 90_000,
    thinking: false,
  });

  const svg = cleanSvgCode(res.content);
  // Verify basic SVG sanity
  if (!svg.includes('viewBox') || !svg.includes('</svg>')) {
    throw new Error(`[svg-builder] Generated sequence SVG failed sanity check (missing viewBox or closing tag).`);
  }
  return svg;
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
