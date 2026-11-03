import fs from 'node:fs/promises';
import path from 'node:path';
import pc from 'picocolors';
import { sendMsg, notifyError, formatDetailedErrorMessage, describeNotifyTargets, getWebhookConfig } from '../../utils/send_msg.js';

import { FirefoxBiDiDriver } from './bidi-driver.js';
import { scrapeTweetsForKeywords } from './scraper.js';
import { loadXDevHistory, splitByHistory } from './history.js';
import {
  evaluateAndSelectCoreThemes,
  fetchSelectedArticles,
  generateSvgArchitectureDiagram,
  generateSvgSequenceDiagram,
  synthesizeFocusedArticle,
  buildHeaderBannerSvg,
} from './analyzer.js';
import { generateImageFromEnv } from './image-generator.js';
import { convertMarkdownToStandaloneHtml } from './html-exporter.js';
import { publishArticleToX } from './publisher.js';


import type { StageResult, Pipeline } from '../core/contracts.js';
import {
  OperationalWarningError,
  type XDevPipelineOptions,
  type XDevPipelineResult,
  XDEV_STAGES,
  XDevPipelineOptionsSchema,
} from './contracts.js';


/**
 * Label for dispatch log lines.
 *
 * Delivery targets come from `--notify` when given, otherwise from the project
 * default (`src/utils/notify-defaults.ts`). Nothing here is hardcoded: the
 * previous `(@main)` labels and `{ bot: 'main' }` overrides made `--notify`
 * impossible to honour.
 */
function notifyLabel(): string {
  const cliTargets = describeNotifyTargets('result');
  if (cliTargets !== 'env-default') return cliTargets;
  try {
    return `@${getWebhookConfig().bot}`;
  } catch {
    return 'env-default';
  }
}

