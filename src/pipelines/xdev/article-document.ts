/**
 * Markdown -> X Article document model.
 *
 * The old publisher flattened everything into plain paragraphs with regex
 * stripping (SVG removed, `![]()` removed, `>` metadata dropped), which is why
 * every published article was a wall of text with no images, no citation and no
 * visible structure. This module keeps the structure: headings stay headings,
 * quotes stay quotes, images stay images (SVG gets rasterised later), and the
 * tweet source is injected deterministically instead of hoping the LLM does it.
 */

export interface ArticleSource {
  authorName: string;
  authorHandle: string;
  tweetUrl: string;
  tweetText: string;
  publishedAt?: string;
  links?: Array<{ url: string; title?: string }>;
}

export type ArticleBlock =
  | { type: 'heading'; level: 2 | 3; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'quote'; text: string; cite?: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'divider' }
  | { type: 'image'; src?: string; svg?: string; alt: string; caption?: string };

export interface ArticleDocument {
  title: string;
  blocks: ArticleBlock[];
}

/** Ops the editor driver replays one by one. */
export type ArticleOp =
  | { kind: 'html'; html: string; plain: string; blocks: ArticleBlock[]; blockCount: number }
  | { kind: 'image'; block: Extract<ArticleBlock, { type: 'image' }> }
  | { kind: 'divider' };

const METADATA_LINE = /^\*\*(记录日期|核心立论|日期|Date)\*\*/i;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Minimal inline markdown -> HTML. X's Draft.js paste handler understands
 * strong/em/code/a, which is all the article body needs.
 */
export function inlineToHtml(text: string): string {
  let s = escapeHtml(text.trim());
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  // Bare URLs that are not already inside an href
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)"']+)/g, '$1<a href="$2">$2</a>');
  return s;
}

