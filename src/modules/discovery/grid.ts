import fs from 'node:fs/promises';
import path from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import type { XHotCandidate } from './contracts.js';

export interface BuildXHotGridOptions {
  candidates: XHotCandidate[];
  maxGridDimension?: number;
  outputPath?: string;
}

export interface BuildXHotGridResult {
  buffer: Buffer;
  layout: {
    columns: number;
    rows: number;
    cellWidth: number;
    cellHeight: number;
    totalWidth: number;
    totalHeight: number;
  };
}

function xmlEscape(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Builds an NxN grid of candidate screenshots, adds clear numbering badges (#1, #2...),
 * applies sharpening, and outputs a high-contrast image for Vision-Language model inspection.
 */
export async function buildXHotGrid(
  options: BuildXHotGridOptions
): Promise<BuildXHotGridResult> {
  const { candidates, outputPath } = options;

  if (candidates.length === 0) {
    throw new Error('Cannot build grid with 0 candidates');
  }

  const count = candidates.length;
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / columns));

  // Optimal canvas dimension: 2400 for dense grids, balancing legibility and compact size
  const gridDimension = options.maxGridDimension ?? (count > 9 ? 2400 : 2000);
  const cellWidth = Math.floor((gridDimension - (columns + 1) * 8) / columns);
  // 4:3 vertical-friendly ratio for tweets (avoids squashing or aggressively cropping vertical cards)
  const cellHeight = Math.floor(cellWidth * (3 / 4));
  const gap = 8;

  const totalWidth = columns * cellWidth + (columns + 1) * gap;
  const totalHeight = rows * cellHeight + (rows + 1) * gap;

  const overlays: OverlayOptions[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const row = Math.floor(i / columns);
    const col = i % columns;
    const left = col * cellWidth + (col + 1) * gap;
    const top = row * cellHeight + (row + 1) * gap;

    let thumbBuffer = candidate.thumbnailBuffer;
    if (!thumbBuffer && candidate.screenshotPath) {
      try {
        thumbBuffer = await fs.readFile(candidate.screenshotPath);
      } catch {}
    }

    if (!thumbBuffer) {
      // Fallback blank card with author and text
      const cleanText = xmlEscape(candidate.text.slice(0, 140));
      const author = xmlEscape(candidate.authorName || candidate.authorHandle || `Candidate #${i + 1}`);
      const svg = `
        <svg width="${cellWidth}" height="${cellHeight}" xmlns="http://www.w3.org/2000/svg">
          <rect width="100%" height="100%" fill="#18181b" rx="8" />
          <text x="20" y="45" font-family="sans-serif" font-weight="bold" font-size="20" fill="#38bdf8">${author}</text>
          <foreignObject x="20" y="60" width="${cellWidth - 40}" height="${cellHeight - 80}">
            <p xmlns="http://www.w3.org/1999/xhtml" style="color: #f4f4f5; font-family: sans-serif; font-size: 15px; line-height: 1.4; word-break: break-word;">${cleanText}</p>
          </foreignObject>
        </svg>
      `;
      thumbBuffer = Buffer.from(svg);
    }

    const resizedThumb = await sharp(thumbBuffer)
      .resize(cellWidth, cellHeight, {
        fit: 'contain',
        background: { r: 24, g: 24, b: 27, alpha: 1 },
        position: 'center',
        kernel: 'lanczos3',
      })
      .toBuffer();

    overlays.push({
      input: resizedThumb,
      left,
      top,
    });

    // Badge styling: high-contrast dark badge with neon cyan text
    const badgeNumber = `#${i + 1}`;
    const badgeSvg = `
      <svg width="68" height="34" xmlns="http://www.w3.org/2000/svg">
        <rect x="0" y="0" width="68" height="34" rx="6" fill="#000000" fill-opacity="0.85" stroke="#38bdf8" stroke-width="2"/>
        <text x="34" y="24" font-family="Arial, Helvetica, sans-serif" font-size="20" font-weight="bold" fill="#38bdf8" text-anchor="middle">${badgeNumber}</text>
      </svg>
    `;

    overlays.push({
      input: Buffer.from(badgeSvg),
      left: left + 10,
      top: top + 10,
    });
  }

  // Create base canvas with dark graphite background
  const baseCanvas = sharp({
    create: {
      width: totalWidth,
      height: totalHeight,
      channels: 4,
      background: { r: 15, g: 20, b: 25, alpha: 1 },
    },
  });

  // Color quantization: 256-color palette PNG reduces byte size by >70% while keeping text crisp
  const buffer = await baseCanvas
    .composite(overlays)
    .sharpen({ sigma: 1.0, m1: 1.2, m2: 0.5 })
    .png({ palette: true, colours: 256, dither: 0 })
    .toBuffer();

  if (outputPath) {
    await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
    await fs.writeFile(outputPath, buffer);
  }

  return {
    buffer,
    layout: {
      columns,
      rows,
      cellWidth,
      cellHeight,
      totalWidth,
      totalHeight,
    },
  };
}
