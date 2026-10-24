/**
 * Final Report Generator for the Xhot Trending Video Pipeline.
 *
 * Produces:
 * 1. Comprehensive Markdown report (FINAL_REPORT.md)
 * 2. Machine-readable JSON execution summary (final-report.json)
 * 3. Standalone styled HTML report (FINAL_REPORT.html)
 * 4. Colorized terminal executive summary
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import { markdownToHtml } from '../../utils/markdown-to-html.js';
import type { XHotFullResult } from './contracts.js';

/** Project root derived from this module's location (works for both src/ and dist/). */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Shortens filesystem paths for human-readable reports:
 * project-internal paths become project-relative, system/binary paths collapse to basename.
 */
function shortPath(p: string | undefined | null): string {
  if (!p) return 'N/A';
  const normalized = path.resolve(p);
  if (normalized === PROJECT_ROOT) return '.';
  if (normalized.startsWith(PROJECT_ROOT + path.sep)) return path.relative(PROJECT_ROOT, normalized);
  return path.basename(normalized);
}

/**
 * Generates the complete, human-readable Markdown execution report.
 */
export function generateFinalReportMarkdown(result: XHotFullResult): string {
  const {
    runId,
    query,
    startedAt,
    completedAt,
    totalDurationMs,
    winner,
    topCandidates,
    gridImagePath,
    harvestResult,
    explainer,
    stages = {},
    envCheck,
    outDir,
  } = result;

  const durationSec = (totalDurationMs / 1000).toFixed(1);

  const stageIcons: Record<string, string> = {
    completed: '✅',
    failed: '❌',
    skipped: '⏭️',
    in_progress: '⏳',
    pending: '⚪',
  };

  const lines: string[] = [
    '# 🔥 Xhot Trending Video Generation Pipeline Report',
    '',
    `**Run ID:** \`${runId}\`  `,
    `**Execution Date:** ${startedAt} — ${completedAt} (${durationSec}s total)  `,
    `**Artifacts Directory:** \`${shortPath(outDir)}\`  `,
    '',
    '---',
    '',
    '## 1. Executive Summary',
    '',
    '| Metric | Value |',
    '|---|---|',
    `| **Search Query / Topic** | **${query}** |`,
    `| **Selected Winner (Top 1)** | **${winner ? winner.name : 'N/A'}** |`,
    `| **Winner Summary** | ${winner?.summary ? winner.summary.replace(/\|/g, '\\|') : 'N/A'} |`,
    `| **Winner Selection Rationale** | ${winner?.reason ? winner.reason.replace(/\|/g, '\\|') : 'N/A'} |`,
    `| **Top Candidates Evaluated** | ${topCandidates?.length || 0} ranked candidates |`,
    `| **Candidate Matrix Grid** | \`${gridImagePath ? path.basename(gridImagePath) : 'N/A'}\` |`,
    `| **Harvested Community Tweets** | ${harvestResult?.items.length || 0} tweets |`,
    `| **Harvested Media Assets** | ${harvestResult?.harvestedMediaCount || 0} media files |`,
    `| **Explainer Video** | ${
      explainer?.videoPath
        ? `${path.basename(explainer.videoPath)} (${explainer.totalDurationSec.toFixed(1)}s @ ${explainer.fps}fps, ${explainer.resolution.width}x${explainer.resolution.height})`
        : 'Skipped / None'
    } |`,
    `| **Total Duration** | ${durationSec}s |`,
    '',
    '---',
    '',
    '## 2. Pipeline Execution Stages',
    '',
    '| Stage | Status | Duration | Summary |',
    '|---|---|---|---|',
  ];

  const stageDisplayNames: Record<string, string> = {
    'check-env': '1. Check Environment',
    'auth': '2. Check X Authentication & Cookies',
    'x-login': '2. X Persistent Login & Auth',
    'x-search': '3. Discover Hot Topics on X',
    'x-eval': '4. VL Grid Evaluation & Ranking',
    'x-harvest': '5. Harvest Materials & Video ASR',
    'x-video': '6. Render AI Explainer Video',
    'report': '7. Final Reporting',
  };

  for (const [stageKey, label] of Object.entries(stageDisplayNames)) {
    const stage = stages[stageKey];
    if (stage) {
      const icon = stageIcons[stage.status] || '⚪';
      const duration = `${(stage.durationMs / 1000).toFixed(2)}s`;
      const summaryText = (stage.summary || stage.error || '').replace(/\|/g, '\\|');
      lines.push(`| **${label}** | ${icon} \`${stage.status}\` | ${duration} | ${summaryText} |`);
    }
  }

  lines.push(
    '',
    '---',
    '',
    '## 3. Environment & Authentication Diagnostics',
    '',
    '### System Binaries & Profile',
    `- **Chromium Executable:** \`${shortPath(envCheck?.chromiumPath)}\` (${envCheck?.chromiumInstalled ? 'Installed' : 'Missing'})`,
    ...(envCheck?.chromiumVersion ? [`- **Chromium Version:** \`${envCheck.chromiumVersion}\``] : []),
    `- **yt-dlp Binary:** \`${shortPath(envCheck?.ytDlpPath)}\` (${envCheck?.ytDlpInstalled ? 'Installed' : 'Missing'})`,
    `- **ffmpeg Binary:** ${envCheck?.ffmpegInstalled ? 'Installed & Accessible' : 'Missing / Not found in PATH'}`,
    `- **Persistent Chromium Profile:** \`${shortPath(envCheck?.profileDir)}\``,
    '',
    '### Remote AI Gateways & Models',
    `- **AI Gateway URL:** \`${envCheck?.llmEndpoint || 'Configured'}\``,
    `- **LLM Model (Text & Analysis):** \`${envCheck?.llmModel || 'default'}\``,
    `- **Vision-Language (VL) Model (Grid Ranking):** \`${envCheck?.vlModel || 'configured'}\``,
    `- **Puter ASR Speech Transcription:** ${envCheck?.puterAsrConfigured ? '✅ Active & Reachable' : '⚠️ Disabled / Unconfigured'}`,
    '',
    '---',
    '',
    '## 4. Visual Candidate Matrix Grid',
    ''
  );

  if (gridImagePath) {
    const relGrid = path.relative(outDir, gridImagePath).split(path.sep).join('/');
    lines.push(
      `Candidate discovery screenshots stitched into visual NxN contact grid: \`${path.basename(gridImagePath)}\``,
      '',
      `![Candidate Matrix Grid](${relGrid})`,
      ''
    );
  } else {
    lines.push('*(No grid image artifact recorded)*', '');
  }

  lines.push(
    '---',
    '',
    '## 5. Candidate Evaluation & Top-3 Rankings',
    ''
  );

  if (winner) {
    lines.push(
      `### 🏆 Winner (Rank 1): ${winner.name}`,
      `- **Topic Summary:** ${winner.summary}`,
      `- **Why it Won:** ${winner.reason}`,
      ''
    );
  }

  if (topCandidates && topCandidates.length > 0) {
    lines.push(
      '### Top Candidates Comparison',
      '',
      '| Rank | Candidate / Topic | Summary | Selection Rationale |',
      '|---|---|---|---|'
    );
    for (const c of topCandidates) {
      const rankBadge = c.rank === 1 ? '🥇 #1' : c.rank === 2 ? '🥈 #2' : c.rank === 3 ? '🥉 #3' : `#${c.rank}`;
      const sum = (c.summary || '').replace(/\|/g, '\\|');
      const rsn = (c.reason || '').replace(/\|/g, '\\|');
      lines.push(`| **${rankBadge}** | **${c.name}** | ${sum} | ${rsn} |`);
    }
    lines.push('');

    for (const c of topCandidates) {
      lines.push(
        `#### Rank #${c.rank}: ${c.name}`,
        `- **Summary:** ${c.summary}`,
        `- **Selection Rationale:** ${c.reason}`,
        ''
      );
    }
  }

  lines.push(
    '---',
    '',
    '## 6. Harvested Community Materials',
    ''
  );

  if (harvestResult) {
    lines.push(
      `- **Harvested Tweets:** ${harvestResult.items.length}`,
      `- **Harvested Media Files (Images / Videos):** ${harvestResult.harvestedMediaCount}`,
      `- **Materials Directory:** \`${path.relative(outDir, harvestResult.materialsDir) || 'materials'}\``,
      '',
      '### Harvested Items Breakdown',
      '',
      '| # | Author | Tweet Content | Media | ASR Transcript |',
      '|---|---|---|---|---|'
    );

    for (const [idx, item] of harvestResult.items.entries()) {
      const snippet = (item.text || '').replace(/[\r\n]+/g, ' ').slice(0, 70).replace(/\|/g, '\\|');
      const mediaCount = item.mediaFiles?.length || 0;
      const asrBadge = item.asrTranscript ? '🎙️ Yes' : '—';
      lines.push(`| ${idx + 1} | ${item.authorName} (\`@${item.authorHandle}\`) | ${snippet}... | ${mediaCount} file(s) | ${asrBadge} |`);
    }
    lines.push('');

    const asrTranscripts = harvestResult.items.filter((it) => it.asrTranscript);
    if (asrTranscripts.length > 0) {
      lines.push('### 🎙️ Video Speech Transcripts (Puter ASR)', '');
      for (const it of asrTranscripts) {
        lines.push(
          `> **Tweet by ${it.authorName} (@${it.authorHandle}):**`,
          `> "${it.asrTranscript?.replace(/\n/g, ' ')}"`,
          ''
        );
      }
    }
  } else {
    lines.push('*(Materials harvesting was skipped or produced no items)*', '');
  }

  lines.push(
    '---',
    '',
    '## 7. AI Explainer Video (OpusVideo Engine)',
    ''
  );

  if (explainer) {
    lines.push(
      `- **Video File:** \`${path.basename(explainer.videoPath)}\``,
      `- **Duration:** ${explainer.totalDurationSec.toFixed(1)}s @ ${explainer.fps}fps`,
      `- **Resolution:** ${explainer.resolution.width}x${explainer.resolution.height}`,
      `- **Storyboard Scenes:** ${explainer.sceneCount}`,
      `- **Player HTML:** \`${path.basename(explainer.playerPath)}\``,
      `- **Narration Voice:** \`${explainer.voice}\` (rate: \`${explainer.rate}\`)`,
      `- **Narration Audio:** \`${path.basename(explainer.narrationPath)}\``,
      `- **Frames Rendered:** ${explainer.framesRendered}`,
      `- **Storyboard File:** \`${path.basename(explainer.storyboardPath)}\``,
      ''
    );

    if (explainer.gridPath && fsSync.existsSync(explainer.gridPath)) {
      const relExplainerGrid = path.relative(outDir, explainer.gridPath).split(path.sep).join('/');
      lines.push(
        `### Explainer Video Frame Grid`,
        '',
        `![Explainer Video Grid](${relExplainerGrid})`,
        ''
      );
    }
  } else {
    lines.push('*(Explainer video generation was skipped via `--skip-video` or did not complete)*', '');
  }

  lines.push(
    '---',
    '',
    '## 8. Artifact Manifest',
    '',
    'All run outputs and intermediate assets are structured in the run directory:',
    '',
    '```',
    `${shortPath(outDir)}/`,
    '├── FINAL_REPORT.md             # This comprehensive execution report',
    '├── FINAL_REPORT.html           # Self-contained styled HTML report',
    '├── final-report.json           # Machine-readable pipeline execution summary',
    '├── xhot-grid.png               # Visual candidate matrix contact grid',
    '├── eval-result.json            # VL evaluation & top-3 rankings',
    '├── harvest-result.json         # Downloaded media & tweet details',
    '├── candidate-shots/            # Screenshots of candidate tweets',
    '├── materials/                  # Harvested images/videos from winner topic',
    '├── explainer/                  # Explainer video, storyboard, and audio narration',
    '└── pipeline.log                # Execution logs',
    '```',
    '',
    '---',
    `*Generated automatically by Xhot Trending Video Pipeline CLI at ${completedAt}*`
  );

  return lines.join('\n');
}

