import type { Browser } from 'webdriverio';
import pc from 'picocolors';
import type { ExtractedTweet } from './contracts.js';
import type { FirefoxBiDiDriver } from './bidi-driver.js';
import { buildXSearchUrl, isCjkDominated, normalizeSearchQuery } from '../../libs/text/index.js';

// Re-exported for backward compatibility with existing callers/tests.
export { normalizeSearchQuery };

export interface KeywordScraperOptions {
  keywords: string[];
  tweetsPerKeyword: number;
  minViews?: number;
  listUrl?: string;
  /**
   * Language operator appended to every keyword (`en` by default).
   * `null` disables it — required for non-English topics.
   */
  /**
   * Language operator appended to every keyword. Default `null` = no operator.
   *
   * A/B measured on 2026-11-06 against the real Top feed:
   *   q=Agent system                 → DeepSeekHarness/2116857257245987236 at #1
   *   q=Agent system lang:en         → the same post is GONE from the feed
   * X's lang filter silently removes the top-ranked post of a keyword, so the
   * default must not apply it. Language control belongs to the material/output
   * layer (see the article English gate), not to the search query.
   * `--search-lang en` still opts in, and only then does the CJK backstop run.
   */
  searchLang?: string | null;
}

export interface ScrapedKeywordResult {
  tweets: ExtractedTweet[];
  filteredAdCount: number;
  filteredRetweetCount: number;
  filteredNoLinkCount: number;
  filteredLowViewsCount: number;
  filteredNoUrlCount: number;
  /** Tweets dropped by the CJK backstop when `searchLang === 'en'`. */
  filteredNonEnglishCount: number;
  totalFound: number;
}

/**
 * Parses Twitter/X view/impression metric string into an integer.
 * Handles:
 *  - "1,234" -> 1234
 *  - "2.5K" / "2.5k views" / "2,450 views. View post analytics" -> 2500 / 2450
 *  - "1.2万" / "1.2万次查看" -> 12000
 *  - "1.5M" -> 1500000
 *  - "1B" -> 1000000000
 *  - "1.2亿" -> 120000000
 * Returns 0 if no numeric count is present.
 */
export function parseTweetViews(text?: string | null): number {
  if (!text) return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;

  const explicitMatch = trimmed.match(
    /([\d]+(?:,\d{3})*(?:\.\d+)?|[\d]+(?:\.\d+)?)\s*([KkMmBb万wW亿])?\s*(?:views?|次查看|次浏览|次播放)?/i
  );
  if (!explicitMatch) return 0;

  const rawNum = explicitMatch[1].replace(/,/g, '');
  const num = parseFloat(rawNum);
  if (isNaN(num)) return 0;

  const mult = explicitMatch[2]?.toUpperCase();
  if (mult === 'K') return Math.round(num * 1_000);
  if (mult === 'W' || mult === '万') return Math.round(num * 10_000);
  if (mult === 'M') return Math.round(num * 1_000_000);
  if (mult === 'B') return Math.round(num * 1_000_000_000);
  if (mult === '亿') return Math.round(num * 100_000_000);

  return Math.round(num);
}

/**
 * X answers a throttled/blocked search with an empty timeline plus this
 * banner. Treating that as "no candidates" produced a misleading
 * "未抓取到符合条件的候选推文" after a 60s sweep of nothing.
 */
const SEARCH_BLOCK_BANNER = /Something went wrong\. Try reloading\.|Rate limit exceeded/i;

async function detectSearchBlock(browser: Browser): Promise<string | null> {
  try {
    const banner = await browser.execute((pattern: string) => {
      const text = document.body.innerText || '';
      const re = new RegExp(pattern, 'i');
      const match = re.exec(text);
      return match ? match[0] : null;
    }, SEARCH_BLOCK_BANNER.source);
    return typeof banner === 'string' ? banner : null;
  } catch {
    return null;
  }
}

/**
 * Waits until the feed renders at least one tweet article.
 */
async function waitForTweets(browser: Browser, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const count = await browser.execute(() => document.querySelectorAll('article[data-testid="tweet"]').length);
      if (count > 0) return true;
    } catch {
      // ignore
    }
    await browser.pause(600);
  }
  return false;
}

