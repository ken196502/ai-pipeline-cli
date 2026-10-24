/**
 * YouTube URL and Video ID normalization and extraction utilities.
 */

const VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

/**
 * Extracts an 11-character YouTube video ID from a URL or raw ID string.
 * Supports standard watch URLs, short youtu.be URLs, embed URLs, and shorts URLs.
 */
export function extractVideoId(input: string): string | null {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();

  // If it's already a bare 11-char ID
  if (VIDEO_ID_REGEX.test(trimmed)) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');

    if (hostname === 'youtube.com' || hostname === 'm.youtube.com') {
      // /watch?v=VIDEO_ID
      const v = parsed.searchParams.get('v');
      if (v && VIDEO_ID_REGEX.test(v)) return v;

      // /embed/VIDEO_ID or /v/VIDEO_ID or /shorts/VIDEO_ID or /live/VIDEO_ID
      const pathParts = parsed.pathname.split('/').filter(Boolean);
      const prefix = pathParts[0];
      const id = pathParts[1];
      if (
        (prefix === 'embed' || prefix === 'v' || prefix === 'shorts' || prefix === 'live') &&
        id &&
        VIDEO_ID_REGEX.test(id)
      ) {
        return id;
      }
    } else if (hostname === 'youtu.be') {
      // youtu.be/VIDEO_ID
      const id = parsed.pathname.split('/').filter(Boolean)[0];
      if (id && VIDEO_ID_REGEX.test(id)) return id;
    }
  } catch {
    // Not a valid URL, check for standard regex matching anywhere in string
    const match = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?|shorts|live)\/|.*[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/.exec(
      trimmed,
    );
    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
}

/**
 * Converts a video ID into a canonical https://www.youtube.com/watch?v=... URL.
 */
export function toWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * Converts a video ID or URL into a canonical https://www.youtube.com/watch?v=... URL.
 */
export function normalizeYouTubeUrl(videoIdOrUrl: string): string {
  const id = extractVideoId(videoIdOrUrl);
  if (!id) {
    throw new Error(`Cannot normalize invalid YouTube video ID or URL: "${videoIdOrUrl}"`);
  }
  return `https://www.youtube.com/watch?v=${id}`;
}

/**
 * Returns true if the input string is a recognizable YouTube URL or video ID.
 */
export function isYouTubeUrl(input: string): boolean {
  return extractVideoId(input) !== null;
}