/** Plain-text projection used for the clipboard's text/plain flavour. */
export function inlineToPlain(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

function normalizeInline(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Parse the article markdown into blocks. Order is preserved so the writer's
 * narrative (intro -> mechanism -> trade-offs -> conclusion) survives.
 */
export function parseMarkdownToBlocks(markdown: string): ArticleDocument {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let title = '';
  const blocks: ArticleBlock[] = [];

  let paragraph: string[] = [];
  let quote: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const text = normalizeInline(paragraph.join(' '));
    paragraph = [];
    if (text) blocks.push({ type: 'paragraph', text });
  };
  const flushQuote = () => {
    if (!quote.length) return;
    const text = normalizeInline(quote.join(' '));
    quote = [];
    if (text) blocks.push({ type: 'quote', text });
  };
  const flushList = () => {
    if (!list) return;
    const current = list;
    list = null;
    if (current.items.length) blocks.push({ type: 'list', ordered: current.ordered, items: current.items });
  };
  const flushAll = () => {
    flushParagraph();
    flushQuote();
    flushList();
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();

    // Multi-line raw SVG block -> single image block (rasterised later)
    if (/^<svg[\s\S]*$/i.test(line) && !/<\/svg>/i.test(line)) {
      flushAll();
      const svgLines = [line];
      while (i + 1 < lines.length) {
        i++;
        svgLines.push(lines[i]);
        if (/<\/svg>/i.test(lines[i])) break;
      }
      const svg = svgLines.join('\n');
      const labelMatch = svg.match(/<text[^>]*>([^<]{4,60})<\/text>/i);
      blocks.push({ type: 'image', svg, alt: labelMatch ? labelMatch[1].trim() : '架构图' });
      continue;
    }
    if (/^<svg[\s\S]*<\/svg>$/i.test(line)) {
      flushAll();
      const labelMatch = line.match(/<text[^>]*>([^<]{4,60})<\/text>/i);
      blocks.push({ type: 'image', svg: line, alt: labelMatch ? labelMatch[1].trim() : '架构图' });
      continue;
    }

    if (!line) {
      flushAll();
      continue;
    }

    // Title (first H1 only)
    const h1 = line.match(/^#\s+(.*)$/);
    if (h1) {
      flushAll();
      if (!title) {
        title = h1[1].trim();
      } else {
        blocks.push({ type: 'heading', level: 2, text: normalizeInline(h1[1]) });
      }
      continue;
    }

    // H2 / H3 (X Articles only has one sub-heading level; H3 is normalised to H2)
    const h2 = line.match(/^#{2,6}\s+(.*)$/);
    if (h2) {
      flushAll();
      blocks.push({ type: 'heading', level: 2, text: normalizeInline(h2[1]) });
      continue;
    }

    // Divider
    if (/^[-*_]{3,}$/.test(line)) {
      flushAll();
      blocks.push({ type: 'divider' });
      continue;
    }

    // Markdown image
    const img = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (img) {
      flushAll();
      blocks.push({ type: 'image', src: img[2].trim(), alt: img[1].trim() || '配图' });
      continue;
    }

    // Blockquote (internal metadata is dropped, real citations survive)
    const bq = line.match(/^>\s?(.*)$/);
    if (bq) {
      const content = bq[1].trim();
      if (METADATA_LINE.test(content)) continue;
      if (!content) {
        flushQuote();
        continue;
      }
      flushParagraph();
      flushList();
      quote.push(content);
      continue;
    }

    // Lists
    const ul = line.match(/^[-*+]\s+(.*)$/);
    const ol = line.match(/^\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushParagraph();
      flushQuote();
      const ordered = Boolean(ol);
      const item = (ul ? ul[1] : ol![1]).trim();
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(item);
      continue;
    }

    // Continuation of an open list item / quote / paragraph
    if (list) {
      list.items[list.items.length - 1] = normalizeInline(`${list.items[list.items.length - 1]} ${line}`);
      continue;
    }
    if (quote.length) {
      quote.push(line);
      continue;
    }
    paragraph.push(line);
  }

  flushAll();
  return { title: title || '未命名长文', blocks };
}

/**
 * Compose the final document: LLM body + deterministic tweet citation up front
 * and a deterministic source list at the end. This is what guarantees the
 * article always has a "由头" and a "出处", independent of model mood.
 */
export function buildArticleDocument(markdown: string, source?: ArticleSource): ArticleDocument {
  const parsed = parseMarkdownToBlocks(markdown);
  const blocks: ArticleBlock[] = [];

  if (source && source.tweetText.trim()) {
    const tweetText = source.tweetText.replace(/\s+/g, ' ').trim();
    blocks.push({ type: 'quote', text: tweetText.length > 420 ? `${tweetText.slice(0, 417)}…` : tweetText });
    const when = source.publishedAt ? `${source.publishedAt} · ` : '';
    blocks.push({
      type: 'paragraph',
      text: `—— ${source.authorName}（@${source.authorHandle}），${when}原推文：${source.tweetUrl}`,
    });
    blocks.push({ type: 'divider' });
  }

  blocks.push(...parsed.blocks);

  if (source) {
    const items = [`原推文（@${source.authorHandle}）：${source.tweetUrl}`];
    for (const link of source.links || []) {
      if (!link.url || link.url === source.tweetUrl) continue;
      if (items.some((i) => i.includes(link.url))) continue;
      items.push(link.title ? `${link.title}：${link.url}` : link.url);
    }
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'heading', level: 2, text: '信源与延伸阅读' });
    blocks.push({ type: 'list', ordered: false, items });
  }

  return { title: parsed.title, blocks: normalizeBlocks(blocks) };
}

/** Collapses stray/leading/duplicate dividers so the layout stays clean. */
function normalizeBlocks(blocks: ArticleBlock[]): ArticleBlock[] {
  const out: ArticleBlock[] = [];
  for (const block of blocks) {
    if (block.type === 'divider') {
      const prev = out[out.length - 1];
      if (!prev || prev.type === 'divider') continue;
    }
    out.push(block);
  }
  while (out.length && out[out.length - 1].type === 'divider') out.pop();
  return out;
}

/** Structural gate: refuse to publish a document that lost its skeleton. */
export function validateDocument(doc: ArticleDocument, expectSource = false): string[] {
  const issues: string[] = [];
  const headings = doc.blocks.filter((b) => b.type === 'heading').length;
  const paragraphs = doc.blocks.filter((b) => b.type === 'paragraph') as Array<{ text: string }>;
  const chars = doc.blocks.reduce((n, b) => {
    if (b.type === 'paragraph' || b.type === 'heading' || b.type === 'quote') return n + b.text.length;
    if (b.type === 'list') return n + b.items.join('').length;
    return n;
  }, 0);

  if (!doc.title.trim()) issues.push('缺少文章标题');
  if (headings < 1) issues.push('缺少 H2 小标题（正文没有分节）');
  if (paragraphs.length < 4) issues.push(`正文段落过少（${paragraphs.length} 段）`);
  if (chars < 400) issues.push(`正文过短（${chars} 字）`);
  if (expectSource && !doc.blocks.some((b) => b.type === 'quote')) {
    issues.push('缺少推文引述块（信源缺失）');
  }
  return issues;
}

export function blocksToHtml(blocks: ArticleBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'heading':
        parts.push(`<h2>${inlineToHtml(block.text)}</h2>`);
        break;
      case 'paragraph':
        parts.push(`<p>${inlineToHtml(block.text)}</p>`);
        break;
      case 'quote':
        parts.push(`<blockquote>${inlineToHtml(block.text)}</blockquote>`);
        break;
      case 'list':
        parts.push(
          `<${block.ordered ? 'ol' : 'ul'}>${block.items
            .map((i) => `<li>${inlineToHtml(i)}</li>`)
            .join('')}</${block.ordered ? 'ol' : 'ul'}>`
        );
        break;
      default:
        break;
    }
  }
  return parts.join('');
}

