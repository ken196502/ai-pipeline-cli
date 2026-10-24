/**
 * Final Report Generator for the "AI make Niche Viral Video" Pipeline.
 *
 * Produces:
 * 1. Comprehensive Markdown report (FINAL_REPORT.md)
 * 2. Machine-readable JSON execution summary (final-report.json)
 * 3. Colorized terminal executive summary
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import { markdownToHtml } from '../../utils/markdown-to-html.js';
import type { ViralPipelineResult } from './contracts.js';

/** Project root derived from this module's location (works for both src/ and dist/). */
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Shortens filesystem paths for human-readable reports:
 * project-internal paths become project-relative, system/binary paths collapse to basename.
 * Machine consumers should use final-report.json which always keeps full paths.
 */
function shortPath(p: string | undefined | null): string {
  if (!p) return 'N/A';
  const normalized = path.resolve(p);
  if (normalized === PROJECT_ROOT) return '.';
  if (normalized.startsWith(PROJECT_ROOT + path.sep)) return path.relative(PROJECT_ROOT, normalized);
  return path.basename(normalized);
}

/** Short SHA for human readers (full digest lives in final-report.json). */
function shortHash(h: string | undefined | null): string {
  return h ? `${h.slice(0, 12)}…` : 'N/A';
}

/**
 * Generates the complete, human-readable Markdown execution report.
 */
