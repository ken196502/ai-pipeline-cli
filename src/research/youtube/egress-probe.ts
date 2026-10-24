/**
 * Anonymous egress probe for Google rate limiting.
 *
 * When a logged-in watch page shows a LOGIN_REQUIRED bot wall, the cause can
 * be either (a) a session/cookie problem — fixable by an interactive cookie
 * refresh — or (b) the shared proxy egress IP being rate-limited by Google
 * (watch requests answered by google.com/sorry, HTTP 429) — which no cookie
 * refresh can fix. To avoid expensive, pointless interactive refreshes under
 * (b), this helper re-requests the watch page anonymously through the egress.
 * If the anonymous request is blocked as well, the block is egress-wide.
 */
import { execFile } from 'node:child_process';

const PROBE_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export function resolveEgressProxy(): string | null {
  return (
    process.env.BROWSER_PROXY_URL ||
    process.env.PROXY_URL ||
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    null
  );
}

/**
 * Returns true when an anonymous watch-page request through the egress is
 * rate-limited (HTTP 429, or a redirect to google.com/sorry), false when the
 * egress serves the page normally, and null when the probe cannot run or its
 * result is inconclusive (callers should keep their existing behaviour then).
 */
export async function probeEgressRateLimited(videoId: string, timeoutMs = 15_000): Promise<boolean | null> {
  const proxy = resolveEgressProxy();
  if (!proxy) return null;

  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  return new Promise((resolve) => {
    execFile(
      'curl',
      [
        '-s',
        '-o', '/dev/null',
        '-w', '%{http_code} %{redirect_url}',
        '--max-time', String(Math.ceil(timeoutMs / 1000)),
        '--proxy', proxy,
        '-A', PROBE_UA,
        url,
      ],
      { timeout: timeoutMs + 5_000 },
      (err, stdout) => {
        const line = String(stdout || '').trim();
        const match = /^((\d{3}))?\s*(.*)$/.exec(line);
        const code = match && match[1] ? Number(match[1]) : null;
        const redirectUrl = (match && match[3]) || '';
        if (code === 429) {
          resolve(true);
          return;
        }
        if (code === 302 && redirectUrl.includes('google.com/sorry')) {
          resolve(true);
          return;
        }
        if (code === 200 || (code === 302 && redirectUrl.includes('consent'))) {
          // A 200 already observed counts even if curl then hit --max-time on a
          // slow body: the egress served the page, so the block is not egress-wide.
          resolve(false);
          return;
        }
        // No usable status (curl failed outright, exec error, timeout pre-headers)
        // — inconclusive; callers keep their existing behaviour.
        resolve(null);
      },
    );
  });
}
