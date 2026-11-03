import fs from 'node:fs/promises';
import path from 'node:path';
import { marked } from 'marked';

export async function convertMarkdownToStandaloneHtml(
  markdown: string,
  baseDir: string
): Promise<string> {
  // 1. Find all markdown image references ![alt](path) and embed as base64
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let processedMarkdown = markdown;

  const matches = Array.from(markdown.matchAll(imageRegex));
  for (const match of matches) {
    const fullMatch = match[0];
    const altText = match[1];
    const imagePath = match[2];

    if (!imagePath.startsWith('http://') && !imagePath.startsWith('https://') && !imagePath.startsWith('data:')) {
      const resolvedPath = path.isAbsolute(imagePath)
        ? imagePath
        : path.resolve(baseDir, imagePath);

      try {
        const fileBuf = await fs.readFile(resolvedPath);
        const ext = path.extname(resolvedPath).toLowerCase();
        let mime = 'image/png';
        if (ext === '.jpg' || ext === '.jpeg') mime = 'image/jpeg';
        else if (ext === '.svg') mime = 'image/svg+xml';
        else if (ext === '.webp') mime = 'image/webp';

        const base64Data = `data:${mime};base64,${fileBuf.toString('base64')}`;
        processedMarkdown = processedMarkdown.replace(fullMatch, `![${altText}](${base64Data})`);
      } catch (err) {
        console.warn(`[html-exporter] Could not read local image ${resolvedPath}:`, err);
        // Remove dead local image syntax to avoid broken image icon on phone
        processedMarkdown = processedMarkdown.replace(fullMatch, '');
      }
    }
  }

  // 2. Parse Markdown to HTML
  const bodyHtml = await marked.parse(processedMarkdown);
  const docTitle = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || 'Technical Architecture & Engineering Insights';

  // 3. Mobile-first responsive HTML layout
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, minimum-scale=1.0">
  <title>${docTitle}</title>
  <style>
    :root {
      --bg-color: #F8FAFC;
      --card-bg: #FFFFFF;
      --text-main: #334155;
      --text-title: #0F172A;
      --text-muted: #64748B;
      --accent: #0071E3;
      --accent-subtle: #EEF2FF;
      --accent-border: #C7D2FE;
      --border-color: #E2E8F0;
      --quote-bg: #F1F5F9;
      --code-bg: #F8FAFC;
      --code-border: #E2E8F0;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      -webkit-tap-highlight-color: transparent;
    }
    body {
      background-color: var(--bg-color);
      color: var(--text-main);
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", sans-serif;
      line-height: 1.72;
      padding: 32px 16px;
      word-wrap: break-word;
      overflow-wrap: break-word;
      -webkit-font-smoothing: antialiased;
    }
    .container {
      max-width: 820px;
      margin: 0 auto;
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 20px;
      padding: 40px 36px;
      box-shadow: 0 10px 30px -4px rgba(15, 23, 42, 0.05), 0 2px 8px -2px rgba(15, 23, 42, 0.03);
    }
    h1, h2, h3, h4 {
      color: var(--text-title);
      margin-top: 1.6em;
      margin-bottom: 0.6em;
      line-height: 1.32;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    h1 {
      font-size: 1.95rem;
      border-bottom: 1px solid var(--border-color);
      padding-bottom: 16px;
      margin-top: 0;
      color: #0F172A;
      font-weight: 800;
    }
    h2 {
      font-size: 1.4rem;
      border-left: 4px solid var(--accent);
      padding-left: 12px;
    }
    h3 {
      font-size: 1.18rem;
      color: #1E293B;
    }
    p {
      margin-bottom: 1.15em;
      font-size: 1.02rem;
      color: var(--text-main);
    }
    ul, ol {
      margin-left: 22px;
      margin-bottom: 1.15em;
    }
    li {
      margin-bottom: 0.45em;
      font-size: 1rem;
      color: var(--text-main);
    }
    a {
      color: var(--accent);
      text-decoration: none;
      border-bottom: 1px solid rgba(0, 113, 227, 0.3);
      word-break: break-all;
      transition: border-bottom-color 0.2s ease;
    }
    a:hover {
      border-bottom-color: var(--accent);
    }
    blockquote {
      background: var(--quote-bg);
      border-left: 4px solid var(--accent);
      padding: 14px 18px;
      border-radius: 0 12px 12px 0;
      margin: 20px 0;
      color: #475569;
      font-size: 0.96rem;
    }
    img {
      max-width: 100%;
      height: auto;
      border-radius: 14px;
      margin: 20px 0;
      border: 1px solid var(--border-color);
      display: block;
      box-shadow: 0 4px 16px -2px rgba(15, 23, 42, 0.05);
    }
    svg {
      max-width: 100%;
      height: auto;
      margin: 20px 0;
      display: block;
      border-radius: 14px;
      border: 1px solid var(--border-color);
      box-shadow: 0 4px 16px -2px rgba(15, 23, 42, 0.05);
    }
    pre {
      background: var(--code-bg);
      border: 1px solid var(--code-border);
      border-radius: 10px;
      padding: 16px;
      overflow-x: auto;
      margin: 18px 0;
      font-size: 0.9rem;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      font-size: 0.9em;
      background: #F1F5F9;
      padding: 2px 6px;
      border-radius: 6px;
      color: #0F172A;
      border: 1px solid #E2E8F0;
    }
    pre code {
      background: none;
      border: none;
      padding: 0;
    }
    hr {
      border: none;
      height: 1px;
      background: var(--border-color);
      margin: 32px 0;
    }
    .footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid var(--border-color);
      text-align: center;
      color: var(--text-muted);
      font-size: 0.85rem;
    }

    /* Mobile Responsive Overrides */
    @media (max-width: 640px) {
      body {
        padding: 12px 8px;
      }
      .container {
        padding: 20px 16px;
        border-radius: 14px;
      }
      h1 {
        font-size: 1.45rem;
        line-height: 1.3;
        padding-bottom: 12px;
      }
      h2 {
        font-size: 1.22rem;
        padding-left: 10px;
      }
      h3 {
        font-size: 1.05rem;
      }
      p, li {
        font-size: 0.95rem;
        line-height: 1.65;
      }
      blockquote {
        padding: 12px 14px;
        font-size: 0.9rem;
        margin: 14px 0;
      }
      pre {
        padding: 12px;
        font-size: 0.84rem;
      }
      .footer {
        font-size: 0.8rem;
        margin-top: 28px;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    ${bodyHtml}
    <div class="footer">
      Generated by AIGC-pipeline (xdev) • Powered by Webdriver BiDi & Firefox ESR
    </div>
  </div>
</body>
</html>`;
}