export function generateFinalReportMarkdown(result: ViralPipelineResult): string {
  const {
    runId,
    query,
    topic,
    startedAt,
    completedAt,
    totalDurationMs,
    stages,
    envCheck,
    ytbCheck,
    search,
    standard,
    evaluation,
    extractedPrompts,
    generatedScript,
    flowProject,
    flowGeneration,
    tutorial,
    outDir,
  } = result;

  const winner = evaluation.winner;
  const durationSec = (totalDurationMs / 1000).toFixed(1);

  const stageIcons: Record<string, string> = {
    completed: '✅',
    failed: '❌',
    skipped: '⏭️',
    in_progress: '⏳',
    pending: '⚪',
  };

  const lines: string[] = [
    '# 🎬 AI Viral Video Generation Pipeline Report',
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
    `| **Search Query / Topic** | **${query}** (${topic}) |`,
    `| **Selected Winner** | [${winner.title}](${winner.url}) (\`${winner.videoId}\`) |`,
    `| **Winner Channel** | ${winner.channelTitle} |`,
    `| **Candidate Views / Velocity** | ${winner.metrics.viewCount.toLocaleString()} views (${winner.metrics.viewsPerDay.toLocaleString()} views/day) |`,
    `| **Engagement Rate** | ${(winner.metrics.engagementRate * 100).toFixed(2)}% |`,
    `| **Composite Quality Score** | **${evaluation.compositeScore.toFixed(2)} / 5.00** (${evaluation.displayBand}) |`,
    `| **Evaluation Standard** | \`${shortHash(standard.standardHash)}\` (${standard.reused ? 'Reused' : 'Newly Distilled'}) |`,
    `| **Standard Persistence** | \`${shortPath(standard.savedPath)}\` |`,
    `| **Veo Video Script** | **${generatedScript.totalClips} clips** (${generatedScript.totalDurationSec}s total, ${generatedScript.aspectRatio}) |`,
    `| **Google Flow Project** | ${flowProject?.url ? `[${flowProject.projectId || 'Workspace Project'}](${flowProject.url})` : 'Skipped / N/A'} |`,
    `| **Generated Video Clips** | **${flowGeneration?.completedClips || 0} / ${flowGeneration?.totalClips || 0} completed** (${flowGeneration?.dryRun ? 'DRY RUN' : 'Synthesized'}) |`,
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
    'check-ytb': '2. Check YouTube Auth',
    'browser-refresh': '3. Browser Refresh Cookies',
    'search-ytb': '4. Search YouTube Candidates',
    'standard-load': '5a. Load Reusable Standard',
    'standard-gen': '5b. Distill LLM Standard',
    'standard-save': '6. Save Standard for Reuse',
    evaluate: '7. Rubric Candidate Evaluation',
    'extract-prompts': '8. Extract Transcript Scenes',
    'gen-prompts': '9. Generate Veo Script Prompts',
    'flow-login': '10. Google Flow Auth Login',
    'flow-project': '11. Create / Open Flow Project',
    'flow-generate': '12. Batch Video Generation',
    'tutorial-gen': '13. Tutorial Video (解说视频)',
    report: '14. Final Reporting',
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
    `- **Chromium Executable:** \`${shortPath(envCheck.chromiumPath)}\` (${envCheck.chromiumVersion || 'Unknown'})`,
    `- **yt-dlp Binary:** \`${shortPath(envCheck.ytDlpPath)}\` (${envCheck.ytDlpInstalled ? 'Installed' : 'Missing'})`,
    `- **ffmpeg Binary:** ${envCheck.ffmpegInstalled ? 'Installed & Accessible' : 'Missing / Not found in PATH'}`,
    `- **Persistent Chromium Profile:** \`${shortPath(envCheck.profileDir)}\` (${envCheck.flowProfileExists ? 'Exists' : 'Created'})`,
    `- **LLM AI Gateway:** \`${envCheck.llmEndpoint || 'Configured'}\` (Model: \`${envCheck.llmModel || 'configured'}\`)`,
    '',
    '### YouTube Authentication',
    `- **Cookie File:** \`${shortPath(ytbCheck.cookiePath)}\``,
    `- **Cookie Status:** ${ytbCheck.valid ? '✅ Valid & Authenticated' : '⚠️ Unauthenticated / Missing'}`,
    `- **Verification Stage:** \`${ytbCheck.stage}\``,
    `- **Refreshed via Browser:** ${ytbCheck.refreshedViaBrowser ? 'Yes (Ungoogled Chromium)' : 'No (Existing valid cookies reused)'}`,
    ...(ytbCheck.foundAuthTokens?.length ? [`- **Active Tokens:** \`${ytbCheck.foundAuthTokens.join('`, `')}\``] : []),
    ...(ytbCheck.missingAuthTokens?.length ? [`- **Missing Tokens:** \`${ytbCheck.missingAuthTokens.join('`, `')}\``] : []),
    '',
    '---',
    '',
    '## 4. Evaluation Standard & SHA-256 Tamper-Evident Digest',
    '',
    `**Standard Status:** ${standard.reused ? '🔄 **Reused Existing Standard**' : '✨ **Newly Distilled 3-Round Standard**'}  `,
    `**Standard Hash (short):** \`${shortHash(standard.standardHash)}\`  `,
    `**Canonical Topic:** **${standard.topic}**  `,
    `**Reusable Standard Path:** \`${shortPath(standard.savedPath)}\`  `,
    '',
    '### Qualitative Evaluation Dimensions (1-5 Rubrics)',
    ''
  );

  for (const dim of standard.standard.qualitativeEvaluation.dimensions) {
    lines.push(`#### Dimension: ${dim.dimension}`, `*${dim.description}*`, '');
    lines.push('| Score | Scoring Criteria |', '|---|---|');
    lines.push(`| 1 (Poor) | ${dim.scoringCriteria[1]} |`);
    lines.push(`| 2 (Subpar) | ${dim.scoringCriteria[2]} |`);
    lines.push(`| 3 (Acceptable) | ${dim.scoringCriteria[3]} |`);
    lines.push(`| 4 (Strong) | ${dim.scoringCriteria[4]} |`);
    lines.push(`| 5 (Exemplary) | ${dim.scoringCriteria[5]} |`);
    lines.push('');
  }

  lines.push(
    '### Quantitative Dimensions',
    ''
  );
  for (const q of standard.standard.quantitativeDimensions) {
    lines.push(`- **${q.name}:** Metric \`${q.metricKey}\` (preferred direction: \`${q.direction}\`)`);
  }

  lines.push(
    '',
    '---',
    '',
    '## 5. Candidate Evaluation & Winner Selection (research-selection-v2)',
    '',
    `**Selected Winner Video ID:** \`${winner.videoId}\`  `,
    `**Winner Title:** **${winner.title}**  `,
    `**Winner URL:** [${winner.url}](${winner.url})  `,
    `**Composite Score:** **${evaluation.compositeScore.toFixed(2)} / 5.00** (${evaluation.displayBand})  `,
    `**Selectable:** ${evaluation.isSelectable ? 'Yes' : 'No'}  `,
    `**Selection Rationale:** ${evaluation.reason}  `,
    '',
    '### Evaluation Pool Candidates',
    '',
    '| Video ID | Title | Views | Views/Day | Engagement | Score | Band | Selectable |',
    '|---|---|---|---|---|---|---|---|'
  );

  const candidateMap = new Map(search.candidates.map((c) => [c.videoId, c]));
  for (const ev of evaluation.evaluations) {
    const v = candidateMap.get(ev.videoId);
    const title = v ? `${v.title.slice(0, 45)}...` : ev.videoId;
    const views = v ? v.metrics.viewCount.toLocaleString() : 'N/A';
    const vpd = v ? v.metrics.viewsPerDay.toLocaleString() : 'N/A';
    const eng = v ? `${(v.metrics.engagementRate * 100).toFixed(2)}%` : 'N/A';
    lines.push(
      `| \`${ev.videoId}\` | ${title} | ${views} | ${vpd} | ${eng} | **${ev.compositeScore.toFixed(2)}** | ${ev.displayBand} | ${ev.selectable ? '✅' : '❌'} |`
    );
  }

  lines.push(
    '',
    '---',
    '',
    '## 6. Winner Transcript Scenes & Visual Prompt Extraction',
    '',
    `**Total Scenes Extracted:** ${extractedPrompts.scenesCount}  `,
    ''
  );

  for (const seg of extractedPrompts.segments) {
    const startM = Math.floor(seg.startSec / 60);
    const startS = Math.floor(seg.startSec % 60);
    const endM = Math.floor(seg.endSec / 60);
    const endS = Math.floor(seg.endSec % 60);
    const timeCode = `${String(startM).padStart(2, '0')}:${String(startS).padStart(2, '0')} - ${String(endM).padStart(2, '0')}:${String(endS).padStart(2, '0')}`;

    lines.push(
      `### [${seg.segmentId}] ${seg.title} (${timeCode})`,
      `**Narration / Voiceover Text:**`,
      `> "${seg.narration}"`,
      ''
    );
  }

  lines.push(
    '---',
    '',
    '## 7. Veo-Optimized Video Script (`flow-video-script.json`)',
    '',
    `**Aspect Ratio:** \`${generatedScript.aspectRatio}\`  `,
    `**Clip Duration:** ${generatedScript.clips[0]?.durationSec || 4} seconds per clip  `,
    `**Total Clips:** ${generatedScript.totalClips}  `,
    `**Estimated Flow Credits:** ${generatedScript.totalClips * 15} credits  `,
    `**Script File Path:** \`${shortPath(generatedScript.scriptPath)}\`  `,
    '',
    '### Generated Multi-Clip Prompts',
    ''
  );

  for (const clip of generatedScript.clips) {
    lines.push(
      `### Clip ${clip.clipIndex}: ${clip.title || `Scene ${clip.clipIndex}`}`,
      `- **Scene ID:** \`${clip.sceneId}\``,
      `- **Timestamp:** ${clip.startSec}s - ${clip.endSec}s (${clip.durationSec}s duration)`,
      `- **Shot Transition (切分镜/连续):** \`${clip.transition === 'continuous' ? '连续/continuous' : '切分镜/cut'}\` — ${clip.transitionNote || '（无备注）'}`,
      `- **Camera Motion:** ${clip.cameraMovement}`,
      `- **Subject Action:** ${clip.subjectAction}`,
      `- **Environment & Lighting:** ${clip.environmentLighting}`,
      `- **Aesthetic Style:** ${clip.styleAesthetic}`,
      `- **Voiceover Cue:** *"${clip.narrationCues}"*`,
      `- **Veo Visual Prompt:**`,
      '```text',
      clip.visualPrompt,
      '```',
      ''
    );
  }

  lines.push(
    '---',
    '',
    '## 8. Google Flow Generation & Video Artifacts',
    ''
  );

  if (flowProject) {
    lines.push(
      `- **Flow Project Workspace:** [${flowProject.projectId || 'Workspace'}](${flowProject.url})`,
      `- **Project ID:** \`${flowProject.projectId || 'Auto-allocated'}\``
    );
  }

  if (flowGeneration) {
    lines.push(
      `- **Status:** ${flowGeneration.dryRun ? '⚠️ **Dry Run Completed**' : '✅ **Synthesis Complete**'}`,
      `- **Completed Clips:** ${flowGeneration.completedClips} / ${flowGeneration.totalClips}`,
      `- **Failed Clips:** ${flowGeneration.failedClips}`,
      '',
      '| Clip # | Status | Local Video Path | Video URL | Error |',
      '|---|---|---|---|---|'
    );

    for (const c of flowGeneration.clipOutputs) {
      const statusIcon = c.status === 'completed' ? '✅' : c.status === 'failed' ? '❌' : '⏭️';
      const localPath = c.localVideoPath ? `\`${path.basename(c.localVideoPath)}\`` : 'N/A';
      const videoLink = c.videoUrl ? `[MP4 Stream](${c.videoUrl})` : 'N/A';
      const errorMsg = c.error ? `\`${c.error}\`` : '-';
      lines.push(`| **Clip ${c.clipIndex}** | ${statusIcon} \`${c.status}\` | ${localPath} | ${videoLink} | ${errorMsg} |`);
    }
  } else {
    lines.push('*(Flow generation was skipped via CLI options)*');
  }

  lines.push(
    '',
    '---',
    '',
    '## 9. AI Commentary / Tutorial Video (解说视频)',
    ''
  );

  if (tutorial) {
    lines.push(
      `- **Tutorial Video:** \`${path.basename(tutorial.videoPath)}\` (${tutorial.sceneCount} scenes incl. title pages, ${tutorial.totalDurationSec.toFixed(1)}s @ ${tutorial.fps}fps, ${tutorial.resolution.width}x${tutorial.resolution.height})`,
      `- **Player:** \`${path.basename(tutorial.playerPath)}\` (interactive preview + deterministic frame render)`,
      `- **Storyboard:** \`${path.basename(tutorial.storyboardPath)}\` (LLM 旁白 + 分镜数组)`,
      `- **Narration:** \`${path.basename(tutorial.narrationPath)}\` (edge-tts \`${tutorial.voice}\`, rate \`${tutorial.rate}\`, lang \`${tutorial.narrationLanguage}\`)`,
      `- **Materials:** ${tutorial.assetsCount} assets (generation prompts, generated videos & images, lucide icons)`,
      `- **Frames Rendered:** ${tutorial.framesRendered}`,
      ...(tutorial.gridPath ? [`- **Grid Preview:** \`${path.basename(tutorial.gridPath)}\``, ''] : ['']),
      ...(tutorial.gridPath ? [`![Tutorial Video Grid](${path.relative(outDir, tutorial.gridPath).split(path.sep).join('/')})`, ''] : []),
    );

    for (const [idx, scene] of (tutorial.sceneOutline || []).entries()) {
      if (scene.type === 'title') {
        const card = scene.titleCard;
        lines.push(
          `### Scene ${idx + 1} [标题页]: ${card ? `${card.kicker} — ${card.heading}` : scene.title || scene.sceneId}`,
          `- **旁白 (narration):** *"${scene.narration}"*`,
          card?.subheading ? `- **Subheading:** ${card.subheading}` : '',
          ''
        );
        continue;
      }
      const layout = (scene.columns || [])
        .map((column) => `${column.role} ${column.widthPercent}% (${column.detail})`)
        .join(' | ');
      lines.push(
        `### Scene ${idx + 1}: ${scene.title || scene.sceneId}`,
        ...(scene.titleCard
          ? [`- **标题页 (brief title card):** ${scene.titleCard.kicker} — ${scene.titleCard.heading}`]
          : []),
        `- **旁白 (narration):** *"${scene.narration}"*`,
        `- **Layout:** ${layout}`,
        ''
      );
    }
  } else {
    lines.push('*(Tutorial video generation was skipped or did not complete)*');
  }

  lines.push(
    '',
    '---',
    '',
    '## 10. Artifact Manifest',
    '',
    'All run outputs and intermediate assets are structured in the run directory:',
    '',
    '```',
    `${shortPath(outDir)}/`,
    '├── FINAL_REPORT.md             # This comprehensive execution report',
    '├── final-report.json           # Machine-readable pipeline execution summary',
    '├── 9-flow-video-script.json    # Veo multi-clip prompt specifications',
    '├── 5-evaluation-standard.json  # Canonical 3-round standard with SHA-256 hash',
    '├── 9-research-result.json      # Unified research output contract',
    '├── 7-candidate-evaluations.json # Multi-candidate rubric scoring matrix',
    '├── 7-selection-decision.json   # Deterministic winner selection rationale',
    '├── 4-transcript.json           # Cleaned WebVTT subtitle cues',
    '├── 8-segments.json             # Transcript scene segmentation (~120s scenes)',
    '├── run.log                     # Human-readable pipeline execution log',
    '├── run.jsonl                   # Structured NDJSON telemetry events',
    '├── reference-video/            # YouTube winner reference video (used for scene slicing & prompt OCR)',
    '├── frames/                     # Scene transition frames & contact-sheet grids',
    '├── prompt-frames/              # Located AI prompt keyframes & OCR text recognition',
    '├── generated-clips/            # Google Flow AI synthesized MP4 video clips (clip-001.mp4 ...)',
    '├── 10-tutorial-storyboard.json # LLM tutorial storyboard (旁白 + 分镜数组)',
    '└── tutorial/                   # Tutorial player bundle, narration audio and tutorial-video.mp4',
    '```',
    '',
    '---',
    `*Generated automatically by AI Viral Video Pipeline CLI at ${completedAt}*`
  );

  return lines.join('\n');
}

