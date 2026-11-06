import { z } from 'zod';
import type { StageResult, PipelineStageDef } from '../core/contracts.js';


export class OperationalWarningError extends Error {
  readonly isOperational = true;
  constructor(message: string) {
    super(message);
    this.name = 'OperationalWarningError';
  }
}

export interface ExtractedTweet {
  id: string;
  url: string;
  authorName: string;
  authorHandle: string;
  timestamp?: string;
  text: string;
  views: number;
  externalLinks: string[];
  blogs: ExtractedBlog[];
  isMultiAgentRelated: boolean;
  multiAgentRationale?: string;
  /**
   * Native X long-form post (Article).
   *
   * The timeline card only shows the article TITLE, so without this flag the
   * reviewer scores a 3.1M-view deep dive as if it were a one-line post.
   */
  isXArticle?: boolean;
  /** Permalink of that native article (`https://x.com/<handle>/article/<id>`). */
  articleUrl?: string;
}

export interface ExtractedBlog {
  url: string;
  title?: string;
  content: string;
  excerpt: string;
}

export const XDevPipelineOptionsSchema = z.object({
  listUrl: z.string().url().default('https://x.com/i/lists/2116506406241325379'),
  firefoxBinary: z.string().default('/usr/bin/firefox-esr'),
  headless: z.boolean().default(true),
  maxTweets: z.number().int().positive().default(20),
  scrollRounds: z.number().int().positive().default(4),
  cookiesPath: z.string().default('x_cookies.json'),
  outputDir: z.string().default('artifacts/xdev'),
  fetchBlogs: z.boolean().default(true),
  publishToX: z.boolean().default(true),
  /**
   * 'draft' fills the X Article editor and stops before clicking Publish.
   *
   * Draft is the default: publishing to a public account has to be asked for,
   * not inherited from a bare `npm run xdev`.
   */
  publishMode: z.enum(['draft', 'publish']).default('draft'),
  minViews: z.number().int().nonnegative().default(1000),
  /** Valid (link/article-bearing) tweets to collect per keyword. */
  tweetsPerKeyword: z.number().int().positive().default(10),
  keywords: z.array(z.string()).default(['Agent system', 'Agent orchestration']),
});

export type XDevPipelineOptions = z.infer<typeof XDevPipelineOptionsSchema>;

export interface PublishModeInput {
  /** `--draft-only`: wins over everything, so a stale `--publish` cannot post. */
  draftOnly?: boolean;
  /** `--publish`: the explicit opt-in to click Publish. */
  publish?: boolean;
  /** `--publish-mode <mode>` */
  publishMode?: string;
}

/**
 * Decides whether this run fills a draft or publishes.
 *
 * Pure so the decision can be tested without launching Firefox: the default is
 * draft, `--publish` / `--publish-mode publish` opt in, and `--draft-only`
 * always wins.
 */
export function resolvePublishMode(input: PublishModeInput): 'draft' | 'publish' {
  if (input.draftOnly) return 'draft';
  if (input.publish === true) return 'publish';
  if (input.publishMode === 'publish') return 'publish';
  return 'draft';
}

export interface XDevPipelineResult {
  success: boolean;
  totalTweetsScanned: number;
  filteredAdCount: number;
  filteredRetweetCount: number;
  filteredLowViewsCount?: number;
  analyzedTweets: ExtractedTweet[];
  multiAgentTweets: ExtractedTweet[];
  reportMarkdownPath?: string;
  /** Plain-text archive of every Stage 1 candidate tweet. */
  tweetsDumpPath?: string;
  reportJsonPath?: string;
  thoughtArticlePath?: string;
  thoughtArticleHtmlPath?: string;
  thoughtArticleMarkdown?: string;
  xArticleUrl?: string;
  xArticleEditUrl?: string;
  xArticleScreenshots?: string[];
  grokResponsePath?: string;
  creativeSparksPath?: string;
  stages: StageResult[];
  error?: string;

}

export const XDEV_STAGES: readonly PipelineStageDef[] = [
  { id: 'scrape-and-filter', name: 'Scrape and Hard Filter', description: 'Dual-keyword search (20 posts per keyword) with promoted and no-link filtering' },
  { id: 'llm-eval-selection', name: 'LLM Reviewer Selection', description: 'Score-and-rank candidate tweets, select the most informative 1-2 topics' },
  { id: 'targeted-article-fetch', name: 'Targeted Deep Crawl', description: 'Fetch full articles for selected topics only' },
  { id: 'grok-academic-enrichment', name: 'Grok Academic Enrichment', description: 'Query Grok on x.com for literature and taxonomy' },
  { id: 'asset-generation', name: 'Visual Asset Generation', description: 'Generate SVGs and env IMAGE_MODEL visual diagram' },
  { id: 'article-synthesis', name: 'Deep Article Synthesis', description: 'Synthesize pure technical thought article' },
  { id: 'publish-to-x', name: 'Publish to X Articles', description: 'Fill the native long-form Article editor (draft by default, --publish to publish) with inline images and citations' },
  { id: 'export-and-notify', name: 'Export and Notify', description: 'Mobile HTML export and Telegram dispatch' },
] as const;


