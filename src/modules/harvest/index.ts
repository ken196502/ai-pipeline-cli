import { resolveYtDlpBinary } from '../../libs/media/ytdlp.js';

export * from './contracts.js';
export * from './eval-richness.js';
export * from './harvest.js';

/**
 * Self-test routine for the Harvest Module.
 * Verifies yt-dlp binary resolution and environment tool readiness.
 */
export async function testHarvestModule(): Promise<{
  success: boolean;
  ytDlpAvailable: boolean;
  ytDlpPath?: string;
  errors: string[];
}> {
  const errors: string[] = [];
  let ytDlpAvailable = false;
  let ytDlpPath: string | undefined;

  try {
    ytDlpPath = await resolveYtDlpBinary();
    ytDlpAvailable = Boolean(ytDlpPath);
    if (!ytDlpAvailable) {
      errors.push('yt-dlp executable could not be resolved');
    }
  } catch (err: any) {
    errors.push(`yt-dlp resolution error: ${err.message}`);
  }

  return {
    success: errors.length === 0,
    ytDlpAvailable,
    ytDlpPath,
    errors,
  };
}
