import path from 'node:path';
import fs from 'node:fs/promises';
import { searchYouTubeInBrowser } from './browser-search.js';
import { buildNxNCandidateGrid } from './grid.js';
import { evaluateCandidatesWithVL } from './evaluator.js';
import type { FastEvalData, FastEvalOptions, FastEvalResult } from './types.js';

export * from './types.js';
export * from './browser-search.js';
export * from './grid.js';
export * from './evaluator.js';

/**
 * Runs the complete FastEval workflow:
 * 1. Opens YouTube search directly in Chromium browser (same session as Google Flow).
 * 2. Captures screenshots of top candidate video thumbnails.
 * 3. Assembles and sharpens an NxN contact grid and compresses it.
 * 4. Submits the grid to VL model to judge visual appeal (风格化, 戏剧性, 趣味性, 盈利性, 独特性/差异化).
 * 5. Returns the VL shortlist: top-3 candidates with one-line reasons and the winner.
 */
export async function runFastEval(options: FastEvalOptions): Promise<FastEvalResult> {
  const {
    query,
    topic,
    candidateCount = 25,
    profileDir = './.chromium-profile',
    browserPath,
    viewport,
    model,
    outDir,
    minDurationSec,
    maxAgeDays,
    onProgress,
  } = options;

  onProgress?.('fasteval-search', `Stage: Searching YouTube via browser for "${query}"`);

  // 1. Search YouTube in browser & capture candidate cover screenshots
  const candidates = await searchYouTubeInBrowser({
    query,
    candidateCount,
    profileDir,
    browserPath,
    viewport,
    headless: options.headless,
    debugDir: path.resolve(outDir),
    minDurationSec,
    maxAgeDays,
    onProgress,
  });

  onProgress?.('fasteval-grid', `Stage: Assembling NxN contact grid for ${candidates.length} candidates`);

  // 2. Build NxN sharpened, compressed grid
  const gridFilename = 'fasteval-grid.png';
  const gridPath = path.join(path.resolve(outDir), gridFilename);
  const { buffer: gridBuffer } = await buildNxNCandidateGrid({
    candidates,
    outputPath: gridPath,
  });

  onProgress?.('fasteval-eval', `Stage: Evaluating candidate covers with Vision-Language model`);

  // 3. Multimodal VL evaluation
  const result = await evaluateCandidatesWithVL({
    query,
    topic,
    candidates,
    gridBuffer,
    gridImagePath: gridPath,
    model,
    onProgress,
  });

  // Save fasteval summary report
  const summaryPath = path.join(path.resolve(outDir), 'fasteval-result.json');
  await fs.writeFile(
    summaryPath,
    JSON.stringify(
      {
        query: result.query,
        winnerIndex: result.winnerIndex,
        winnerVideoId: result.winner.videoId,
        winnerTitle: result.winner.title,
        reasoning: result.reasoning,
        topCandidates: result.topCandidates,
        candidates: result.candidates.map((c) => ({
          index: c.index,
          videoId: c.videoId,
          title: c.title,
          channel: c.channelTitle,
          duration: c.durationText,
          views: c.viewCountText || (c.viewCount ? `${c.viewCount.toLocaleString()} views` : undefined),
          viewCount: c.viewCount,
          viewsPerDay: c.viewsPerDay,
        })),
        gridImagePath: result.gridImagePath,
        evaluatedAt: result.evaluatedAt,
      },
      null,
      2
    )
  );

  return result;
}

/**
 * Strips binary buffers from a FastEvalResult for durable persistence
 * (run artifacts, cross-stage handoff).
 */
export function toFastEvalData(result: FastEvalResult): FastEvalData {
  const { gridBuffer, candidates, winner, ...metadata } = result;
  const { thumbnailBuffer, ...winnerMetadata } = winner;
  return {
    ...metadata,
    winner: winnerMetadata,
    candidates: candidates.map(({ thumbnailBuffer: _thumbnail, ...candidate }) => candidate),
  };
}
