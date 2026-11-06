/**
 * Turns the document's image blocks into real raster files that X accepts.
 *
 * X Articles only accepts image/jpeg|png|webp, so the vector architecture
 * diagrams must be rasterised, and any oversized AI image is downscaled before
 * upload (a 1.3 MB PNG upload over the proxy is slow enough to look like a hang).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import pc from 'picocolors';

import { assertSvgHasContent, assertWellFormedSvg, sanitizeSvg } from '../../libs/svg/index.js';
import type { ArticleOp } from './article-document.js';

export type PreparedOp =
  | { kind: 'html'; html: string; plain: string; blockCount: number }
  | { kind: 'image'; filePath: string; alt: string }
  | { kind: 'divider' };

const MAX_WIDTH = 1600;

function svgToRasterableBuffer(svg: string): { buffer: Buffer; width: number; height: number } {
  const viewBox = svg.match(/viewBox=["']([\d.\s-]+)["']/i);
  let width = 1200;
  let height = 700;
  if (viewBox) {
    const parts = viewBox[1].trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      width = Math.round(parts[2]);
      height = Math.round(parts[3]);
    }
  }
  // librsvg ignores width="100%" height="auto": pin explicit pixel dimensions.
  const fixed = svg
    .replace(/(<svg[^>]*?)\swidth=["'][^"']*["']/i, '$1')
    .replace(/(<svg[^>]*?)\sheight=["'][^"']*["']/i, '$1')
    .replace(/<svg/i, `<svg width="${width}" height="${height}"`);
  return { buffer: Buffer.from(fixed, 'utf-8'), width, height };
}

async function rasterizeSvg(svg: string, outPath: string, dumpDir: string): Promise<void> {
  const { svg: sanitized, repairs } = sanitizeSvg(svg);
  if (repairs.length > 0) {
    console.warn(
      pc.yellow(
        `    ⚠ SVG 自动修复 ${repairs.length} 处 — ${repairs.map((r) => `${r.kind}(${r.detail})`).join(' | ')}`
      )
    );
  }

  // librsvg is the renderer, but it reports a malformed document as an opaque
  // "corrupt header"; validating first gives a line number and a saved copy.
  try {
    assertWellFormedSvg(sanitized, 'article-svg');
    assertSvgHasContent(sanitized, 'article-svg');
  } catch (err) {
    const saved = await dumpBrokenSvg(sanitized, dumpDir, 'SVG 校验失败');
    throw new Error(`${(err as Error).message} — raw SVG saved to ${saved}`);
  }

  const { buffer, width } = svgToRasterableBuffer(sanitized);
  const scale = Math.min(2, MAX_WIDTH / Math.max(1, width));
  try {
    await sharp(buffer, { density: Math.max(96, Math.round(72 * scale)) })
      .resize({ width: Math.min(MAX_WIDTH, Math.round(width * scale)), withoutEnlargement: false })
      .png()
      .toFile(outPath);
  } catch (err) {
    const saved = await dumpBrokenSvg(sanitized, dumpDir, `librsvg: ${(err as Error).message}`);
    throw new Error(
      `[article-assets] librsvg could not rasterise the diagram: ${(err as Error).message} — raw SVG saved to ${saved}`
    );
  }
}

/** Keeps the exact bytes that broke the renderer so the failure is reproducible. */
async function dumpBrokenSvg(svg: string, dumpDir: string, reason: string): Promise<string> {
  await fs.mkdir(dumpDir, { recursive: true });
  const file = path.join(dumpDir, `broken-svg-${Date.now()}.svg`);
  await fs.writeFile(file, svg, 'utf-8');
  console.error(pc.red(`    ✖ 无法栅格化 SVG (${reason})，原始内容已保存: ${file}`));
  return file;
}

async function normalizeRaster(filePath: string, outPath: string): Promise<void> {
  const meta = await sharp(filePath).metadata();
  const width = meta.width || MAX_WIDTH;
  const pipeline = sharp(filePath);
  if (width > MAX_WIDTH) pipeline.resize({ width: MAX_WIDTH });
  const ext = path.extname(outPath).toLowerCase();
  if (ext === '.png') await pipeline.png().toFile(outPath);
  else await pipeline.jpeg({ quality: 88 }).toFile(outPath);
}

/**
 * Rewrites image ops into concrete files inside `outDir`.
 * Returns the ops plus the files that were produced (for logging/artifacts).
 */
export async function prepareArticleAssets(
  ops: ArticleOp[],
  options: { baseDir: string; outDir: string; timestamp: string }
): Promise<{ ops: PreparedOp[]; files: string[] }> {
  await fs.mkdir(options.outDir, { recursive: true });
  const files: string[] = [];
  const prepared: PreparedOp[] = [];
  let index = 0;

  for (const op of ops) {
    if (op.kind === 'html') {
      prepared.push({ kind: 'html', html: op.html, plain: op.plain, blockCount: op.blockCount });
      continue;
    }
    if (op.kind === 'divider') {
      prepared.push({ kind: 'divider' });
      continue;
    }

    index += 1;
    const block = op.block;
    const baseName = `inline-${String(index).padStart(2, '0')}-${options.timestamp}`;
    const outPath = path.join(options.outDir, `${baseName}.png`);

    if (block.svg) {
      await rasterizeSvg(block.svg, outPath, options.outDir);
      files.push(outPath);
      prepared.push({ kind: 'image', filePath: outPath, alt: block.alt });
      console.log(pc.dim(`    • 矢量图已栅格化: ${path.basename(outPath)} (${block.alt})`));
      continue;
    }

    if (!block.src) throw new Error('[article-assets] image block without src or svg');

    const srcPath = path.isAbsolute(block.src) ? block.src : path.resolve(options.baseDir, block.src);
    const stat = await fs.stat(srcPath).catch(() => null);
    if (!stat?.isFile()) {
      throw new Error(`[article-assets] image not found: ${srcPath} (markdown references "${block.src}")`);
    }
    const ext = path.extname(srcPath).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
      await normalizeRaster(srcPath, outPath);
    } else {
      await sharp(srcPath).png().toFile(outPath);
    }
    files.push(outPath);
    prepared.push({ kind: 'image', filePath: outPath, alt: block.alt });
    console.log(pc.dim(`    • 配图已准备: ${path.basename(outPath)} (${block.alt})`));
  }

  return { ops: prepared, files };
}
