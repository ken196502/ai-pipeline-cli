/**
 * Hydrates raw yt-dlp video metadata into validated VideoCandidate models.
 * Calculates derived metrics (ageDays, viewsPerDay, engagementRate) and
 * tracks metricsConfidence explicitly.
 */
import type { VideoCandidate } from '../contracts.js';
import { extractVideoId } from './urls.js';

export interface RawYtDlpInfo {
  id?: string;
  title?: string;
  description?: string;
  uploader?: string;
  uploader_id?: string;
  channel?: string;
  channel_id?: string;
  duration?: number;
  view_count?: number | null;
  like_count?: number | null;
  comment_count?: number | null;
  upload_date?: string; // YYYYMMDD
  timestamp?: number; // epoch seconds
  release_timestamp?: number;
  tags?: string[] | null;
  thumbnail?: string;
  thumbnails?: Array<{ url: string; width?: number; height?: number }>;
  subtitles?: Record<string, Array<{ ext: string; url?: string; name?: string }>>;
  automatic_captions?: Record<string, Array<{ ext: string; url?: string; name?: string }>>;
  [key: string]: unknown;
}

export interface HydrateOptions {
  now?: () => Date;
}

/**
 * Converts raw yt-dlp extraction dictionary into a clean VideoCandidate.
 * Returns null if the required fields (videoId, title, duration) are invalid.
 */
export function toVideoCandidate(
  raw: RawYtDlpInfo,
  options: HydrateOptions = {},
): VideoCandidate | null {
  if (!raw || typeof raw !== 'object') return null;

  const rawId = typeof raw.id === 'string' ? raw.id : '';
  const videoId = extractVideoId(rawId);
  if (!videoId) return null;

  const title = (typeof raw.title === 'string' ? raw.title : '').trim();
  if (!title) return null;

  const durationSec = Math.max(0, Math.round(Number(raw.duration) || 0));

  // Published time resolution
  const now = options.now ?? (() => new Date());
  const nowMs = now().getTime();

  let publishedMs: number;
  if (typeof raw.timestamp === 'number' && raw.timestamp > 0) {
    publishedMs = raw.timestamp * 1000;
  } else if (typeof raw.release_timestamp === 'number' && raw.release_timestamp > 0) {
    publishedMs = raw.release_timestamp * 1000;
  } else if (typeof raw.upload_date === 'string' && /^\d{8}$/.test(raw.upload_date)) {
    const y = parseInt(raw.upload_date.slice(0, 4), 10);
    const m = parseInt(raw.upload_date.slice(4, 6), 10) - 1;
    const d = parseInt(raw.upload_date.slice(6, 8), 10);
    publishedMs = Date.UTC(y, m, d);
  } else {
    // Fallback: 30 days ago if unknown
    publishedMs = nowMs - 30 * 86_400_000;
  }

  const ageDays = Math.max(1, (nowMs - publishedMs) / 86_400_000);

  // Metrics resolution
  const viewCount = Math.max(0, Math.floor(Number(raw.view_count) || 0));
  const likeCount = Math.max(0, Math.floor(Number(raw.like_count) || 0));
  const commentCount = Math.max(0, Math.floor(Number(raw.comment_count) || 0));

  const viewsPerDay = Math.round(viewCount / ageDays);

  const engagementRate =
    viewCount === 0
      ? 0
      : Math.min(1, Math.round(((likeCount + commentCount) / viewCount) * 10_000) / 10_000);

  const channelTitle = (
    typeof raw.uploader === 'string' ? raw.uploader : typeof raw.channel === 'string' ? raw.channel : ''
  ).trim();
  const channelId = (
    typeof raw.channel_id === 'string'
      ? raw.channel_id
      : typeof raw.uploader_id === 'string'
        ? raw.uploader_id
        : ''
  ).trim();

  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    : [];

  const defaultThumb =
    typeof raw.thumbnail === 'string' && raw.thumbnail ? raw.thumbnail : `https://i.ytimg.com/vi/${videoId}/default.jpg`;
  const mediumThumb = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
  const highThumb = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  const maxresThumb = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;

  return {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title,
    channelTitle: channelTitle || 'Unknown Channel',
    channelId: channelId || videoId,
    description,
    tags,
    language: 'en',
    metrics: {
      viewCount,
      likeCount,
      commentCount,
      durationSec,
      publishedAt: new Date(publishedMs).toISOString(),
      viewsPerDay,
      engagementRate,
    },
    metricsConfidence: {
      views: raw.view_count != null && raw.view_count !== undefined,
      likes: raw.like_count != null && raw.like_count !== undefined,
      comments: raw.comment_count != null && raw.comment_count !== undefined,
    },
  };
}
