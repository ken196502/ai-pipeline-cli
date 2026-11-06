/**
 * X Articles publisher.
 *
 * Responsibilities (and nothing else — no regex "cleaning" of the article body):
 *   1. markdown -> structured blocks (article-document.ts)
 *   2. deterministic tweet citation up front + source list at the end
 *   3. materialise images (SVG -> PNG, downscale) and insert them INLINE
 *   4. draft mode: fill the editor, verify the structure, screenshot, do NOT publish
 *   5. publish mode: same, then Publish + live verification
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Browser } from 'webdriverio';
import pc from 'picocolors';

import {
  buildArticleDocument,
  splitIntoOps,
  validateDocument,
  describeBlocks,
  type ArticleSource,
} from './article-document.js';
import { prepareArticleAssets, type PreparedOp } from './article-assets.js';
import {
  openNewArticleDraft,
  setArticleTitle,
  uploadCoverImage,
  pasteHtmlVerified,
  insertInlineImage,
  insertDivider,
  waitForAutosave,
  readStructure,
  captureEditorScreenshots,
  publishDraft,
  type EditorStructure,
} from './x-article-editor.js';

export interface PublishArticleOptions {
  title: string;
  markdownContent: string;
  caption?: string;
  coverImagePath?: string;
  /** Tweet + links the article is based on; drives the citation blocks. */
  source?: ArticleSource;
  /** 'draft' fills the editor and stops (no Publish click). */
  mode?: 'draft' | 'publish';
  /** Base dir for relative image paths inside the markdown. */
  assetBaseDir?: string;
  /** Where generated assets/screenshots are written. */
  artifactDir?: string;
  screenshots?: number;
}

export interface PublishArticleResult {
  success: boolean;
  mode: 'draft' | 'publish';
  editUrl?: string;
  articleUrl?: string;
  tweetUrl?: string;
  screenshots: string[];
  assetFiles: string[];
  expected?: { headings: number; quotes: number; images: number; dividers: number };
  actual?: { headings: number; quotes: number; images: number; dividers: number; paragraphs: number; chars: number; words: number | null };
  error?: string;
}

function summarize(structure: EditorStructure) {
  return {
    headings: structure.counts.heading,
    quotes: structure.counts.quote,
    images: structure.counts.image,
    dividers: structure.counts.divider,
    paragraphs: structure.counts.paragraph,
    chars: structure.chars,
    words: structure.wordCount,
  };
}

/** Published-tab duplicate guard: never post the same title twice. */
async function findPublishedDuplicate(browser: Browser, title: string): Promise<string | null> {
  await browser.url('https://x.com/compose/articles');
  await browser.pause(4000);
  return browser.execute((target: string) => {
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    const published = tabs.find((t) => /published/i.test(t.textContent || '')) as HTMLElement | undefined;
    published?.click();
    const articles = Array.from(document.querySelectorAll('[data-testid="cellInnerDiv"], [role="article"]'));
    for (const art of articles) {
      const text = (art as HTMLElement).innerText || '';
      if (text.includes(target.slice(0, 20))) {
        const link = art.querySelector('a') as HTMLAnchorElement | null;
        return link ? link.href : 'ALREADY_EXISTS';
      }
    }
    return null;
  }, title);
}

