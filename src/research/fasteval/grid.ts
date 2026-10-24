import fs from 'node:fs/promises';
import path from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import { toVisionPng } from '../media/frames.js';
import type { FastEvalCandidate } from './types.js';

export interface BuildNxNGridOptions {
  candidates: FastEvalCandidate[];
  maxGridDimension?: number;
  outputPath?: string;
}

export interface BuildNxNGridResult {
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
 * Builds an NxN grid of candidate cover thumbnails, adds clear numbering badges,
 * applies sharpening, and compresses with MozJPEG.
 */
export async function buildNxNCandidateGrid(
  options: BuildNxNGridOptions
): Promise<BuildNxNGridResult> {
  const { candidates, maxGridDimension = 2400, outputPath } = options;

  if (candidates.length === 0) {
    throw new Error('Cannot build candidate grid with 0 candidates');
  }

  // Calculate NxN dimensions: e.g. 4 -> 2x2, 9 -> 3x3
  const count = candidates.length;
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / columns));

  // Determine standard cell aspect ratio (16:9 for YouTube thumbnails)
  const cellWidth = Math.floor((maxGridDimension - (columns + 1) * 6) / columns);
  const cellHeight = Math.floor(cellWidth * (9 / 16));
  const gap = 6;

  const totalWidth = columns * cellWidth + (columns + 1) * gap;
  const totalHeight = rows * cellHeight + (rows + 1) * gap;

  const overlays: OverlayOptions[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const row = Math.floor(i / columns);
    const col = i % columns;
    const left = col * cellWidth + (col + 1) * gap;
    const top = row * cellHeight + (row + 1) * gap;

    // Resize thumbnail to fit cell with Lanczos3 resampling for maximum sharpness
    const resizedThumb = await sharp(candidate.thumbnailBuffer)
      .resize(cellWidth, cellHeight, {
        fit: 'cover',
        kernel: sharp.kernel.lanczos3,
        position: 'center',
      })
      .png()
      .toBuffer();

    // Compact #N corner chip only — the cover stays fully visible; titles are sent
    // to the VL model as the numbered candidate list in the prompt text.
    const indexLabel = `#${candidate.index}`;
    const fontSizeIndex = Math.max(18, Math.round(cellWidth * 0.042));
    const chipWidth = Math.round(indexLabel.length * fontSizeIndex * 0.62 + 20);
    const chipHeight = Math.round(fontSizeIndex * 1.35);

    const svgOverlay = Buffer.from(`
      <svg width="${cellWidth}" height="${cellHeight}">
        <rect x="8" y="8" width="${chipWidth}" height="${chipHeight}" rx="6" fill="#000000" opacity="0.8" />
        <rect x="8" y="8" width="5" height="${chipHeight}" rx="2" fill="#FFE600" />
        <text x="18" y="${fontSizeIndex + 10}" fill="#FFE600" font-family="system-ui, -apple-system, sans-serif" font-size="${fontSizeIndex}" font-weight="900">${xmlEscape(indexLabel)}</text>
      </svg>
    `);

    // Per-tile vision pipeline: PNG → sharpen → 256-colour palette, then stitch.
    const labeledTile = await toVisionPng(
      await sharp(resizedThumb)
        .composite([{ input: svgOverlay }])
        .png()
        .toBuffer(),
    );

    overlays.push({ input: labeledTile, left, top });
  }

  // Blank canvas with subtle dark background
  const canvas = sharp({
    create: {
      width: totalWidth,
      height: totalHeight,
      channels: 3,
      background: { r: 15, g: 17, b: 23 },
    },
  });

  let compositeBuffer: Buffer = await canvas
    .composite(overlays)
    .png()
    .toBuffer();

  // Second-pass unsharp masking on the assembled grid for crisp text & edges.
  compositeBuffer = await toVisionPng(compositeBuffer);

  if (outputPath) {
    await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
    await fs.writeFile(path.resolve(outputPath), compositeBuffer);
  }

  return {
    buffer: compositeBuffer,
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
