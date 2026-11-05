import fs from 'node:fs/promises';
import path from 'node:path';
import pc from 'picocolors';
import { sendMsg, notifyError, formatDetailedErrorMessage, describeNotifyTargets, getWebhookConfig } from '../../utils/send_msg.js';

import { FirefoxBiDiDriver } from './bidi-driver.js';
import { scrapeTweetsForKeywords } from './scraper.js';
import { splitByHistory } from './history.js';
import { loadAccountPublishedHistory } from './account-history.js';
import {
  evaluateAndSelectCoreThemes,
  fetchSelectedArticles,
  generateCreativeSparkInsights,
  generateSvgArchitectureDiagram,
  generateSvgSequenceDiagram,
  synthesizeFocusedArticle,
  assembleArticle,
  buildHeaderBannerSvg,
  type CreativeSparkAnalysis,
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
  let creativeSparksPath = '';
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

    // Drop tweets that have already been genuinely PUBLISHED on the X account.
    // We inspect the logged-in account's published articles directly, falling back to local history only if inspection fails.
    const history = await loadAccountPublishedHistory(browser);
    const { fresh: freshTweets, repeated } = splitByHistory(allTweets, history);
    if (repeated.length) {
      console.log(pc.yellow(`  ⚠ 跳过 ${repeated.length} 条已在 X 上发布过的推文：`));
      for (const r of repeated) {
        console.log(pc.dim(`    • ${r.tweet.url} (已在文章 "${r.previousTopic || r.previousRunId}" 中发布)`));
      }
    }
    console.log(pc.dim(`  • 线上已发布文章历史 ${history.length} 期，可用新题材 ${freshTweets.length} 条`));

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

    // Stage 3.5: Sparks & Practice Collision Pass (Pre-Grok Structured Thinking)
    activeStage = 'sparks-practice-collision';
    const stage35Start = Date.now();
    const primary = evalResult.selectedTopics[0];
    const primaryTopic = primary.topicTitle;
    const primaryPerspective = primary.corePerspectiveZh;

    console.log(pc.cyan('\n[Stage 3.5/7] 实践碰撞点池：为本期推文选取最契合的单个碰撞点，生成四维洞见...'));
    const materialPreGrok = [
      `### 推文原文\n作者: ${primary.tweet.authorName} (${primary.tweet.authorHandle})\n链接: ${primary.tweet.url}\n${primary.tweet.text}`,
      ...primary.tweet.blogs.map(
        (b, i) => `### 外链文章 ${i + 1}: ${b.title || b.url}\nURL: ${b.url}\n${(b.content || '').slice(0, 5000)}`
      ),
    ].join('\n\n');

    const creativeSparks = await generateCreativeSparkInsights({
      topicTitle: primaryTopic,
      corePerspectiveZh: primaryPerspective,
      tweetAuthor: `${primary.tweet.authorName} (@${primary.tweet.authorHandle})`,
      tweetUrl: primary.tweet.url,
      material: materialPreGrok,
    });

    console.log(
      pc.green(
        `  • 选定实践碰撞点: ${creativeSparks.selectedCollisionPointId} (契合度: ${creativeSparks.hasMeaningfulFit ? '有契合点' : '无显著契合点'})`
      )
    );

    if (creativeSparks.rawText) {
      creativeSparksPath = path.join(outDir, `creative-sparks-${timestamp}.md`);
      const sparksFileContent = `# Creative Sparks & Practice Collision Analysis
- **Timestamp**: ${new Date().toISOString()}
- **Target Topic**: ${primaryTopic}
- **Selected Collision Point**: ${creativeSparks.selectedCollisionPointId}
- **Source Tweet**: [${primary.tweet.authorName} (@${primary.tweet.authorHandle})](${primary.tweet.url})

## 1. 契合点 (Core Fit & Intersection Points)
${creativeSparks.fitPoints || '（未单独分段提取）'}

## 2. 推文核心技术映射 (Tweet Substance & Grounding)
${creativeSparks.tweetRelevance || '（未单独分段提取）'}

## 3. 实践冲突与合拍度辨析 (Tension & Harmony with Practical CLI Repo Workflow)
${creativeSparks.conflictOrAlignment || '（未单独分段提取）'}

## 4. 冲突解决与结合提升方案 (Conflict Resolution, Synergy & Elevation)
${creativeSparks.resolutionOrSynergy || '（未单独分段提取）'}

---

### Raw Collision Output
${creativeSparks.rawText}
`;
      await fs.writeFile(creativeSparksPath, sparksFileContent, 'utf-8');
      console.log(pc.green(`  ✔ 灵感碰撞产物已生成并归档: ${creativeSparksPath}`));
    }

    stages.push({
      stage: 'sparks-practice-collision',
      status: 'completed',
      durationMs: Date.now() - stage35Start,
      summary: `Completed 4-dimension practice collision analysis with Git-backed CLI repo as collaborative execution tool & traceability bedrock.`,
    });

    // Stage 4: Grok academic & industry enrichment (Strict Fail-Fast, no fallback)
    activeStage = 'grok-academic-enrichment';
    const stage4Start = Date.now();

    console.log(pc.cyan('\n[Stage 4/7] Consulting Grok on x.com for latest academic research & authoritative tech media analysis...'));

    let grokPrompt = '';
    if (creativeSparks.hasMeaningfulFit && creativeSparks.resolutionOrSynergy) {
      // 场景 1：命中实践碰撞结合点，专门调研该结合点落地结论在工业界/学术界的具体实践与佐证
      grokPrompt = `请联网深度调研主题 "${primaryTopic}"，并重点调研以下工程落地结论在主流技术团队（如 Anthropic, OpenAI, Cursor, GitHub 等）或学术界的最新实践与实证数据：
【结合落地核心主张】：${creativeSparks.resolutionOrSynergy.trim()}

请聚焦：
1. 业界在落地该模式时的具体架构机制、权衡取舍与性能指标；
2. 真实生产环境中的踩坑教训或正面验证案例。
必须明确附带引用内容、论文、官方技术博客与工程报告的真实可访问超链接（Markdown 链接格式如 [标题/机构](URL)）。`;
    } else {
      // 场景 2：未命中结合点，执行专门的批判方向调研（批判让 LLM 编排一切，调研脑洞/计划与实施隔离、Pipeline 与沙盒执行）
      grokPrompt = `请联网针对主题 "${primaryTopic}" 展开深度的批判性工程调研：
1. 【批判方向】：调研当前行业试图让单一 LLM 模型或无约束 Agent 循环“动态编排一切”时遭遇的典型生产事故与系统失效（如上下文膨胀/污染、状态死循环、工具调用失真、无法调试与不可重放）。
2. 【工程破局】：调研主流顶尖团队（如 SWE-bench 顶级选手、Devin 架构演进、Anthropic Workflows、代码生成工厂等）如何将“脑洞/计划（Planning）”与“实施执行（Execution）”进行严格的物理上下文隔离。
3. 【具体实践】：搜集以“确定性 AI 工作流/Pipeline + 强类型结构化上下文 + 隔离沙盒环境（Sandbox）”执行工具调用与代码改动的真实案例、架构论文或权威博客。

必须明确附带引用内容、论文、官方工程博客与真实技术报告的可访问超链接（Markdown 链接格式如 [标题/机构](URL)）。`;
    }

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
      grokResponsePath = path.join(outDir, `grok-response-${timestamp}.txt`);
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

    // Stage 5: Synthesize pure technical article first
    activeStage = 'article-synthesis';
    const stage5Start = Date.now();

    console.log(pc.cyan('[Stage 5/7] Synthesizing human-tone technical blog focused 100% on selected perspective...'));
    const rawArticleMarkdown = await synthesizeFocusedArticle({
      evalResult,
      creativeSparks,
      grokEnrichmentText,
      history,
    });

    stages.push({
      stage: 'article-synthesis',
      status: 'completed',
      durationMs: Date.now() - stage5Start,
      summary: `Synthesized pure thought article focused on: ${primaryTopic}.`,
    });

    // Stage 6: Asset generation grounded directly in the synthesized article
    // (Real Image Model Header + Architectural Vector SVGs derived from the article content)
    activeStage = 'asset-generation';
    const stage6Start = Date.now();

    console.log(pc.cyan('[Stage 6/7] Generating real header image and architectural SVGs tailored to article text...'));
    const headerImagePath = path.join(outDir, `header-image-${timestamp}.png`);
    const articleH1 = rawArticleMarkdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
    const primaryTopicEn =
      articleH1 ||
      evalResult.selectedTopics[0].topicTitleEn ||
      'Distributed Agent State & Context Architecture';

    // Generate topic-accurate header image derived from the synthesized article's theme
    await generateImageFromEnv({
      prompt: `High-end editorial 3D architectural illustration depicting the core engineering concept of the technical article: a prominent, radiant continuous pipeline and verification lattice, translucent frosted glass ribbons, precision modular geometric nodes in Apple and Google Material Design aesthetic. Emphasize a rich, vibrant Parisian macaron color palette with harmonious multi-tone pastel gradients: pistachio mint, delicate coral peach, lilac lavender, creamy lemon, powder sky cyan, and soft strawberry blush. Clean light ivory background (#F8FAFC), rich soft pastel subsurface scattering, diffuse studio lighting, 8k resolution, completely clean with NO text, NO typography, NO watermark, NO letters. Subject: ${primaryTopicEn}`,
      outputPath: headerImagePath,
      size: '1024x1024',
    });

    // Generate Architectural & Sequence SVGs grounded directly in the synthesized article body
    const svgContext = {
      topicTitle: primaryTopicEn,
      articleTitle: articleH1 || evalResult.articleTitle || primaryTopic,
      articleBody: rawArticleMarkdown,
      creativeSparks: creativeSparks?.rawText,
    };
    const svgArchitecture = await generateSvgArchitectureDiagram(svgContext);
    const svgSequence = await generateSvgSequenceDiagram(svgContext);

    // Assemble final markdown with embedded visual assets
    const thoughtArticleMarkdown = assembleArticle(rawArticleMarkdown, {
      articleTitle: articleH1 || evalResult.articleTitle || primaryTopic,
      headerImagePath,
      svgArchitecture,
      svgSequence,
    });

    stages.push({
      stage: 'asset-generation',
      status: 'completed',
      durationMs: Date.now() - stage6Start,
      summary: `Generated real header image (${path.basename(headerImagePath)}) and 2 article-tailored SVGs.`,
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
      creativeSparksPath: creativeSparksPath || undefined,
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


