import { Browser } from 'webdriverio';
import pc from 'picocolors';
import { tweetIdFromUrl, type XDevHistoryEntry } from './history.js';

export interface PublishedArticleInfo {
  title: string;
  url?: string;
  sourceTweetUrl?: string;
}

/**
 * Loads the actual published articles from the logged-in X account
 * by inspecting https://x.com/compose/articles -> "Published" tab.
 *
 * If the user has never published an article on X, returns an empty array.
 * This guarantees we only deduplicate against REAL published articles on X,
 * not against intermediate local test artifacts/drafts.
 */
export async function loadAccountPublishedHistory(browser: Browser): Promise<XDevHistoryEntry[]> {
  console.log(pc.cyan('\n[history] Inspecting X account published articles at https://x.com/compose/articles...'));
  try {
    await browser.url('https://x.com/compose/articles');
    await browser.pause(4000);

    const publishedInfo = await browser.execute(() => {
      const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
      const publishedTab = tabs.find((t) => /published/i.test(t.textContent || '')) as HTMLElement | undefined;
      if (publishedTab) {
        publishedTab.click();
      }

      const articles = Array.from(document.querySelectorAll('[data-testid="cellInnerDiv"], [role="article"]'));
      const items: { title: string; href?: string; text: string }[] = [];

      for (const art of articles) {
        const text = (art as HTMLElement).innerText || '';
        const titleEl = art.querySelector('h2, [dir="auto"]');
        const link = art.querySelector('a[href*="/article/"]') as HTMLAnchorElement | null;
        if (text.trim()) {
          items.push({
            title: titleEl ? (titleEl as HTMLElement).innerText.trim() : text.slice(0, 60),
            href: link ? link.href : undefined,
            text,
          });
        }
      }
      return items;
    });

    console.log(pc.dim(`  • 找到 ${publishedInfo.length} 篇已发布文章 (Published Tab)`));

    const history: XDevHistoryEntry[] = [];
    for (const item of publishedInfo) {
      // Find tweet permalink in the text or links if present
      const tweetMatch = item.text.match(/https:\/\/x\.com\/[^/\s]+\/status\/(\d+)/);
      const tweetUrls = tweetMatch ? [tweetMatch[0]] : [];
      history.push({
        runId: item.href || item.title.slice(0, 30),
        articleTitle: item.title,
        tweetUrls,
        topicTitles: [item.title],
      });
    }

    return history;
  } catch (err: any) {
    console.warn(pc.yellow(`  ⚠ [history] 读取 X 线上已发布文章失败 (${err?.message || err})，降级为空历史`));
    return [];
  }
}