export async function scrapeTweetsForKeywords(
  browser: Browser,
  _driver: FirefoxBiDiDriver,
  options: KeywordScraperOptions
): Promise<ScrapedKeywordResult> {
  let filteredAdCount = 0;
  let filteredRetweetCount = 0;
  let filteredNoLinkCount = 0;
  let filteredLowViewsCount = 0;
  let filteredNoUrlCount = 0;
  let filteredNonEnglishCount = 0;
  const minViews = options.minViews ?? 1000;
  const searchLang = options.searchLang === undefined ? null : options.searchLang;
  const tweetMap = new Map<string, ExtractedTweet>();
  // Tweets rejected by the view/link filters must never be re-processed on the
  // next scroll round: without this the same low-view post is re-parsed (and
  // re-logged) on every iteration, which stalls the sweep.
  const seenTweetIds = new Set<string>();

  console.log(
    pc.dim(
      `  • 搜索语言过滤: ${searchLang ? `lang:${searchLang}（同时开启 CJK 兜底）` : '关闭（X 的 lang: 过滤会漏掉 Top 首位帖子；需要时用 --search-lang en 显式开启）'}`
    )
  );

  console.log(
    pc.dim(
      `  • 搜索语言过滤: ${searchLang ? `lang:${searchLang}（同时开启 CJK 兜底）` : '关闭（X 的 lang: 过滤会漏掉 Top 首位帖子；需要时用 --search-lang en 显式开启）'}`
    )
  );

  const buildResult = (): ScrapedKeywordResult => {
    const tweetList = Array.from(tweetMap.values());
    return {
      tweets: tweetList,
      filteredAdCount,
      filteredRetweetCount,
      filteredNoLinkCount,
      filteredLowViewsCount,
      filteredNoUrlCount,
      filteredNonEnglishCount,
      totalFound: tweetList.length,
    };
  };

  for (const rawKeyword of options.keywords) {
    const keyword = normalizeSearchQuery(rawKeyword, { lang: searchLang });
    console.log(`\n🔍 Searching X for query: "${keyword}" (target: ${options.tweetsPerKeyword} valid posts with links/articles)...`);
    let collectedForThisKeyword = 0;
    const maxScrolls = Math.max(12, Math.ceil(options.tweetsPerKeyword * 0.75) + 8);

    // Sweep the Top (f=top) feed first. Only the Top feed surfaces posts with
    // enough impressions to clear minViews — a Latest-only sweep is dominated by
    // fresh zero-view posts and can never satisfy the target. Latest (f=live) is
    // used purely as an extension when Top is exhausted (ads / duplicates /
    // no-link posts).
    for (const rank of ['top', 'live'] as const) {
      if (collectedForThisKeyword >= options.tweetsPerKeyword) break;

      const feedLabel = rank === 'top' ? 'Top' : 'Latest';
      const searchUrl = buildXSearchUrl(rawKeyword, rank, searchLang);

      if (rank === 'live') {
        console.log(
          pc.dim(
            `  ↳ [${keyword}] Top 流耗尽 (${collectedForThisKeyword}/${options.tweetsPerKeyword})，扩展到 Latest 流补充`
          )
        );
      }

      console.log(pc.dim(`  → [${keyword}] ${feedLabel} 流: ${searchUrl}`));
      await browser.url(searchUrl);
      const loaded = await waitForTweets(browser, 8000);
      if (!loaded) {
        const block = await detectSearchBlock(browser);
        if (block) {
          const message =
            `[x-search] X 拒绝返回搜索结果（页面提示 "${block}"）— 搜索接口被限流/风控，` +
            `URL: ${searchUrl}。这不是关键词无结果，请稍后重试或更换出口 IP。`;
          console.error(pc.red(`  ✖ ${message}`));
          // Keep whatever was already collected; only abort when the sweep is empty,
          // otherwise a late throttle would throw away valid candidates.
          if (tweetMap.size === 0) throw new Error(message);
          return buildResult();
        }
        console.log(pc.yellow(`  ⚠ [${keyword}] ${feedLabel} 流未即时渲染出推文，继续进入滚动检查`));
      } else {
        // Small buffer to ensure first tweet data/aria attributes are fully hydrated
        await browser.pause(1000);
      }

      let scrollCount = 0;
      while (collectedForThisKeyword < options.tweetsPerKeyword && scrollCount < maxScrolls) {
        scrollCount++;
        const rawArticles = await browser.$$('article[data-testid="tweet"]');

        for (const article of rawArticles) {
          if (collectedForThisKeyword >= options.tweetsPerKeyword) break;

          // 1. Check if it's an ad / promoted tweet
          const isPromoted = await article
            .execute((el) => {
              const text = el.textContent || '';
              return text.includes('Sponsored') || text.includes('Promoted') || text.includes('Ad');
            })
            .catch(() => false);

          if (isPromoted) {
            filteredAdCount++;
            continue;
          }

          // 2. Check if it's a retweet / repost
          let isRetweet = false;
          try {
            const socialContext = await article.$('[data-testid="socialContext"]', { strict: false });
            if (socialContext && (await socialContext.isExisting())) {
              const contextText = (await socialContext.getText()).toLowerCase();
              if (
                contextText.includes('reposted') ||
                contextText.includes('retweeted') ||
                contextText.includes('转推')
              ) {
                isRetweet = true;
              }
            }
          } catch {
            // ignore
          }

          if (isRetweet) {
            filteredRetweetCount++;
            continue;
          }

          // 3. Extract Author details
          let authorName = 'Unknown';
          let authorHandle = '';
          try {
            const userEl = await article.$('[data-testid="User-Name"]', { strict: false });
            if (userEl && (await userEl.isExisting())) {
              const userText = await userEl.getText();
              const lines = userText.split('\n').map((s: string) => s.trim()).filter(Boolean);
              authorName = lines[0] || 'Unknown';
              authorHandle = lines.find((l: string) => l.startsWith('@')) || '';
            }
          } catch {
            // ignore
          }

          // 4. Extract tweet text (support both standard tweets and native X Articles)
          let text = '';
          try {
            const tweetTextEl = await article.$('[data-testid="tweetText"]', { strict: false });
            if (tweetTextEl && (await tweetTextEl.isExisting())) {
              text = await tweetTextEl.getText();
            } else {
              // Native X Articles often do NOT use [data-testid="tweetText"] for their title/preview.
              // Extract from article container text by removing user header and metric tails.
              const rawText = await article.execute((el) => {
                const clone = el.cloneNode(true) as HTMLElement;
                // remove user-name, analytics, social context
                clone.querySelectorAll('[data-testid="User-Name"], [data-testid="socialContext"], a[href*="/analytics"]').forEach((n) => n.remove());
                return clone.innerText || '';
              });
              text = rawText.replace(/\n+/g, ' ').trim();
            }
          } catch {
            // ignore
          }

          if (!text || text.trim().length < 15) {
            continue;
          }

          // 5. Extract Tweet URL & Time.
          // The status permalink must come from the <time> element's closest
          // anchor. On some layouts (notably X Article posts) <time> is wrapped
          // in extra elements, so `timeEl.parentElement()` is not the <a> and the
          // record ended up with an EMPTY url — unusable for citations, the
          // history dedup key, and every downstream stage.
          let timestamp = '';
          let tweetUrl = '';
          let tweetId = '';
          try {
            const statusInfo = await article.execute((el) => {
              const time = el.querySelector('time');
              const datetime = time ? time.getAttribute('datetime') || '' : '';
              const candidates: Element[] = [];
              const fromTime = time ? time.closest('a[href*="/status/"]') : null;
              if (fromTime) candidates.push(fromTime);
              const all = el.querySelectorAll('a[href*="/status/"]');
              for (let i = 0; i < all.length; i++) candidates.push(all[i]);
              for (const a of candidates) {
                const href = a.getAttribute('href') || '';
                // Reject `/status/<id>/analytics`, `/status/<id>/photo/1` etc.
                const m = href.match(/\/([^/]+)\/status\/(\d+)(?:[?#].*)?$/);
                if (!m) continue;
                return { datetime, handle: m[1], id: m[2] };
              }
              return { datetime, handle: '', id: '' };
            });
            timestamp = statusInfo.datetime;
            if (statusInfo.id) {
              tweetId = statusInfo.id;
              tweetUrl = `https://x.com/${statusInfo.handle}/status/${statusInfo.id}`;
            }
          } catch {
            // ignore
          }

          if (!tweetId) {
            filteredNoUrlCount++;
            console.log(pc.dim(`  ↳ Skip tweet without a resolvable status URL: ${text.slice(0, 40)}`));
            continue;
          }

          if (seenTweetIds.has(tweetId)) {
            continue;
          }
          seenTweetIds.add(tweetId);

          // 6. Extract tweet view count & filter by minViews
          const viewMeta = await article
            .execute((el) => {
              const analyticsLink = el.querySelector('a[href*="/analytics"]');
              if (analyticsLink) {
                return {
                  text: analyticsLink.textContent || '',
                  ariaLabel: analyticsLink.getAttribute('aria-label') || '',
                };
              }
              const fallbackEl = el.querySelector(
                '[aria-label*="view" i], [aria-label*="views" i], [aria-label*="次查看"]'
              );
              if (fallbackEl) {
                return {
                  text: fallbackEl.textContent || '',
                  ariaLabel: fallbackEl.getAttribute('aria-label') || '',
                };
              }
              return { text: '', ariaLabel: '' };
            })
            .catch(() => ({ text: '', ariaLabel: '' }));

          const viewsFromAria = parseTweetViews(viewMeta.ariaLabel);
          const viewsFromText = parseTweetViews(viewMeta.text);
          const views = viewsFromAria > 0 ? viewsFromAria : viewsFromText;

          if (views < minViews) {
            filteredLowViewsCount++;
            console.log(pc.dim(`  ↳ Skip low-views tweet (${views} < ${minViews}): ${tweetUrl || text.slice(0, 30)}`));
            continue;
          }

          // 6b. Language backstop. `lang:en` is X's heuristic and still lets
          // mixed-script posts through (the 2026-11-04 Top sweep collected
          // Chinese tweets that then drove a Chinese core topic), so drop
          // CJK-dominated bodies at the text level as well.
          if (searchLang === 'en' && isCjkDominated(text)) {
            filteredNonEnglishCount++;
            console.log(
              pc.dim(`  ↳ Skip non-English tweet [${authorHandle || 'unknown'}]: ${text.slice(0, 40).replace(/\s+/g, ' ')}...`)
            );
            continue;
          }

          // 7. Extract external links or card URLs
          const externalLinks: string[] = [];
          // X Article (long-form) posts expose a cover image and, on current
          // layouts, NO `a[href*="/article/"]` anchor at all. An anchor-only
          // check therefore dropped every Article post — including 1M+ view
          // ones — as "no external link".
          let hasXArticle = false;
          try {
            const articleCover = await article.$('[data-testid="article-cover-image"]', { strict: false });
            hasXArticle = !!(articleCover && (await articleCover.isExisting()));
          } catch {
            // ignore
          }
          try {
            // Legacy layouts still link the card wrapper / X article directly.
            const cardLink = await article.$('a[href*="/article/"], a[href*="/i/article/"]', { strict: false });
            if (cardLink && (await cardLink.isExisting())) {
              hasXArticle = true;
              const articleHref = await cardLink.getAttribute('href');
              if (articleHref) {
                const fullHref = articleHref.startsWith('http') ? articleHref : `https://x.com${articleHref}`;
                if (!externalLinks.includes(fullHref)) externalLinks.push(fullHref);
              }
            }

            const linkElements = await article.$$('a[role="link"]');
            for (const linkEl of linkElements) {
              const href = await linkEl.getAttribute('href');
              if (href && href.startsWith('https://t.co/')) {
                if (!externalLinks.includes(href)) externalLinks.push(href);
              } else if (
                href &&
                (href.includes('github.com') ||
                  href.includes('medium.com') ||
                  href.includes('substack.com') ||
                  href.includes('arxiv.org') ||
                  href.includes('.io') ||
                  href.includes('.org') ||
                  href.includes('.ai') ||
                  href.includes('.com') ||
                  href.includes('.dev')) &&
                !href.includes('x.com/search') &&
                !href.includes('x.com/home')
              ) {
                if (!externalLinks.includes(href)) externalLinks.push(href);
              }
            }
          } catch {
            // ignore
          }

          // Filter out tweets that have NO external links and NO X article
          if (externalLinks.length === 0 && !hasXArticle) {
            filteredNoLinkCount++;
            // Previously silent: a dropped post left no trace, so "why is post X
            // missing?" was unanswerable from the run log.
            console.log(
              pc.dim(`  ↳ Skip text-only tweet without article/link: ${tweetUrl} | ${text.slice(0, 40).replace(/\s+/g, ' ')}`)
            );
            continue;
          }

          const extractedTweet: ExtractedTweet = {
            id: tweetId,
            url: tweetUrl,
            authorName,
            authorHandle,
            timestamp,
            text,
            views,
            externalLinks,
            blogs: [],
            isMultiAgentRelated: true,
            multiAgentRationale: `Found via target query [${keyword}] with ${views} views and ${externalLinks.length} linked articles`,
          };

          tweetMap.set(tweetId, extractedTweet);
          collectedForThisKeyword++;
          console.log(`  ✓ [${keyword}] #${collectedForThisKeyword}: ${authorName} (${authorHandle}) [Views: ${views}, Links: ${externalLinks.length}]: ${text.slice(0, 60).replace(/\n/g, ' ')}...`);
        }

        if (collectedForThisKeyword < options.tweetsPerKeyword) {
          await browser.execute(() => window.scrollBy(0, 1800));
          await browser.pause(1200);
        }
      }

      if (collectedForThisKeyword < options.tweetsPerKeyword) {
        console.log(
          pc.dim(
            `  ↳ [${keyword}] 已滚动 ${scrollCount}/${maxScrolls} 轮，收集 ${collectedForThisKeyword}/${options.tweetsPerKeyword} 条（搜索页候选耗尽）`
          )
        );
      }
    }
  }

  return buildResult();
}
