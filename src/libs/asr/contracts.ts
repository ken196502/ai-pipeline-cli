import { z } from 'zod';

export const PuterAsrModelSchema = z.enum([
  'gpt-4o-transcribe',
  'whisper-1',
  'gpt-4o-mini-transcribe',
  'gpt-4o-transcribe-diarize',
]);
export type PuterAsrModel = z.infer<typeof PuterAsrModelSchema>;

export const PuterAsrResponseFormatSchema = z.enum([
  'text',
  'json',
  'verbose_json',
  'srt',
  'vtt',
  'diarized_json',
]);
export type PuterAsrResponseFormat = z.infer<typeof PuterAsrResponseFormatSchema>;

export const PuterAsrWordSchema = z.object({
  word: z.string(),
  start: z.number(),
  end: z.number(),
});
export type PuterAsrWord = z.infer<typeof PuterAsrWordSchema>;

export const PuterAsrSegmentSchema = z.object({
  speaker: z.string().optional(),
  text: z.string(),
  start: z.number().optional(),
  end: z.number().optional(),
});
export type PuterAsrSegment = z.infer<typeof PuterAsrSegmentSchema>;

export const PuterAsrResultSchema = z.object({
  text: z.string(),
  model: z.string().optional(),
  language: z.string().optional(),
  durationSeconds: z.number().optional(),
  words: z.array(PuterAsrWordSchema).optional(),
  segments: z.array(PuterAsrSegmentSchema).optional(),
  raw: z.unknown().optional(),
});
export type PuterAsrResult = z.infer<typeof PuterAsrResultSchema>;

export interface PuterAsrOptions {
  /**
   * Puter API token. Defaults to process.env.PUTER_AUTH_TOKEN or process.env.puterAuthToken.
   */
  authToken?: string;

  /**
   * Transcription model.
   * Options: 'gpt-4o-transcribe' (default), 'whisper-1', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe-diarize'
   */
  model?: PuterAsrModel | string;

  /**
   * Translate spoken language to English (default false).
   */
  translate?: boolean;

  /**
   * Desired response format: 'text', 'json', 'verbose_json', 'srt', 'vtt', 'diarized_json'
   */
  response_format?: PuterAsrResponseFormat;

  /**
   * Timestamp granularities for verbose_json: ['word', 'segment']
   */
  timestamp_granularities?: ('word' | 'segment')[];

  /**
   * Optional language code (e.g. 'en', 'zh', 'ja', 'es')
   */
  language?: string;

  /**
   * Test mode flag for mocked Puter driver execution.
   */
  testMode?: boolean;

  /**
   * Timeout in milliseconds (default 60000).
   */
  timeoutMs?: number;
}
