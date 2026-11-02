import { Command } from 'commander';
import pc from 'picocolors';
import { executeXDevPipeline, xdevPipeline } from './execute.js';
import { XDevPipelineOptionsSchema, resolvePublishMode, type XDevPipelineOptions } from './contracts.js';

export function attachXDevOptions(cmd: Command): Command {
  return cmd
    .option(
      '-l, --list-url <url>',
      'Target X list URL',
      'https://x.com/i/lists/2116506406241325379'
    )
    .option('--firefox-binary <path>', 'Firefox ESR binary path', '/usr/bin/firefox-esr')
    .option('--headed', 'Run browser in headed mode (default is headless)', false)
    .option('--max-tweets <number>', 'Maximum number of tweets to collect', '20')
    .option('--scroll-rounds <number>', 'Number of scroll iterations to load tweets', '4')
    .option('--cookies-path <path>', 'Cookies JSON path', 'x_cookies.json')
    .option('--output-dir <path>', 'Artifact output directory', 'artifacts/xdev')
    .option('--no-fetch-blogs', 'Skip fetching full text of external blogs')
    .option('--no-publish-to-x', 'Skip auto publishing native Article to X')
    .option('--publish', 'Click Publish in the X Article editor (default: fill a DRAFT and stop)', false)
    .option('--draft-only', 'Force DRAFT even if --publish/--publish-mode publish is given (default is already draft)', false)
    .option('--publish-mode <mode>', "'draft' (default) or 'publish'")
    .option('--min-views <number>', 'Minimum views required for candidate tweets', '1000')
    .option('--tweets-per-keyword <number>', 'Valid tweets to collect per search keyword', '10')
    .option('--keywords <words...>', 'Search keywords for tweet scraping');
}

export async function handleXDevCommand(opts: any): Promise<void> {
  console.log(pc.bold(pc.cyan('\n🚀 Starting XDev Multi-Agent Pipeline (Firefox BiDi)\n')));

  const publishMode = resolvePublishMode({
    draftOnly: opts.draftOnly === true,
    publish: opts.publish === true,
    publishMode: opts.publishMode,
  });
  console.log(
    publishMode === 'draft'
      ? pc.yellow('  Article target: DRAFT — the X Article editor is filled and verified, nothing is published.')
      : pc.magenta('  Article target: PUBLISH — this run will click Publish on X.')
  );

  const parsedOptions: XDevPipelineOptions = XDevPipelineOptionsSchema.parse({
    listUrl: opts.listUrl,
    firefoxBinary: opts.firefoxBinary,
    headless: !opts.headed,
    maxTweets: parseInt(opts.maxTweets, 10),
    scrollRounds: parseInt(opts.scrollRounds, 10),
    cookiesPath: opts.cookiesPath,
    outputDir: opts.outputDir,
    fetchBlogs: opts.fetchBlogs !== false,
    publishToX: opts.publishToX !== false,
    publishMode,
    minViews: parseInt(opts.minViews ?? '1000', 10),
    tweetsPerKeyword: parseInt(opts.tweetsPerKeyword ?? '10', 10),
    keywords: opts.keywords && opts.keywords.length ? opts.keywords : ['Agent system', 'Agent orchestration'],
  });

  const result = await executeXDevPipeline(parsedOptions);

  if (!result.success) {
    console.error(pc.red(`\nxdev Pipeline failed: ${result.error}`));
    process.exitCode = 1;
    return;
  }

  if (xdevPipeline.reports?.printSummary) {
    xdevPipeline.reports.printSummary(result);
  }
}
