#!/usr/bin/env node
/**
 * Standalone YouTube Search & Candidate Pre-Filtering CLI.
 *
 * Discovers video candidates via yt-dlp, hydrates platform metadata and
 * derived metrics (velocity, engagement), applies metric pre-filtering thresholds,
 * and outputs formatted terminal summary tables or structured JSON.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import pc from 'picocolors';
import type { VideoCandidate, MetricFilterResult } from '../contracts.js';
import { AppError, ErrorCodes } from '../errors.js';
import {
  DEFAULT_THRESHOLDS,
  filterCandidates,
  rejectionReason,
  type MetricThresholds,
} from '../youtube/filter.js';
import { searchVideos } from '../youtube/ytdlp.js';
import { createRunLogger, type RunLogger } from '../../utils/logger.js';
import { generateRunId, ensureOutputDir } from '../../utils/run.js';
import { attachMetricThresholdOptions, parseMetricThresholdOptions } from './options.js';

export interface SearchCliOptions {
  query: string;
  maxCandidates?: number;
  output?: string;
  format?: 'table' | 'json' | 'both';
  metricThresholds?: Partial<MetricThresholds>;
  relaxOnEmpty?: boolean;
  cookiePath?: string;
  proxyUrl?: string;
}

export interface SearchCliResult {
  query: string;
  candidates: VideoCandidate[];
  filtered: MetricFilterResult;
  savedPath?: string;
}

/**
 * Formats duration in seconds to M:SS or H:MM:SS
 */
function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Renders an ASCII/styled table of candidate evaluation and filter status.
 */
export function renderCandidatesTable(
  allCandidates: readonly VideoCandidate[],
  thresholds: MetricThresholds,
  filtered: MetricFilterResult
): void {
  console.log(pc.bold(pc.cyan('\n=== YouTube Candidate Discovery & Pre-Filtering ===\n')));
  console.log(`${pc.bold('Query:')}             ${filtered.query}`);
  console.log(`${pc.bold('Discovered:')}        ${allCandidates.length}`);
  console.log(`${pc.bold('Eligible (Kept):')}  ${pc.green(filtered.kept.length)}`);
  console.log(`${pc.bold('Rejected:')}         ${filtered.rejected.length > 0 ? pc.yellow(filtered.rejected.length) : '0'}\n`);

  const rejectedMap = new Map<string, string>(
    filtered.rejected.map((r) => [r.videoId, r.reason])
  );

  console.log(
    pc.dim('ID           STATUS    DURATION  VIEWS        VIEWS/DAY   ENGAGE   CHANNEL                 TITLE')
  );
  console.log(pc.dim('─'.repeat(105)));

  for (const c of allCandidates) {
    const isKept = !rejectedMap.has(c.videoId);
    const statusTag = isKept ? pc.green('PASSED  ') : pc.red('REJECTED');
    const id = c.videoId.padEnd(12);
    const duration = formatDuration(c.metrics.durationSec).padStart(8);
    const views = c.metrics.viewCount.toLocaleString().padStart(11);
    const velocity = Math.round(c.metrics.viewsPerDay).toLocaleString().padStart(10);
    const engagement = `${(c.metrics.engagementRate * 100).toFixed(1)}%`.padStart(7);
    const channel = (c.channelTitle.length > 22 ? c.channelTitle.slice(0, 20) + '..' : c.channelTitle).padEnd(23);
    const title = c.title.length > 30 ? c.title.slice(0, 28) + '..' : c.title;

    console.log(`${id} ${statusTag} ${duration} ${views} ${velocity} ${engagement}  ${channel} ${title}`);

    if (!isKept) {
      const reason = rejectedMap.get(c.videoId);
      console.log(`             ${pc.dim('↳ Rejection Reason: ')}${pc.yellow(reason || 'Unknown')}`);
    }
  }
  console.log(pc.dim('─'.repeat(105)) + '\n');
}

/**
 * Core programmatic runner for YouTube search CLI.
 */
