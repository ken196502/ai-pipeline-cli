/**
 * Plain-text archive of every candidate tweet collected in Stage 1.
 *
 * Why: when the reviewer rejected a batch ("no suitable candidates") the run
 * died before writing anything, so there was no way to tell whether the search
 * found junk or the reviewer was simply too picky. The dump is written right
 * after scraping (even for an empty batch) so the raw candidate pool is always
 * inspectable.
 */
import type { ExtractedTweet } from './contracts.js';

export interface CandidateDumpEntry {
  tweet: ExtractedTweet;
  /** Run id in which this tweet was already used, if it was filtered as a repeat. */
  alreadyWrittenRunId?: string;
}

export interface CandidateDumpMeta {
  generatedAt?: string;
  keywords: string[];
  tweetsPerKeyword: number;
  minViews: number;
  filteredAdCount: number;
  filteredRetweetCount: number;
  filteredNoLinkCount: number;
  filteredLowViewsCount: number;
  filteredNoUrlCount?: number;
}

const SEPARATOR = '='.repeat(72);
const DIVIDER = '-'.repeat(72);

function oneLine(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

/**
 * Renders the candidate pool as plain text (no Markdown, no ANSI).
 *
 * The tweet body is kept verbatim (only trailing whitespace trimmed): the dump
 * exists to show exactly what the reviewer saw.
 */
export function renderCandidateTweetsTxt(entries: CandidateDumpEntry[], meta: CandidateDumpMeta): string {
  const generatedAt = meta.generatedAt || new Date().toISOString();
  const freshCount = entries.filter((e) => !e.alreadyWrittenRunId).length;
  const repeatedCount = entries.length - freshCount;

  const lines: string[] = [
    'xdev 候选推文汇总（Stage 1 原始候选池）',
    `生成时间: ${generatedAt}`,
    `搜索关键词: ${meta.keywords.join(' | ') || '(无)'}`,
    `每关键词目标条数: ${meta.tweetsPerKeyword}`,
    `最低阅读量门槛: ${meta.minViews}`,
    '',
    `候选总数: ${entries.length}（新题材 ${freshCount} 条 / 往期已写 ${repeatedCount} 条）`,
    '过滤统计: ' +
      `广告 ${meta.filteredAdCount} 条 / 转推 ${meta.filteredRetweetCount} 条 / ` +
      `无外链或长文 ${meta.filteredNoLinkCount} 条 / 阅读量不足 ${meta.filteredLowViewsCount} 条 / ` +
      `无有效推文链接 ${meta.filteredNoUrlCount ?? 0} 条`,
    '',
  ];

  if (entries.length === 0) {
    lines.push(SEPARATOR, '本期没有通过硬过滤的候选推文。请查看上方过滤统计或放宽关键词/阅读量门槛。', SEPARATOR, '');
    return lines.join('\n');
  }

  entries.forEach((entry, idx) => {
    const t = entry.tweet;
    lines.push(
      SEPARATOR,
      `[${idx + 1}/${entries.length}] ${t.authorName} (${t.authorHandle || '未知账号'})`,
      `推文链接: ${t.url || '(缺失)'}`,
      `发布时间: ${t.timestamp || '(未知)'}`,
      `阅读量: ${t.views != null ? t.views.toLocaleString() : '(未知)'}`,
      `外链: ${t.externalLinks.length ? t.externalLinks.join(', ') : '(无)'}`,
      `状态: ${entry.alreadyWrittenRunId ? `往期已写（${entry.alreadyWrittenRunId}），本期跳过` : '本期新题材，参与选题'}`,
      DIVIDER,
      oneLine(t.text),
      ''
    );
  });

  return lines.join('\n');
}