/**
 * Generates formatted JSON string representing the complete pipeline result.
 */
export function generateFinalReportJson(result: XHotFullResult): string {
  return JSON.stringify(result, null, 2);
}

/**
 * Saves JSON, Markdown and self-contained HTML final report artifacts
 * to the target directory.
 */
export async function saveFinalReports(
  result: XHotFullResult,
  outDir: string
): Promise<{ jsonPath: string; markdownPath: string; htmlPath: string }> {
  const resolvedDir = path.resolve(outDir);
  await fs.mkdir(resolvedDir, { recursive: true });

  const jsonPath = path.join(resolvedDir, 'final-report.json');
  const markdownPath = path.join(resolvedDir, 'FINAL_REPORT.md');
  const htmlPath = path.join(resolvedDir, 'FINAL_REPORT.html');

  const markdownContent = generateFinalReportMarkdown(result);
  const jsonContent = generateFinalReportJson(result);
  const htmlContent = markdownToHtml(markdownContent, {
    title: `Xhot Pipeline Report — ${result.runId}`,
    baseDir: resolvedDir,
  });

  await fs.writeFile(markdownPath, markdownContent, 'utf8');
  await fs.writeFile(jsonPath, jsonContent, 'utf8');
  await fs.writeFile(htmlPath, htmlContent, 'utf8');

  // Maintain backward-compatibility for existing consumers
  await fs.writeFile(path.join(resolvedDir, 'report.md'), markdownContent, 'utf8');
  await fs.writeFile(path.join(resolvedDir, 'result.json'), jsonContent, 'utf8');

  return { jsonPath, markdownPath, htmlPath };
}