export async function runSearchCli(options: SearchCliOptions): Promise<SearchCliResult> {
  const query = options.query.trim();
  if (!query) {
    throw new AppError({
      code: ErrorCodes.INVALID_REQUEST,
      message: 'Query parameter cannot be empty',
      stage: 'research-search',
      task: 'validate-input',
    });
  }

  const maxCandidates = options.maxCandidates ?? 15;
  const thresholds: MetricThresholds = {
    ...DEFAULT_THRESHOLDS,
    ...options.metricThresholds,
  };

  const search = await searchVideos({
    query,
    maxCandidates,
    cookiePath: options.cookiePath,
    proxyUrl: options.proxyUrl,
  });

  let filtered: MetricFilterResult;
  try {
    filtered = filterCandidates(search.candidates, query, thresholds);
  } catch (err: any) {
    if (err.code === ErrorCodes.NO_ELIGIBLE_VIDEO && options.relaxOnEmpty !== false) {
      const relaxedThresholds: MetricThresholds = {
        minDurationSec: 60,
        maxAgeDays: 365,
      };
      try {
        filtered = filterCandidates(search.candidates, query, relaxedThresholds);
      } catch {
        const sortedByViews = [...search.candidates].sort(
          (a, b) => b.metrics.viewCount - a.metrics.viewCount
        );
        filtered = {
          query,
          thresholds: relaxedThresholds,
          kept: sortedByViews.slice(0, Math.min(3, sortedByViews.length)),
          rejected: sortedByViews.slice(3).map((c) => ({
            videoId: c.videoId,
            reason: 'outside top view counts during fallback',
          })),
        };
      }
    } else {
      throw err;
    }
  }

  let savedPath: string | undefined;
  if (options.output) {
    savedPath = path.resolve(options.output);
    await fs.mkdir(path.dirname(savedPath), { recursive: true });
    await fs.writeFile(
      savedPath,
      JSON.stringify(
        {
          query,
          thresholds: filtered.thresholds,
          totalDiscovered: search.candidates.length,
          keptCount: filtered.kept.length,
          rejectedCount: filtered.rejected.length,
          kept: filtered.kept,
          rejected: filtered.rejected,
        },
        null,
        2
      ),
      'utf-8'
    );
  }

  return {
    query,
    candidates: search.candidates,
    filtered,
    savedPath,
  };
}

// CLI Command Setup
const program = new Command();

program
  .name('yt-research-search')
  .description('Discover YouTube candidates, hydrate platform metrics, and apply pre-filtering')
  .version('1.0.0')
  .requiredOption('-q, --query <string>', 'Search query or YouTube URL/ID')
  .option('-n, --max-candidates <number>', 'Maximum candidates to discover', (v) => parseInt(v, 10), 15)
  .option('-o, --output <path>', 'Destination file path for candidates JSON (relative to artifact dir)')
  .option('-f, --format <type>', 'Output display format (table, json, both)', 'table');
attachMetricThresholdOptions(program);
program
  .option('--no-relax', 'Disable filter threshold relaxation when all candidates fail')
  .option('--cookie-path <path>', 'Path to cookies.txt for yt-dlp authentication')
  .option('--proxy-url <url>', 'Proxy URL (HTTP/HTTPS/SOCKS5) for yt-dlp')
  .option('--no-proxy', 'Disable proxy for yt-dlp requests and connect directly')
  .option('--artifacts-dir <path>', 'Output directory for run artifacts (default: artifacts/search-<runId>/)')
  .action(async (opts) => {
    const runId = generateRunId('search');
    const outDir = await ensureOutputDir(opts.artifactsDir, runId);

    const logger = createRunLogger({
      runId,
      logDir: outDir,
      title: 'YOUTUBE SEARCH RUN LOG',
    });

    try {
      logger.stage('search', 'Starting YouTube candidate search', {
        query: opts.query,
        maxCandidates: opts.maxCandidates,
      });

      const result = await runSearchCli({
        query: opts.query,
        maxCandidates: opts.maxCandidates,
        output: opts.output ? path.join(outDir, opts.output) : undefined,
        format: opts.format,
        metricThresholds: parseMetricThresholdOptions(opts),
        relaxOnEmpty: opts.relax,
        cookiePath: opts.cookiePath,
        proxyUrl: opts.proxy === false ? 'none' : opts.proxyUrl,
      });

      logger.info('Search complete', {
        totalDiscovered: result.candidates.length,
        kept: result.filtered.kept.length,
        rejected: result.filtered.rejected.length,
      });

      if (opts.format === 'table' || opts.format === 'both') {
        renderCandidatesTable(result.candidates, result.filtered.thresholds, result.filtered);
      }

      if (opts.format === 'json' || opts.format === 'both') {
        console.log(
          JSON.stringify(
            {
              query: result.query,
              total: result.candidates.length,
              kept: result.filtered.kept.map((c) => ({
                videoId: c.videoId,
                title: c.title,
                channel: c.channelTitle,
                views: c.metrics.viewCount,
                viewsPerDay: Math.round(c.metrics.viewsPerDay),
                engagementRate: c.metrics.engagementRate,
                durationSec: c.metrics.durationSec,
              })),
              rejected: result.filtered.rejected,
            },
            null,
            2
          )
        );
      }

      if (result.savedPath) {
        logger.info('Candidate dataset saved', { path: result.savedPath });
        console.log(pc.green(`✓ Saved candidate dataset to: ${result.savedPath}\n`));
      }

      console.log(pc.dim(`Run artifacts: ${outDir}`));
      console.log(pc.dim(`  run.log        - Human-readable log`));
      console.log(pc.dim(`  run.jsonl      - Structured JSON-lines log`));
      if (opts.output) console.log(pc.dim(`  ${opts.output} - Candidate data\n`));
    } catch (err: any) {
      logger.error('Search failed', err);
      console.error(pc.red(`\n[Search Error] ${err.message}`));
      process.exit(1);
    } finally {
      await logger.close();
    }
  });

// Execute when run as CLI entry point
if (process.argv[1]?.endsWith('search.ts') || process.argv[1]?.endsWith('search.js')) {
  program.parse(process.argv);
}
