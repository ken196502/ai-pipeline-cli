/**
 * Minimal, deterministic Markdown → HTML converter for pipeline reports.
 *
 * Supports the exact subset used by the final report generators:
 *   - ATX headings (#..######), horizontal rules (--- / *** / ___)
 *   - fenced code blocks (```lang), indented content preserved verbatim
 *   - pipe tables (with optional :---: alignment row), `\|` escapes in cells
 *   - unordered lists with 2-space indentation nesting
 *   - blockquotes (consecutive `>` lines)
 *   - inline: `code`, **bold**, *italic*, [links](url), ![images](src)
 *   - paragraphs; single newlines inside a paragraph render as <br/>
 *
 * Security: all text nodes are HTML-escaped before inline formatting, link
 * hrefs are scheme-restricted (http/https/mailto/data), and images pointing
 * at local files are embedded as base64 data URIs (self-contained output).
 */
import fs from 'node:fs';
import path from 'node:path';

export interface MarkdownToHtmlOptions {
  /** <title> and header fallback for the generated document. */
  title?: string;
  /**
   * Directory used to resolve relative image paths. When set (and the file
   * exists and is within size budget), images are inlined as data URIs.
   */
  baseDir?: string;
  /** Images larger than this are NOT embedded (original src kept). Default 2 MiB. */
  maxImageEmbedBytes?: number;
}

const DEFAULT_MAX_IMAGE_EMBED_BYTES = 2 * 1024 * 1024;

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isSafeHref(href: string): boolean {
  return /^(https?:|mailto:|data:)/i.test(href);
}