/**
 * Backward-compatible aliases.
 */
export const generateXHotMarkdown = generateFinalReportMarkdown;
export const generateXHotJson = generateFinalReportJson;

/**
 * Displays an executive terminal summary upon pipeline completion.
 */
export function printExecutiveSummary(result: XHotFullResult): void {
  const explainer = result.explainer || result.tutorial;
  const elapsed = (result.totalDurationMs / 1000).toFixed(1);

  console.log(pc.bold(pc.green('\n======================================================')));
  console.log(pc.bold(pc.green('   🔥 XHOT TRENDING VIDEO PIPELINE COMPLETE          ')));
  console.log(pc.bold(pc.green('======================================================\n')));

  console.log(`${pc.bold('Query Topic:')}        ${result.query}`);
  console.log(`${pc.bold('Execution Time:')}     ${elapsed}s total across stages`);
  console.log(`${pc.bold('Run ID:')}             ${result.runId}`);
  console.log(`${pc.bold('Artifacts Directory:')} ${result.outDir}\n`);

  if (result.winner) {
    console.log(pc.bold(pc.cyan('--- Selected Trending Winner ---')));
    console.log(`${pc.bold('Winner (Top 1):')}     ${pc.green(result.winner.name)}`);
    console.log(`${pc.bold('Summary:')}           ${result.winner.summary}`);
    console.log(`${pc.bold('Why it Won:')}        ${result.winner.reason}\n`);
  }

  if (result.topCandidates && result.topCandidates.length > 0) {
    console.log(pc.bold(pc.cyan('--- Top Ranked Candidates ---')));
    for (const tc of result.topCandidates) {
      console.log(`  ${pc.bold(`#${tc.rank}`)} ${tc.name} — ${tc.summary}`);
    }
    console.log();
  }

  if (result.harvestResult) {
    console.log(pc.bold(pc.cyan('--- Harvested Materials ---')));
    console.log(
      `  • Tweets: ${result.harvestResult.items.length} collected, Media: ${result.harvestResult.harvestedMediaCount} files`
    );
    console.log();
  }

  if (explainer?.videoPath) {
    console.log(pc.bold(pc.cyan('--- AI Explainer Video ---')));
    console.log(`  • Video: ${explainer.videoPath} (${explainer.totalDurationSec.toFixed(1)}s @ ${explainer.fps}fps)`);
    console.log();
  }

  console.log(pc.bold(pc.magenta('Reports Generated:')));
  const mdPath = result.reportMarkdownPath || path.join(result.outDir, 'FINAL_REPORT.md');
  const htmlPath = result.reportHtmlPath || path.join(result.outDir, 'FINAL_REPORT.html');
  const jsonPath = result.reportJsonPath || path.join(result.outDir, 'final-report.json');
  console.log(` ${pc.dim('•')} Markdown Report: ${pc.bold(mdPath)}`);
  console.log(` ${pc.dim('•')} HTML Report:     ${pc.bold(htmlPath)}`);
  console.log(` ${pc.dim('•')} JSON Summary:    ${pc.bold(jsonPath)}\n`);
}

/** Backward compatibility alias */
export const printXHotSummary = printExecutiveSummary;