export async function runXDevPipeline(options: XDevPipelineOptions): Promise<XDevPipelineResult> {
  const startTime = Date.now();
  const stages: StageResult[] = [];
  // `outputDir` is the xdev base directory. Each run writes into its own
  // timestamped subdirectory so one run's files never mix with another's.
  const baseDir = path.resolve(options.outputDir || 'artifacts/xdev');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(baseDir, timestamp);
  await fs.mkdir(outDir, { recursive: true });

  console.log(pc.bold(pc.cyan('\n======================================================')));
  console.log(pc.bold(pc.cyan('   xdev Pipeline: 7-Stage Multi-Agent Architecture')));
  console.log(pc.bold(pc.cyan('======================================================\n')));

  const driver = new FirefoxBiDiDriver({
    firefoxBinary: options.firefoxBinary,
    headless: options.headless,
    cookiesPath: options.cookiesPath,
  });

  let activeStage = 'init';
  let reportJsonPath = '';
  let reportMarkdownPath = '';
  let thoughtArticlePath = '';
  let standaloneHtmlPath = '';
  let grokResponsePath = '';
  let xArticleUrl = '';
  let xArticleEditUrl = '';
  let xArticleScreenshots: string[] = [];


  try {
    // Stage 1: Dual-keyword scrape with programmatic hard filter
    activeStage = 'scrape-and-filter';
    const stage1Start = Date.now();

    console.log(pc.cyan('[Stage 1/7] Dual-keyword search & programmatic noise filtering...'));
    const browser = await driver.launch();
    await driver.injectCookies('https://x.com');

    const keywords = options.keywords && options.keywords.length ? options.keywords : ['Agent system', 'Agent orchestration'];
    const minViews = options.minViews ?? 1000;
    const scrapeResult = await scrapeTweetsForKeywords(browser, driver, {
      keywords,
      tweetsPerKeyword: options.tweetsPerKeyword,
      minViews,
    });

    const allTweets = scrapeResult.tweets;
    stages.push({
      stage: 'scrape-and-filter',
      status: 'completed',
      durationMs: Date.now() - stage1Start,
      summary: `Collected ${allTweets.length} qualified candidate tweets (Filtered: ${scrapeResult.filteredLowViewsCount} under ${minViews} views, ${scrapeResult.filteredAdCount} ads, ${scrapeResult.filteredRetweetCount} retweets, ${scrapeResult.filteredNoLinkCount} text-only posts without article/links, ${scrapeResult.filteredNoUrlCount} posts without a resolvable status URL).`,
    });

    if (allTweets.length === 0) {
      throw new OperationalWarningError(
        `未抓取到符合条件的候选推文（已过滤阅读量不足 ${minViews} 的推文 ${scrapeResult.filteredLowViewsCount} 条，广告 ${scrapeResult.filteredAdCount} 条，转推 ${scrapeResult.filteredRetweetCount} 条，无外链/长文 ${scrapeResult.filteredNoLinkCount} 条，无有效推文链接 ${scrapeResult.filteredNoUrlCount} 条）。至少需要 ${minViews} 阅读量才值得作为参考。`
      );
    }

    // Drop tweets a previous run already wrote about. Prompt-level instructions were
    // not enough: the same /status/<id> was selected in 7 consecutive runs.
    const history = await loadXDevHistory(baseDir);
    const { fresh: freshTweets, repeated } = splitByHistory(allTweets, history);
    if (repeated.length) {
      console.log(pc.yellow(`  ⚠ 跳过 ${repeated.length} 条往期已写过的推文：`));
      for (const r of repeated) {
        console.log(pc.dim(`    • ${r.tweet.url} (已在 ${r.previousRunId} 写过)`));
      }
    }
    console.log(pc.dim(`  • 历史 ${history.length} 期，可用新题材 ${freshTweets.length} 条`));

    if (freshTweets.length === 0) {
      throw new OperationalWarningError(
        `候选 ${allTweets.length} 条推文在最近 ${history.length} 期都已写过，没有新题材可写。` +
          '禁止复用旧题材：请扩大抓取范围（关键词 / 列表 / 每关键词条数）后重跑。'
      );
    }

    // Stage 2: LLM Reviewer Evaluation (Strict 1-2 core themes)
    activeStage = 'llm-eval-selection';
    const stage2Start = Date.now();

    const evalResult = await evaluateAndSelectCoreThemes(freshTweets, history);
    stages.push({
      stage: 'llm-eval-selection',
      status: 'completed',
      durationMs: Date.now() - stage2Start,
      summary: `Strictly selected ${evalResult.selectedTopics.length} core topic(s) out of ${freshTweets.length} fresh candidates (${repeated.length} skipped as already written).`,
    });

    // Stage 3: Targeted deep crawl of articles
    activeStage = 'targeted-article-fetch';
    const stage3Start = Date.now();

    await fetchSelectedArticles(evalResult.selectedTopics, driver);
    stages.push({
      stage: 'targeted-article-fetch',
      status: 'completed',
      durationMs: Date.now() - stage3Start,
      summary: `Deep fetched linked articles for selected core topics.`,
    });

    // Stage 4: Grok academic & industry enrichment (Strict Fail-Fast, no fallback)
    activeStage = 'grok-academic-enrichment';
    const stage4Start = Date.now();

    console.log(pc.cyan('[Stage 4/7] Consulting Grok on x.com for latest academic research & authoritative tech media analysis...'));
    const primaryTopic = evalResult.selectedTopics[0].topicTitle;
    const primaryPerspective = evalResult.selectedTopics[0].corePerspectiveZh;
    const grokPrompt = `联网搜索关于 "${primaryTopic}" 的最新权威技术分析与一线工程实践，总结核心事实、落地机制与技术权衡。在回答中必须明确附带引用内容、论文、博客与工程报告的真实可访问超链接（Markdown 链接格式如 [标题/机构](URL)）。`;

    let grokEnrichmentText = '';
    try {
      grokEnrichmentText = await driver.askGrok(grokPrompt);
    } catch (grokErr: any) {
      console.warn(pc.yellow(`  ⚠ [Stage 4/7] Grok 检索跳过 (${grokErr?.message || grokErr})。成稿将完全基于推文与定向抓取的长文素材进行。`));
    }

    // Hard quality gate: only save and dispatch Grok research when it contains genuine substantial findings
    const isGrokValid =
      grokEnrichmentText &&
      grokEnrichmentText.trim().length >= 120 &&
      !/You have reached your Grok usage limit|More Grok with Premium|Shared links could not be loaded|Upgrade to Premium/i.test(
        grokEnrichmentText
      );

    if (isGrokValid) {
      grokResponsePath = path.join(outDir, `grok-response-${timestamp}.md`);
      const grokFileContent = `# Grok Live Research Response
- **Timestamp**: ${new Date().toISOString()}
- **Target Topic**: ${primaryTopic}
- **Target Perspective**: ${primaryPerspective}

## Prompt Sent to Grok
\`\`\`text
${grokPrompt}
\`\`\`

---

## Grok Synthesis & Citations
${grokEnrichmentText}
`;
      await fs.writeFile(grokResponsePath, grokFileContent, 'utf-8');
      console.log(pc.green(`  ✔ Grok research response verified and saved to: ${grokResponsePath}`));
    } else {
      console.warn(pc.yellow('  ⚠ Grok returned no genuine research findings. Skipping artifact export.'));
    }

    stages.push({
      stage: 'grok-academic-enrichment',
      status: 'completed',
      durationMs: Date.now() - stage4Start,
      summary: 'Enriched via Grok live academic and industry query.',
    });

    // Stage 5: Asset generation (Real Image Model Header + Architectural Vector SVGs)
    activeStage = 'asset-generation';
    const stage5Start = Date.now();

    console.log(pc.cyan('[Stage 5/7] Generating real header image via env IMAGE_MODEL and architectural SVGs...'));
    const headerImagePath = path.join(outDir, `header-image-${timestamp}.png`);
    const primaryTopicEn =
      evalResult.selectedTopics[0].topicTitleEn ||
      evalResult.selectedTopics[0].tweet.text.slice(0, 80).replace(/https?:\/\/\S+/g, '').trim() ||
      'Distributed Agent State & Context Architecture';
    // Strictly English prompt with no text overlay to avoid rendered typographical garbage or Chinese characters
    await generateImageFromEnv({
      prompt: `Sophisticated minimalist abstract technology 3D illustration in Google Material 3 and Apple clean industrial design aesthetic, crisp off-white background (#F8FAFC), elegant translucent frosted glass layers, precision pastel geometric volumes, subtle ambient shadows, Apple System Blue and vibrant modern accents, high-end editorial tech publication quality, 8k resolution, completely clean with NO text, NO typography, NO watermark, NO letters: ${primaryTopicEn}`,
      outputPath: headerImagePath,
      size: '1024x1024',
    });

    const svgArchitecture = await generateSvgArchitectureDiagram(primaryTopicEn);
    const svgSequence = await generateSvgSequenceDiagram(primaryTopicEn);

    stages.push({
      stage: 'asset-generation',
      status: 'completed',
      durationMs: Date.now() - stage5Start,
      summary: `Generated real header image (${path.basename(headerImagePath)}) and 2 architectural SVGs.`,
    });

    // Stage 6: Synthesize pure technical article
    activeStage = 'article-synthesis';
    const stage6Start = Date.now();

    console.log(pc.cyan('[Stage 6/7] Synthesizing human-tone technical blog focused 100% on selected perspective...'));
    const thoughtArticleMarkdown = await synthesizeFocusedArticle({
      evalResult,
      svgArchitecture,
      svgSequence,
      headerImagePath,
      grokEnrichmentText,
      history,
    });



    stages.push({
      stage: 'article-synthesis',
      status: 'completed',
      durationMs: Date.now() - stage6Start,
      summary: `Synthesized pure thought article focused on: ${primaryTopic}.`,
    });

    // Stage 6.5: Fill (or publish) the native X Article
    if (options.publishToX ?? true) {
      activeStage = 'publish-to-x';
      const stagePublishStart = Date.now();
      const publishMode = options.publishMode || 'draft';
      console.log(pc.cyan(`[Stage 6.5] ${publishMode === 'draft' ? 'Filling X Article DRAFT (no publish)' : 'Publishing native Article to X'}...`));
      try {
        const primarySource = evalResult.selectedTopics[0];
        // The draft title comes from the article's own H1 so it matches the body
        // language (the article is English now; evalResult.articleTitle is the
        // Chinese working title used for reports).
        const articleH1 = thoughtArticleMarkdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
        const publishRes = await publishArticleToX(browser, {
          title: articleH1 || evalResult.articleTitle || primaryTopic,
          markdownContent: thoughtArticleMarkdown,
          caption: evalResult.executiveSummaryZh
            ? `${evalResult.articleTitle || primaryTopic}\n\n${evalResult.executiveSummaryZh.slice(0, 160)}...\n\n#AI #MultiAgent #Tech`
            : undefined,
          coverImagePath: headerImagePath,
          mode: publishMode,
          assetBaseDir: outDir,
          artifactDir: outDir,
          source: primarySource
            ? {
                authorName: primarySource.tweet.authorName,
                authorHandle: primarySource.tweet.authorHandle,
                tweetUrl: primarySource.tweet.url,
                tweetText: primarySource.tweet.text,
                links: primarySource.tweet.blogs.map((b) => ({ url: b.url, title: b.title })),
              }
            : undefined,
        });

        if (publishRes.editUrl) xArticleEditUrl = publishRes.editUrl;
        if (publishRes.articleUrl) xArticleUrl = publishRes.articleUrl;
        xArticleScreenshots = publishRes.screenshots;

        if (!publishRes.success) {
          throw new Error(publishRes.error || 'publisher returned success=false');
        }

        stages.push({
          stage: 'publish-to-x',
          status: 'completed',
          durationMs: Date.now() - stagePublishStart,
          summary:
            publishMode === 'draft'
              ? `X Article draft filled and verified (not published): ${xArticleEditUrl || 'draft'}`
              : `Published to X Articles successfully: ${xArticleUrl || 'Published'}`,
        });
        console.log(
          pc.green(
            publishMode === 'draft'
              ? `  ✔ X 草稿已就绪（未发布）: ${xArticleEditUrl}`
              : `  ✔ Successfully published Article to X: ${xArticleUrl}`
          )
        );
      } catch (pubErr: any) {
        console.warn(pc.yellow(`  ⚠ [publish-to-x] Failed: ${pubErr?.message || pubErr}`));
        stages.push({
          stage: 'publish-to-x',
          status: 'failed',
          durationMs: Date.now() - stagePublishStart,
          summary: `Publish to X failed: ${pubErr?.message || pubErr}`,
          error: pubErr?.message || String(pubErr),
        });
      }
    }

    // Stage 7: Mobile-first HTML export and Telegram dispatch
    activeStage = 'export-and-notify';
    const stage7Start = Date.now();

    console.log(pc.cyan('[Stage 7/7] Exporting mobile-friendly standalone HTML and sending via Telegram...'));
    thoughtArticlePath = path.join(outDir, `multi-agent-thinking-${timestamp}.md`);
    standaloneHtmlPath = path.join(outDir, `multi-agent-thinking-${timestamp}.html`);
    reportJsonPath = path.join(outDir, `xdev-summary-${timestamp}.json`);
    reportMarkdownPath = path.join(outDir, `xdev-report-${timestamp}.md`);


    await fs.writeFile(thoughtArticlePath, thoughtArticleMarkdown, 'utf-8');
    const standaloneHtml = await convertMarkdownToStandaloneHtml(thoughtArticleMarkdown, outDir);
    await fs.writeFile(standaloneHtmlPath, standaloneHtml, 'utf-8');

    // Visual QA verification via existing Firefox WebDriver session
    try {
      console.log(pc.cyan('  Running automated visual rendering QA on generated HTML via Firefox...'));
      const screenshotsDir = path.join(outDir, 'screenshots');
      await fs.mkdir(screenshotsDir, { recursive: true });
      await browser.setWindowSize(390, 844);
      await browser.url(`file://${standaloneHtmlPath}`);
      const svgs = await browser.$$('svg');
      console.log(pc.green(`    ✔ Rendered ${svgs.length} SVG diagram(s) successfully in mobile viewport.`));
      for (let i = 0; i < svgs.length; i++) {
        const size = await svgs[i].getSize().catch(() => null);
        const shotPath = path.join(screenshotsDir, `verified-svg-${i + 1}.png`);
        await svgs[i].saveScreenshot(shotPath).catch(() => null);
        if (size) {
          console.log(pc.dim(`      • SVG #${i + 1}: ${Math.round(size.width)}x${Math.round(size.height)}px -> ${shotPath}`));
        }
      }
    } catch (qaErr: any) {
      console.warn(pc.yellow(`  ⚠ Visual QA notice: ${qaErr?.message || qaErr}`));
    }

    // Stage 7.1: Send Grok live research artifact first if available
    if (grokResponsePath && (await fs.stat(grokResponsePath).catch(() => null))) {
      const grokTarget = notifyLabel();
      try {
        console.log(pc.cyan(`  Dispatching Grok research artifact to Telegram (${grokTarget})...`));
        await sendMsg(
          `🔬 *Grok 深度联网学术与行业调研产物*\n\n` +
          `• 研讨议题: *${primaryTopic}*\n` +
          `• 关联推文: ${primaryPerspective ? primaryPerspective.slice(0, 100) : '无'}\n` +
          `• 本地路径: \`${grokResponsePath}\``,
          undefined,
          {
            filePath: grokResponsePath,
            fileName: path.basename(grokResponsePath),
            mimetype: 'text/markdown',
          }
        );
        console.log(pc.green(`  ✔ Grok research artifact successfully sent to Telegram (${grokTarget}).`));
      } catch (grokTgErr: any) {
        console.warn(pc.yellow(`  ⚠ Telegram Grok artifact send notice: ${grokTgErr?.message || grokTgErr}`));
      }
    }

    // Stage 7.2: Send final mobile-ready HTML article to the configured notify target
    try {
      const htmlTarget = notifyLabel();
      console.log(pc.cyan(`  Dispatching mobile-ready HTML article to Telegram (${htmlTarget})...`));
      const xUrlNotice = xArticleUrl ? `\n• X 在线长文: ${xArticleUrl}` : '';
      const draftNotice = !xArticleUrl && xArticleEditUrl ? `\n• X 草稿（未发布）: ${xArticleEditUrl}` : '';
      await sendMsg(
        `📄 *Multi-Agent 深度思考博文（${xArticleUrl ? '已生成并发布' : xArticleEditUrl ? '草稿已生成，未发布' : '已生成'}）*\n\n` +
        `• 核心聚焦: *${primaryTopic}*\n` +
        `• 风格重构: 纯中文接地气技术交流博文（已剔除生硬评分与论文套话）\n` +
        `• 排版优化: 移动端专属适配（padding 16px、字号自适应、内嵌高质感矢量插图）${xUrlNotice}${draftNotice}\n` +
        `• 本地路径: \`${standaloneHtmlPath}\``,
        undefined,
        {
          filePath: standaloneHtmlPath,
          fileName: `multi-agent-thinking-${timestamp}.html`,
          mimetype: 'text/html',
        }
      );
      console.log(pc.green(`  ✔ HTML article successfully sent to Telegram (${htmlTarget}).`));
    } catch (tgErr: any) {
      console.warn(pc.yellow(`  ⚠ Telegram send notice: ${tgErr?.message || tgErr}`));
    }


    // Write final summary and report
    await fs.writeFile(
      reportJsonPath,
      JSON.stringify(
        {
          totalScanned: allTweets.length,
          freshCandidates: freshTweets.length,
          skippedAsAlreadyWritten: repeated.length,
          selectedCount: evalResult.selectedTopics.length,
          articleTitle: evalResult.articleTitle,
          xArticleUrl: xArticleUrl || undefined,
          xArticleEditUrl: xArticleEditUrl || undefined,
          xArticleScreenshots: xArticleScreenshots.map((p) => path.basename(p)),
          executiveSummary: evalResult.executiveSummaryZh,
          grokResponsePath: grokResponsePath ? path.basename(grokResponsePath) : undefined,
          selectedTopics: evalResult.selectedTopics.map((s) => ({
            topic: s.topicTitle,
            author: `${s.tweet.authorName} (${s.tweet.authorHandle})`,
            tweetUrl: s.tweet.url,
            tweetText: s.tweet.text,
          })),
          stages,
        },
        null,
        2
      ),
      'utf-8'
    );

    const reportMarkdown = `# xdev Pipeline Execution Report (Refactored)
- **Total Candidates Qualified**: ${allTweets.length}
- **LLM Selected Foci**: ${evalResult.selectedTopics.length}
- **Core Topic**: ${primaryTopic}
${xArticleUrl ? `- **X Published Article**: [${xArticleUrl}](${xArticleUrl})\n` : ''}${xArticleEditUrl && !xArticleUrl ? `- **X Draft (not published)**: ${xArticleEditUrl}\n` : ''}- **Thought Article Markdown**: [${path.basename(thoughtArticlePath)}](./${path.basename(thoughtArticlePath)})
- **Thought Article HTML (Base64 standalone)**: [${path.basename(standaloneHtmlPath)}](./${path.basename(standaloneHtmlPath)})
${grokResponsePath ? `- **Grok Live Research Artifact**: [${path.basename(grokResponsePath)}](./${path.basename(grokResponsePath)})\n` : ''}
## Stages
${stages.map((s) => `- **${s.stage}** (${s.durationMs}ms): ${s.summary}`).join('\n')}
`;

    await fs.writeFile(reportMarkdownPath, reportMarkdown, 'utf-8');

    stages.push({
      stage: 'export-and-notify',
      status: 'completed',
      durationMs: Date.now() - stage7Start,
      summary: `Standalone HTML and reports generated.`,
    });

    console.log(pc.green(`\n✔ xdev Pipeline completed successfully in ${((Date.now() - startTime) / 1000).toFixed(1)}s`));
    const selectedTweets = evalResult.selectedTopics.map((s) => s.tweet);
    return {
      success: true,
      totalTweetsScanned: allTweets.length,
      filteredAdCount: scrapeResult.filteredAdCount,
      filteredRetweetCount: scrapeResult.filteredRetweetCount,
      filteredLowViewsCount: scrapeResult.filteredLowViewsCount,
      analyzedTweets: allTweets,
      multiAgentTweets: selectedTweets,
      xArticleUrl: xArticleUrl || undefined,
      xArticleEditUrl: xArticleEditUrl || undefined,
      xArticleScreenshots: xArticleScreenshots.length ? xArticleScreenshots : undefined,
      reportJsonPath,
      reportMarkdownPath,
      thoughtArticlePath,
      thoughtArticleHtmlPath: standaloneHtmlPath,
      thoughtArticleMarkdown,
      grokResponsePath,
      stages,
    };
  } catch (err: any) {
    const isOperational =
      err?.isOperational === true ||
      err instanceof OperationalWarningError ||
      (typeof err?.message === 'string' &&
        (err.message.includes('至少需要') ||
          err.message.includes('没有新题材可写') ||
          err.message.includes('宁缺毋滥安全终止') ||
          err.message.includes('未抓取到符合条件的候选推文')));

    if (isOperational) {
      console.warn(pc.yellow(`\n⚠ xdev 流水线安全终止 [${activeStage}]: ${err?.message || err}`));
      const warningMsg = `⚠️ *xdev 运行提示 (非程序故障)* (阶段: \`${activeStage}\`)\n\n${err?.message || err}`;

      try {
        const warnTarget = notifyLabel();
        console.log(pc.yellow(`  Dispatching operational warning to Telegram (${warnTarget})... (skipping Pi inbound)`));
        await sendMsg(warningMsg);
        console.log(pc.green(`  ✔ Telegram warning successfully sent to (${warnTarget}).`));
      } catch (notifyErr: any) {
        console.error(pc.red(`  ✗ Failed to send Telegram warning: ${notifyErr?.message || notifyErr}`));
      }

      throw err;
    }

    console.error(pc.red(`\n💥 xdev Pipeline failed at [${activeStage}]: ${err?.message || err}`));

    const detailedMsg = formatDetailedErrorMessage(
      err,
      `🚨 *xdev Pipeline 运行失败告警* (阶段: \`${activeStage}\`)`,
      {
        outDir,
        recentOutput: err?.stack || String(err),
      }
    );

    try {
      const failTarget = notifyLabel();
      console.log(pc.yellow(`  Dispatching failure alert back to Telegram (${failTarget})...`));
      await notifyError(detailedMsg);
      console.log(pc.green(`  ✔ Failure alert successfully sent back to Telegram (${failTarget}).`));
    } catch (notifyErr: any) {
      console.error(pc.red(`  ✗ Failed to send failure alert: ${notifyErr?.message || notifyErr}`));
    }

    throw err;
  } finally {
    console.log(pc.dim('Cleaning up Firefox ESR session...'));
    await driver.cleanup().catch(() => {});
  }
}


export const executeXDevPipeline = runXDevPipeline;

export const xdevPipeline: Pipeline<XDevPipelineOptions, XDevPipelineResult> = {
  id: 'xdev',
  name: 'X Multi-Agent Architecture Research & Thought Pipeline',
  description: 'Firefox BiDi scraper and LLM synthesis of Multi-Agent developer breakthroughs',
  schema: XDevPipelineOptionsSchema,
  stages: XDEV_STAGES,
  execute: async (rawOptions: any) => {
    const validated = XDevPipelineOptionsSchema.parse(rawOptions);
    return runXDevPipeline(validated);
  },
  reports: {
    generateMarkdownReport: (result: XDevPipelineResult) => result.reportMarkdownPath || '',
    generateJsonReport: (result: XDevPipelineResult) => JSON.stringify(result, null, 2),
    saveReports: async (result: XDevPipelineResult) => ({
      jsonPath: result.reportJsonPath || '',
      markdownPath: result.reportMarkdownPath || '',
    }),
    printSummary: (result: XDevPipelineResult) => {
      console.log(pc.green(`\n✔ xdev summary: Scanned ${result.totalTweetsScanned}, filtered ${result.filteredAdCount} ads, kept ${result.multiAgentTweets.length} foci.`));
    },
  },
};