/** Splits a pipe-table row into trimmed cells, honoring `\|` escapes. */
function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '\\' && trimmed[i + 1] === '|') {
      current += '|';
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

function isTableSeparator(line: string): boolean {
  const t = line.trim();
  if (!t.includes('-')) return false;
  return /^[\s|:-]+$/.test(t) && t.replace(/[^-]/g, '').length >= 1;
}

interface InlineContext {
  baseDir?: string;
  maxImageEmbedBytes: number;
}

/**
 * Applies inline formatting to an already block-level HTML-escaped segment.
 * `escapeFirst` controls whether raw escaping is applied (text nodes) —
 * table cells and headings pass their raw text through the same pipeline.
 */
function renderInline(raw: string, ctx: InlineContext): string {
  // 1. Extract inline code spans into placeholders so formatting inside them
  //    is never processed.
  const codeSpans: string[] = [];
  let text = raw.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000CODE${codeSpans.length - 1}\u0000`;
  });

  // 2. Escape everything else.
  text = escapeHtml(text);

  // 3. Images (before links so `![` isn't swallowed by the link rule).
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, src: string) => {
    const resolvedSrc = resolveImageSource(src, ctx);
    return `<img src="${escapeHtml(resolvedSrc)}" alt="${alt}"/>`;
  });

  // 4. Links with scheme allow-list.
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) => {
    const safe = isSafeHref(href) ? href : '#';
    return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  // 5. Bold then italic.
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  // 6. Restore code placeholders.
  text = text.replace(/\u0000CODE(\d+)\u0000/g, (_m, idx: string) => codeSpans[Number(idx)] ?? _m);

  return text;
}

function resolveImageSource(src: string, ctx: InlineContext): string {
  if (/^(https?:|data:)/i.test(src)) return src;
  if (!ctx.baseDir) return src;
  const resolved = path.resolve(ctx.baseDir, src);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return src;
  }
  if (!stat.isFile() || stat.size > ctx.maxImageEmbedBytes) return src;
  const mime = IMAGE_MIME[path.extname(resolved).toLowerCase()];
  if (!mime) return src;
  const b64 = fs.readFileSync(resolved).toString('base64');
  return `data:${mime};base64,${b64}`;
}

function renderTable(lines: string[], ctx: InlineContext): string {
  const header = splitTableRow(lines[0]);
  const aligns = splitTableRow(lines[1]).map((cell) => {
    const c = cell.trim();
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return '';
  });
  const bodyRows = lines.slice(2).map((l) => splitTableRow(l));

  const th = header
    .map((cell, i) => {
      const align = aligns[i] ? ` style="text-align:${aligns[i]}"` : '';
      return `<th${align}>${renderInline(cell, ctx)}</th>`;
    })
    .join('');
  const trs = bodyRows
    .map((row) => {
      const tds = header
        .map((_, i) => {
          const align = aligns[i] ? ` style="text-align:${aligns[i]}"` : '';
          return `<td${align}>${renderInline(row[i] ?? '', ctx)}</td>`;
        })
        .join('');
      return `      <tr>${tds}</tr>`;
    })
    .join('\n');

  return `<table>
    <thead>
      <tr>${th}</tr>
    </thead>
    <tbody>
${trs}
    </tbody>
  </table>`;
}

interface ListItem {
  indent: number;
  text: string;
}

function renderList(items: ListItem[], ctx: InlineContext, startIdx: number, baseIndent: number): string {
  // Group items by indentation level into nested <ul> structures.
  let html = '<ul>\n';
  let i = startIdx;
  while (i < items.length) {
    const item = items[i];
    if (item.indent < baseIndent) break;
    if (item.indent > baseIndent) {
      // Nested list: attach to the previous <li>.
      const nested = renderList(items, ctx, i, item.indent);
      html = html.replace(/<\/li>\n$/, `\n${nested}\n    </li>\n`);
      // Advance past the nested items consumed by the recursive call.
      while (i < items.length && items[i].indent >= item.indent) i++;
      continue;
    }
    html += `    <li>${renderInline(item.text, ctx)}</li>\n`;
    i++;
  }
  html += '  </ul>';
  return html;
}

function documentShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg: #0d1117;
      --panel: #161b22;
      --border: #30363d;
      --text: #e6edf3;
      --muted: #8b949e;
      --accent: #58a6ff;
      --code-bg: #1c2128;
    }
    * { box-sizing: border-box; }
    html { -webkit-text-size-adjust: 100%; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      line-height: 1.6;
      overflow-wrap: break-word;
    }
    .container { max-width: 1400px; margin: 0 auto; padding: 40px 48px 80px; }
    h1 { border-bottom: 2px solid var(--border); padding-bottom: 12px; font-size: 1.7rem; }
    h2 { border-bottom: 1px solid var(--border); padding-bottom: 8px; margin-top: 40px; font-size: 1.35rem; }
    h3 { margin-top: 28px; font-size: 1.1rem; color: var(--accent); }
    h4 { margin-top: 22px; font-size: 1rem; color: var(--muted); }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    code {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 1px 6px;
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
      font-size: 0.88em;
    }
    pre {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px 16px;
      overflow-x: auto;
    }
    pre code { background: none; border: none; padding: 0; font-size: 0.85rem; }
    .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 16px 0; }
    table { border-collapse: collapse; width: 100%; font-size: 0.9rem; table-layout: auto; }
    th, td { border: 1px solid var(--border); padding: 8px 12px; text-align: left; vertical-align: top; }
    th:first-child, td:first-child {
      max-width: 20%;
      width: 20%;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    th { background: var(--panel); }
    tbody tr:nth-child(even) { background: rgba(255, 255, 255, 0.02); }
    blockquote {
      margin: 14px 0;
      padding: 10px 16px;
      border-left: 3px solid var(--accent);
      background: var(--panel);
      border-radius: 0 8px 8px 0;
      color: var(--muted);
    }
    ul { padding-left: 24px; }
    li { margin: 4px 0; }
    hr { border: none; border-top: 1px solid var(--border); margin: 32px 0; }
    img { max-width: 100%; border: 1px solid var(--border); border-radius: 8px; margin: 12px 0; }
    em { color: var(--muted); }
    @media (max-width: 720px) {
      .container { padding: 20px 14px 48px; }
      h1 { font-size: 1.4rem; }
      pre { white-space: pre-wrap; overflow-x: hidden; }
      /* Real tables, horizontally scrollable; first column frozen; column widths capped */
      .table-wrap table { min-width: 620px; }
      .table-wrap th, .table-wrap td { max-width: 300px; }
      .table-wrap thead th:first-child,
      .table-wrap tbody td:first-child {
        position: sticky;
        left: 0;
        background: var(--panel);
        z-index: 1;
        max-width: 20% !important;
        width: 20% !important;
        box-shadow: 2px 0 6px rgba(0, 0, 0, 0.35);
      }
      .table-wrap thead th:first-child { z-index: 2; }
    }
  </style>
</head>
<body>
  <main class="container">
${body}
  </main>
</body>
</html>
`;
}

/**
 * Converts a Markdown document (restricted subset, see file header) into a
 * self-contained, styled HTML document string.
 */
export function markdownToHtml(markdown: string, options: MarkdownToHtmlOptions = {}): string {
  const ctx: InlineContext = {
    baseDir: options.baseDir,
    maxImageEmbedBytes: options.maxImageEmbedBytes ?? DEFAULT_MAX_IMAGE_EMBED_BYTES,
  };
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Blank line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code block
    const fenceMatch = line.match(/^ {0,3}```(\S*)\s*$/);
    if (fenceMatch) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^ {0,3}```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // consume closing fence
      out.push(`  <pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // ATX heading
    const headingMatch = line.match(/^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      out.push(`  <h${level}>${renderInline(headingMatch[2], ctx)}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('  <hr/>');
      i++;
      continue;
    }

    // Table (header row + separator row)
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const tableLines = [line, lines[i + 1]];
      i += 2; // header + separator consumed
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        tableLines.push(lines[i]);
        i++;
      }
      out.push(
        '  <div class="table-wrap">\n' +
          '  ' +
          renderTable(tableLines, ctx).replace(/\n/g, '\n  ') +
          '\n  </div>'
      );
      continue;
    }

    // Blockquote
    if (/^ {0,3}>/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^ {0,3}>\s?/, ''));
        i++;
      }
      const paragraphs = quoteLines.map((q) => `    <p>${renderInline(q, ctx)}</p>`).join('\n');
      out.push(`  <blockquote>\n${paragraphs}\n  </blockquote>`);
      continue;
    }

    // Unordered list (nested by 2-space indentation)
    const listMatch = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (listMatch) {
      const items: ListItem[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)[-*]\s+(.*)$/);
        if (!m) break;
        items.push({ indent: m[1].replace(/\t/g, '  ').length, text: m[2] });
        i++;
      }
      out.push('  ' + renderList(items, ctx, 0, items[0].indent).replace(/\n/g, '\n  '));
      continue;
    }

    // Paragraph: consume until blank line or another block start.
    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim()) {
      const l = lines[i];
      if (paraLines.length > 0) {
        if (/^ {0,3}```/.test(l) || /^(#{1,6})\s/.test(l) || /^ {0,3}>/.test(l) || /^(\s*)[-*]\s+/.test(l) || /^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) {
          break;
        }
        if (l.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) break;
      }
      paraLines.push(l);
      i++;
    }
    const joined = paraLines.map((l) => renderInline(l.trim(), ctx)).join('<br/>\n');
    out.push(`  <p>${joined}</p>`);
  }

  const body = out.join('\n');
  const title = options.title ?? 'Pipeline Report';
  return documentShell(title, body);
}