export async function publishArticleToX(
  browser: Browser,
  options: PublishArticleOptions
): Promise<PublishArticleResult> {
  const mode = options.mode || 'publish';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const artifactDir = path.resolve(options.artifactDir || 'artifacts/xdev');
  const assetDir = path.join(artifactDir, `x-article-assets-${timestamp}`);
  const shotDir = path.join(artifactDir, `x-article-shots-${timestamp}`);
  const screenshots: string[] = [];
  const assetFiles: string[] = [];

  console.log(pc.cyan(`\n✍ [publish-to-x] mode=${mode} · "${options.title}"`));

  // 1. Document model (structure preserved, citation injected)
  const doc = buildArticleDocument(options.markdownContent, options.source);
  const title = (doc.title || options.title).slice(0, 100);
  const issues = validateDocument(doc, Boolean(options.source));
  if (issues.length) {
    const msg = `[publish-to-x] 文档结构不合格，拒绝发布: ${issues.join('；')}`;
    console.error(pc.red(`💥 ${msg}`));
    return { success: false, mode, screenshots, assetFiles, error: msg };
  }
  console.log(
    pc.dim(`  • ${doc.blocks.length} blocks: ${describeBlocks(doc.blocks).slice(0, 6).join(' | ')}${doc.blocks.length > 6 ? ' …' : ''}`)
  );

  // 2. Assets (SVG -> PNG, resize). Inside the try: a diagram that cannot be
  // rasterised is a publish-stage failure and must be reported as such (with
  // whatever assets were produced), not thrown out of the function.
  const opsRaw = splitIntoOps(doc.blocks);
  let ops: PreparedOp[] = [];

  const expected = {
    headings: doc.blocks.filter((b) => b.type === 'heading').length,
    quotes: doc.blocks.filter((b) => b.type === 'quote').length,
    images: doc.blocks.filter((b) => b.type === 'image').length,
    dividers: doc.blocks.filter((b) => b.type === 'divider').length,
  };

  try {
    const prepared = await prepareArticleAssets(opsRaw, {
      baseDir: options.assetBaseDir || artifactDir,
      outDir: assetDir,
      timestamp,
    });
    ops = prepared.ops;
    assetFiles.push(...prepared.files);
    // 3. Duplicate guard (publish mode only)
    if (mode === 'publish') {
      const dup = await findPublishedDuplicate(browser, title);
      if (dup) {
        console.log(pc.yellow(`  ⚠ 已存在同名文章，跳过重复发布: ${dup}`));
        return {
          success: true,
          mode,
          articleUrl: dup !== 'ALREADY_EXISTS' ? dup : undefined,
          screenshots,
          assetFiles,
          expected,
        };
      }
    }

    // 4. New draft
    const editUrl = await openNewArticleDraft(browser);
    console.log(pc.cyan(`  • 草稿编辑器: ${editUrl}`));

    await setArticleTitle(browser, title);

    if (options.coverImagePath) {
      const coverPath = path.isAbsolute(options.coverImagePath)
        ? options.coverImagePath
        : path.resolve(options.assetBaseDir || artifactDir, options.coverImagePath);
      const stat = await fs.stat(coverPath).catch(() => null);
      if (!stat?.isFile()) throw new Error(`[publish-to-x] cover image not found: ${coverPath}`);
      console.log(pc.cyan(`  • 上传封面: ${path.basename(coverPath)}`));
      await uploadCoverImage(browser, coverPath);
    }

    // 5. Body: replay ops (html segments, inline images, dividers)
    let htmlOps = 0;
    let imageOps = 0;
    for (const op of ops as PreparedOp[]) {
      if (op.kind === 'html') {
        htmlOps += 1;
        await pasteHtmlVerified(browser, op.html, op.plain, op.blockCount);
      } else if (op.kind === 'image') {
        imageOps += 1;
        console.log(pc.cyan(`  • 插入内联配图 ${imageOps}/${expected.images}: ${path.basename(op.filePath)}`));
        await insertInlineImage(browser, op.filePath);
      } else {
        await insertDivider(browser);
      }
    }
    console.log(pc.green(`  ✔ 正文写入完成（${htmlOps} 段 HTML、${imageOps} 张内联图）`));

    await waitForAutosave(browser);

    // 6. Structure verification
    const structure = await readStructure(browser);
    const actual = summarize(structure);
    console.log(
      pc.cyan(
        `  • 编辑器实测: ${actual.headings} 小标题 / ${actual.quotes} 引用 / ${actual.images} 配图 / ${actual.paragraphs} 段落 / ${actual.chars} 字符（X 词数显示 ${actual.words ?? '?'}）`
      )
    );

    const mismatches: string[] = [];
    if (actual.headings < expected.headings) mismatches.push(`小标题 ${actual.headings}/${expected.headings}`);
    if (actual.quotes < expected.quotes) mismatches.push(`引用块 ${actual.quotes}/${expected.quotes}`);
    if (actual.images < expected.images) mismatches.push(`配图 ${actual.images}/${expected.images}`);
    if (actual.dividers < expected.dividers) mismatches.push(`分隔线 ${actual.dividers}/${expected.dividers}`);
    if (!actual.chars || actual.chars < 800) mismatches.push(`正文字符数过少 (${actual.chars ?? 0})`);

    // 7. Screenshots (always, draft or publish)
    await browser.setWindowSize(1280, 1400);
    screenshots.push(...(await captureEditorScreenshots(browser, shotDir, 'draft', options.screenshots ?? 3)));
    console.log(pc.green(`  ✔ 已截图 ${screenshots.length} 张 -> ${shotDir}`));

    if (mismatches.length) {
      const msg = `[publish-to-x] 编辑器结构校验失败: ${mismatches.join('；')}`;
      console.error(pc.red(`💥 ${msg}`));
      console.error(pc.dim(structure.blocks.map((b) => `${b.type}:${b.text.slice(0, 18)}`).join('\n')));
      console.error(pc.dim(structure.blocks.map((b) => `${b.type}:${b.text.slice(0, 18)}`).join('\n')));
      return {
        success: false,
        mode,
        editUrl,
        screenshots,
        assetFiles,
        expected,
        actual,
        error: msg,
      };
    }

    if (mode === 'draft') {
      console.log(pc.green(`  ✔ 草稿已保存（未发布）: ${editUrl}`));
      return { success: true, mode, editUrl, screenshots, assetFiles, expected, actual };
    }

    // 8. Publish + live verification
    const caption =
      options.caption || `${title}\n\n#AI #MultiAgent #Tech`;
    const finalUrl = await publishDraft(browser, caption);
    console.log(pc.cyan(`  • 发布后 URL: ${finalUrl}`));

    let articleUrl: string | undefined;
    const statusId = finalUrl.match(/status\/(\d+)/);
    if (statusId) {
      articleUrl = `https://x.com/etrobot/article/${statusId[1]}`;
      await browser.url(articleUrl);
      await browser.pause(6000);
      const verification = await browser.execute(() => {
        const bodyText = document.body.innerText || '';
        return { length: bodyText.length, images: document.querySelectorAll('article img').length };
      });
      console.log(
        pc.green(`  ✔ 线上校验: 正文 ${verification.length} 字符 / ${verification.images} 张图`)
      );
      if (verification.length < 500) {
        throw new Error(`[publish-to-x] 线上正文过短（${verification.length} 字符），发布结果异常`);
      }
    }

    return {
      success: true,
      mode,
      editUrl,
      articleUrl: articleUrl || finalUrl,
      tweetUrl: finalUrl,
      screenshots,
      assetFiles,
      expected,
      actual,
    };
  } catch (err: any) {
    const message = err?.message || String(err);
    console.error(pc.red(`💥 [publish-to-x] 失败: ${message}`));
    return { success: false, mode, screenshots, assetFiles, expected, error: message };
  }
}
