import path from 'node:path';
import type { XHotFullResult } from './contracts.js';

export function generateXHotMarkdown(result: XHotFullResult): string {
  const lines: string[] = [];

  lines.push(`# Xhot Pipeline Execution Report`);
  lines.push(``);
  lines.push(`- **Pipeline:** \`xhot\``);
  lines.push(`- **Run ID:** \`${result.runId}\``);
  lines.push(`- **Query Topic:** "${result.query}"`);
  lines.push(`- **Started At:** ${result.startedAt}`);
  lines.push(`- **Completed At:** ${result.completedAt}`);
  lines.push(`- **Total Duration:** ${(result.totalDurationMs / 1000).toFixed(1)}s`);
  lines.push(``);

  if (result.winner) {
    lines.push(`## 🏆 Winner: ${result.winner.name}`);
    lines.push(``);
    lines.push(`- **Summary:** ${result.winner.summary}`);
    lines.push(`- **Why it Won:** ${result.winner.reason}`);
    lines.push(``);
  }

  if (result.topCandidates && result.topCandidates.length > 0) {
    lines.push(`## 📊 Top 3 Candidates`);
    lines.push(``);
    for (const c of result.topCandidates) {
      lines.push(`### #${c.rank} ${c.name}`);
      lines.push(`- **Summary:** ${c.summary}`);
      lines.push(`- **Rationale:** ${c.reason}`);
      lines.push(``);
    }
  }

  if (result.gridImagePath) {
    lines.push(`## 🖼️ Candidate Matrix Grid`);
    lines.push(``);
    lines.push(`\`${path.basename(result.gridImagePath)}\``);
    lines.push(``);
  }

  if (result.harvestResult) {
    lines.push(`## 📥 Harvested Community Materials`);
    lines.push(``);
    lines.push(`- **Collected Tweets:** ${result.harvestResult.items.length}`);
    lines.push(`- **Media Files (Images/Videos):** ${result.harvestResult.harvestedMediaCount}`);
    lines.push(`- **Materials Directory:** \`${path.relative(result.outDir, result.harvestResult.materialsDir)}\``);
    lines.push(``);
  }

  const explainer = result.explainer || result.tutorial;
  if (explainer) {
    lines.push(`## 🎬 Explainer Video`);
    lines.push(``);
    lines.push(`- **Video File:** \`${path.basename(explainer.videoPath)}\``);
    lines.push(`- **Duration:** ${explainer.totalDurationSec.toFixed(1)}s @ ${explainer.fps}fps`);
    lines.push(`- **Resolution:** ${explainer.resolution.width}x${explainer.resolution.height}`);
    lines.push(`- **Storyboard Scenes:** ${explainer.sceneCount}`);
    lines.push(`- **Player HTML:** \`${path.basename(explainer.playerPath)}\``);
    lines.push(``);
  }

  return lines.join('\n');
}

export function generateXHotJson(result: XHotFullResult): string {
  return JSON.stringify(result, null, 2);
}

export function printXHotSummary(result: XHotFullResult): void {
  const explainer = result.explainer || result.tutorial;
  console.log(`\n==============================================`);
  console.log(`🔥 XHOT PIPELINE EXECUTION SUMMARY`);
  console.log(`==============================================`);
  console.log(`• Topic:        ${result.query}`);
  if (result.winner) {
    console.log(`• Winner (Top 1): ${result.winner.name}`);
    console.log(`• Summary:      ${result.winner.summary}`);
  }
  if (explainer?.videoPath) {
    console.log(`• Explainer Video: ${explainer.videoPath} (${explainer.totalDurationSec.toFixed(1)}s)`);
  }
  console.log(`• Out Dir:      ${result.outDir}`);
  console.log(`• Duration:     ${(result.totalDurationMs / 1000).toFixed(1)}s`);
  console.log(`==============================================\n`);
}
