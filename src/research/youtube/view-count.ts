/**
 * YouTube view count, duration, and publication age parser.
 * Handles diverse YouTube string formats from DOM elements, aria-labels, and JSON renderers:
 * - Metric suffixes: 10K, 1.2M, 3.5B, 12万, 1.5亿
 * - Comma-separated counts: "10,234 views", "1,200,450 views"
 * - Embedded aria-labels: "... by Channel 30,123 views 2 weeks ago 8 minutes, 10 seconds"
 */

const MULTIPLIERS: Record<string, number> = {
  k: 1_000,
  m: 1_000_000,
  b: 1_000_000_000,
  万: 10_000,
  w: 10_000,
  亿: 100_000_000,
};

/**
 * Parses raw view count text into a numeric view count.
 * Returns null if no plausible view count is found.
 */
export function parseViewCount(raw?: string | null): number | null {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;

  // 1. Look for explicit view count pattern like "30,123 views", "1.2M views", "12万次播放", "545K views"
  const explicitMatch = s.match(
    /(?:^|[^\d.])([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)\s*([kKmMbB万wW亿])?\s*(?:views?|次播放|次观看|次浏览)?(?:\s*·|\s*•|\s+ago|$|[^\w])/i
  );

  // If explicit keyword match with "view/views/次播放/次观看" is present, prioritize it
  const keywordMatch = s.match(
    /([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)\s*([kKmMbB万wW亿])?\s*(?:views?|次播放|次观看|次浏览)/i
  );

  const bestMatch = keywordMatch || explicitMatch;
  if (bestMatch) {
    const numPart = bestMatch[1].replace(/,/g, '');
    const unitPart = (bestMatch[2] || '').toLowerCase();
    const val = parseFloat(numPart);
    if (!isNaN(val)) {
      const mult = MULTIPLIERS[unitPart] ?? 1;
      return Math.round(val * mult);
    }
  }

  // 2. Direct number or number with suffix (e.g. "1.2M", "58K", "10234")
  const directMatch = s.match(/^([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)\s*([kKmMbB万wW亿])?$/i);
  if (directMatch) {
    const numPart = directMatch[1].replace(/,/g, '');
    const unitPart = (directMatch[2] || '').toLowerCase();
    const val = parseFloat(numPart);
    if (!isNaN(val)) {
      const mult = MULTIPLIERS[unitPart] ?? 1;
      return Math.round(val * mult);
    }
  }

  return null;
}

/**
 * Parses relative age strings like "2 weeks ago", "3 days ago", "1 year ago" into days.
 * Returns null if not recognizable.
 */
export function parsePublishedDaysAgo(text?: string | null): number | null {
  if (!text || typeof text !== 'string') return null;
  const s = text.toLowerCase();

  // English patterns: e.g. "2 weeks ago", "Streamed 4 months ago"
  const enMatch = s.match(/(\d+)\s*(sec|second|seconds|min|minute|minutes|hr|hour|hours|day|days|week|weeks|month|months|year|years)\s*ago/);
  if (enMatch) {
    const val = parseInt(enMatch[1], 10);
    const unit = enMatch[2];
    if (unit.startsWith('sec') || unit.startsWith('min') || unit.startsWith('h')) {
      return 1; // within today
    }
    if (unit.startsWith('day')) return Math.max(1, val);
    if (unit.startsWith('week')) return Math.max(1, val * 7);
    if (unit.startsWith('month')) return Math.max(1, val * 30);
    if (unit.startsWith('year')) return Math.max(1, val * 365);
  }

  // Chinese patterns: e.g. "3天前", "2周前", "1个月前", "1年前"
  const zhMatch = s.match(/(\d+)\s*(秒|分|小时|天|周|个月|月|年)前/);
  if (zhMatch) {
    const val = parseInt(zhMatch[1], 10);
    const unit = zhMatch[2];
    if (unit === '秒' || unit === '分' || unit === '小时') return 1;
    if (unit === '天') return Math.max(1, val);
    if (unit === '周') return Math.max(1, val * 7);
    if (unit.includes('月')) return Math.max(1, val * 30);
    if (unit === '年') return Math.max(1, val * 365);
  }

  return null;
}

/**
 * Parses duration clock strings like "8:10", "1:02:33" or text like "8 minutes, 10 seconds" into seconds.
 */
export function parseFlexibleDurationSeconds(text?: string | null): number | null {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();

  // 1. Clock format: "8:10" or "1:02:33"
  const clockMatch = trimmed.match(/(?:(\d+):)?(\d{1,2}):(\d{2})/);
  if (clockMatch) {
    const hours = clockMatch[1] ? parseInt(clockMatch[1], 10) : 0;
    const mins = parseInt(clockMatch[2], 10);
    const secs = parseInt(clockMatch[3], 10);
    return hours * 3600 + mins * 60 + secs;
  }

  // 2. Text format: "8 minutes, 10 seconds" or "1 hour, 2 minutes"
  let totalSec = 0;
  let matched = false;
  const hrMatch = trimmed.match(/(\d+)\s*(?:hours?|hrs?|小时)/i);
  if (hrMatch) {
    totalSec += parseInt(hrMatch[1], 10) * 3600;
    matched = true;
  }
  const minMatch = trimmed.match(/(\d+)\s*(?:minutes?|mins?|分钟?)/i);
  if (minMatch) {
    totalSec += parseInt(minMatch[1], 10) * 60;
    matched = true;
  }
  const secMatch = trimmed.match(/(\d+)\s*(?:seconds?|secs?|秒)/i);
  if (secMatch) {
    totalSec += parseInt(secMatch[1], 10);
    matched = true;
  }

  return matched ? totalSec : null;
}

/**
 * Decomposes an aria-label from a YouTube video tile into clean title, view count, published time, and duration.
 * Example aria-label:
 * "This NEW AI Insect Video Niche Is Going Viral! 🐞 Create Cinematic Videos for FREE by Q TECH STUDIO 30,123 views 2 weeks ago 8 minutes, 10 seconds"
 */
export function parseYouTubeAriaLabel(ariaLabel?: string | null): {
  cleanTitle?: string;
  channelTitle?: string;
  viewCount?: number;
  viewCountText?: string;
  publishedTimeText?: string;
  durationText?: string;
  durationSec?: number;
} {
  if (!ariaLabel || typeof ariaLabel !== 'string') return {};
  const text = ariaLabel.trim();

  // Extract duration from end, e.g. "8 minutes, 10 seconds" or "10:54"
  const durationMatch =
    text.match(/(?:(\d+\s*hours?,\s*)?(\d+\s*minutes?(?:,\s*)?)?(\d+\s*seconds?)|(\d{1,3}:\d{2}(?::\d{2})?))\s*$/i);
  const durationText = durationMatch ? durationMatch[0].trim() : undefined;
  const durationSec = durationText ? parseFlexibleDurationSeconds(durationText) ?? undefined : undefined;

  // Extract relative age, e.g. "2 weeks ago"
  const ageMatch = text.match(/(\d+\s*(?:sec|second|seconds|min|minute|minutes|hr|hour|hours|day|days|week|weeks|month|months|year|years)\s*ago|\d+\s*(?:秒|分|小时|天|周|个月|月|年)前)/i);
  const publishedTimeText = ageMatch ? ageMatch[0].trim() : undefined;

  // Extract view count, e.g. "30,123 views" or "1.2M views"
  const viewsMatch = text.match(/([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)\s*([kKmMbB万wW亿])?\s*(?:views?|次播放|次观看)/i);
  const viewCountText = viewsMatch ? viewsMatch[0].trim() : undefined;
  const viewCount = viewCountText ? parseViewCount(viewCountText) ?? undefined : undefined;

  // Extract channel & title
  // Pattern: "<Title> by <Channel> <Views> <Age> <Duration>"
  let cleanTitle: string | undefined;
  let channelTitle: string | undefined;

  const byIndex = text.indexOf(' by ');
  if (byIndex > 0) {
    cleanTitle = text.slice(0, byIndex).trim();
    const afterBy = text.slice(byIndex + 4);
    // Channel name stops before view count or relative time
    const cutPos = [
      viewCountText ? afterBy.indexOf(viewCountText) : -1,
      publishedTimeText ? afterBy.indexOf(publishedTimeText) : -1,
      durationText ? afterBy.indexOf(durationText) : -1,
    ].filter((pos) => pos > 0).sort((a, b) => a - b)[0];

    if (cutPos && cutPos > 0) {
      channelTitle = afterBy.slice(0, cutPos).trim();
    }
  } else {
    // If no " by ", strip known metadata segments from the end
    let stripped = text;
    if (durationText) stripped = stripped.replace(durationText, '').trim();
    if (publishedTimeText) stripped = stripped.replace(publishedTimeText, '').trim();
    if (viewCountText) stripped = stripped.replace(viewCountText, '').trim();
    cleanTitle = stripped || undefined;
  }

  return {
    cleanTitle,
    channelTitle,
    viewCount,
    viewCountText,
    publishedTimeText,
    durationText,
    durationSec,
  };
}