/**
 * Generates the formatted JSON string representing the complete pipeline result.
 */
export function generateFinalReportJson(result: ViralPipelineResult): string {
  return JSON.stringify(result, null, 2);
}

/**
 * Saves JSON, Markdown and self-contained HTML final report artifacts
 * to the target directory.
 */
export async function saveFinalReports(
  result: ViralPipelineResult,
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
    title: `AI Viral Video Pipeline Report — ${result.runId}`,
    baseDir: resolvedDir,
  });

  await fs.writeFile(markdownPath, markdownContent, 'utf8');
  await fs.writeFile(jsonPath, jsonContent, 'utf8');
  await fs.writeFile(htmlPath, htmlContent, 'utf8');

  return { jsonPath, markdownPath, htmlPath };
}

/**
 * Backward-compatible aliases for report generation and saving.
 */
export const generateExecutiveMarkdownReport = generateFinalReportMarkdown;
export const generateExecutiveJsonReport = generateFinalReportJson;
export async function saveExecutionReports(
  result: ViralPipelineResult,
  outDir: string
): Promise<{ jsonPath: string; markdownPath: string; mdPath: string; htmlPath: string }> {
  const { jsonPath, markdownPath, htmlPath } = await saveFinalReports(result, outDir);
  return { jsonPath, markdownPath, mdPath: markdownPath, htmlPath };
}