export function blocksToPlain(blocks: ArticleBlock[]): string {
  return blocks
    .map((block) => {
      switch (block.type) {
        case 'heading':
        case 'paragraph':
          return inlineToPlain(block.text);
        case 'quote':
          return `“${inlineToPlain(block.text)}”`;
        case 'list':
          return block.items.map((i, idx) => `${block.ordered ? `${idx + 1}.` : '•'} ${inlineToPlain(i)}`).join('\n');
        default:
          return '';
      }
    })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Split the document into replay ops. Consecutive text blocks are pasted as one
 * HTML fragment (one Draft.js paste), images and dividers are separate ops.
 */
export function splitIntoOps(blocks: ArticleBlock[]): ArticleOp[] {
  const ops: ArticleOp[] = [];
  let pending: ArticleBlock[] = [];

  const flushPending = () => {
    if (!pending.length) return;
    ops.push({
      kind: 'html',
      html: blocksToHtml(pending),
      plain: blocksToPlain(pending),
      blocks: pending,
      blockCount: pending.length,
    });
    pending = [];
  };

  for (const block of blocks) {
    if (block.type === 'image') {
      flushPending();
      ops.push({ kind: 'image', block });
      continue;
    }
    if (block.type === 'divider') {
      flushPending();
      ops.push({ kind: 'divider' });
      continue;
    }
    pending.push(block);
  }
  flushPending();
  return ops;
}

/** Human readable block signature, used by the publisher's structure assertion. */
export function describeBlocks(blocks: ArticleBlock[]): string[] {
  return blocks.map((b) => {
    switch (b.type) {
      case 'heading':
        return `heading:${b.text.slice(0, 24)}`;
      case 'paragraph':
        return `paragraph:${b.text.slice(0, 24)}`;
      case 'quote':
        return `quote:${b.text.slice(0, 24)}`;
      case 'list':
        return `list(${b.items.length})`;
      case 'divider':
        return 'divider';
      case 'image':
        return `image:${b.alt.slice(0, 20)}`;
      default:
        return 'unknown';
    }
  });
}