/**
 * Displays an executive terminal summary upon pipeline completion.
 */
export function printExecutiveSummary(result: ViralPipelineResult): void {
  const winner = result.evaluation.winner;
  const elapsed = (result.totalDurationMs / 1000).toFixed(1);

  console.log(pc.bold(pc.green('\n======================================================')));
  console.log(pc.bold(pc.green('   🎬 AI VIRAL VIDEO GENERATION PIPELINE COMPLETE    ')));
  console.log(pc.bold(pc.green('======================================================\n')));

  console.log(`${pc.bold('Query / Topic:')}     ${result.query} (${pc.cyan(result.topic)})`);
  console.log(`${pc.bold('Execution Time:')}    ${elapsed}s total across 12 stages`);
  console.log(`${pc.bold('Run ID:')}            ${result.runId}`);
  console.log(`${pc.bold('Artifacts Directory:')}${result.outDir}\n`);

  console.log(pc.bold(pc.cyan('--- Selected Viral Video Winner ---')));
  console.log(`${pc.bold('Title:')}            ${winner.title}`);
  console.log(`${pc.bold('Video ID:')}         ${winner.videoId}`);
  console.log(`${pc.bold('Channel:')}          ${winner.channelTitle}`);
  console.log(`${pc.bold('URL:')}              ${winner.url}`);
  console.log(
    `${pc.bold('Views / Velocity:')} ${winner.metrics.viewCount.toLocaleString()} views (${winner.metrics.viewsPerDay.toLocaleString()} views/day)`
  );
  console.log(`${pc.bold('Engagement Rate:')}  ${(winner.metrics.engagementRate * 100).toFixed(2)}%`);
  console.log(
    `${pc.bold('Composite Score:')}   ${pc.bold(pc.green(`${result.evaluation.compositeScore.toFixed(2)} / 5.00`))} (${result.evaluation.displayBand})`
  );
  console.log(`${pc.bold('Selection Reason:')}  ${result.evaluation.reason}\n`);

  console.log(pc.bold(pc.cyan('--- Standard & Script Summary ---')));
  console.log(
    `${pc.bold('Standard Hash:')}     ${result.standard.standardHash.slice(0, 16)}... (${result.standard.reused ? pc.yellow('Reused') : pc.green('Newly Distilled')})`
  );
  console.log(`${pc.bold('Standard Reusable:')} ${result.standard.savedPath}`);
  console.log(
    `${pc.bold('Veo Video Script:')}  ${result.generatedScript.totalClips} clips (${result.generatedScript.totalDurationSec}s total, ${result.generatedScript.aspectRatio})`
  );
  console.log(`${pc.bold('Script File:')}        ${result.generatedScript.scriptPath}\n`);

  if (result.flowGeneration) {
    console.log(pc.bold(pc.cyan('--- Google Flow Video Generation ---')));
    if (result.flowProject?.url) {
      console.log(`${pc.bold('Project URL:')}        ${result.flowProject.url}`);
    }
    const fg = result.flowGeneration;
    const mode = fg.dryRun ? pc.yellow('[DRY RUN]') : pc.green('[SYNTHESIZED]');
    console.log(`${pc.bold('Synthesis Status:')}   ${mode} ${fg.completedClips}/${fg.totalClips} clips completed`);
    if (fg.failedClips > 0) {
      console.log(`${pc.bold('Failed Clips:')}       ${pc.red(String(fg.failedClips))}`);
    }
    console.log();
  }

  console.log(pc.bold(pc.magenta('Reports Generated:')));
  console.log(` ${pc.dim('•')} Markdown Report: ${pc.bold(result.reportMarkdownPath)}`);
  console.log(` ${pc.dim('•')} HTML Report:     ${pc.bold(result.reportHtmlPath)}`);
  console.log(` ${pc.dim('•')} JSON Summary:    ${pc.bold(result.reportJsonPath)}\n`);
}
