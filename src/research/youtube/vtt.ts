/**
 * WebVTT caption parser and cleaner for YouTube transcripts.
 *
 * Normalizes timestamps to monotonic seconds, decodes HTML entities,
 * removes styling/formatting markup, and strips YouTube auto-caption
 * rolling word repetitions via up to 30-word overlap checks.
 */
import type { Transcript, TranscriptCue } from '../contracts.js';
import { roundSeconds } from '../utils/time.js';

/**
 * Removes overlapping words between consecutive caption cues.
 * YouTube auto-generated captions often repeat the tail of the previous cue
 * at the start of the next cue as speech recognition progresses.
 */
export function removeOverlappingWords(previous: string, current: string): string {
  const previousWords = previous.trim().split(/\s+/);
  const currentWords = current.trim().split(/\s+/);
  if (previousWords.length === 0 || currentWords.length === 0) return current;

  const maxCheck = Math.min(30, previousWords.length, currentWords.length);
  let overlapCount = 0;
  for (let count = 1; count <= maxCheck; count += 1) {
    const previousEnd = previousWords.slice(-count).join(' ').toLowerCase();
    const currentStart = currentWords.slice(0, count).join(' ').toLowerCase();
    if (previousEnd === currentStart) {
      overlapCount = count;
    }
  }

  return overlapCount > 0 ? currentWords.slice(overlapCount).join(' ') : current;
}

/**
 * Decodes common HTML entities and numeric character references.
 */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) && code > 0 ? String.fromCharCode(code) : '';
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 ? String.fromCharCode(code) : '';
    });
}

/**
 * Strips formatting markup such as <c.color>, </c>, <b>, <i>, <00:00:01.000>, etc.
 */
export function stripMarkup(text: string): string {
  return text
    .replace(/<[^>]+>/g, '') // Remove HTML/VTT tags
    .replace(/[​-‍﻿]/g, '') // Remove zero-width characters and BOM
    .trim();
}

/**
 * Parses timestamp string (00:01:23.456 or 01:23.456) into fractional seconds.
 */
export function parseTimestamp(raw: string): number | null {
  const trimmed = raw.trim();
  const parts = trimmed.split(':');
  if (parts.length < 2 || parts.length > 3) return null;

  let hours = 0;
  let minutes = 0;
  let seconds = 0;

  if (parts.length === 3) {
    hours = parseFloat(parts[0] || '0');
    minutes = parseFloat(parts[1] || '0');
    seconds = parseFloat(parts[2] || '0');
  } else {
    minutes = parseFloat(parts[0] || '0');
    seconds = parseFloat(parts[1] || '0');
  }

  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return null;
  }

  return roundSeconds(hours * 3600 + minutes * 60 + seconds);
}

const TIMESTAMP_LINE_REGEX = /^(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?)\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?)(.*)$/;

export interface ParseVttOptions {
  videoId?: string;
  language?: string;
  source?: 'manual' | 'auto';
}

/**
 * Parses raw WebVTT content into a normalized Transcript structure.
 */
export function parseVtt(content: string, options: ParseVttOptions | string = 'en'): Transcript {
  const videoId = typeof options === 'object' ? options.videoId || 'unknown' : 'unknown';
  const language = typeof options === 'string' ? options : options.language || 'en';
  const source = typeof options === 'object' ? options.source || 'manual' : 'manual';

  if (!content || typeof content !== 'string') {
    return {
      videoId,
      language,
      source,
      cues: [],
    };
  }

  // Strip BOM and normalize line breaks
  const normalized = content.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');

  const rawCues: Array<{ startSec: number; endSec: number; text: string }> = [];
  let i = 0;

  // Skip WEBVTT header line and optional notes
  while (i < lines.length) {
    const line = lines[i]?.trim() || '';
    i += 1;
    if (line === 'WEBVTT' || line.startsWith('WEBVTT ') || line.startsWith('X-TIMESTAMP-MAP=')) {
      break;
    }
  }

  while (i < lines.length) {
    const line = lines[i]?.trim() || '';

    // Skip empty lines, NOTE blocks, STYLE blocks, REGION blocks
    if (!line) {
      i += 1;
      continue;
    }

    if (line.startsWith('NOTE') || line.startsWith('STYLE') || line.startsWith('REGION')) {
      i += 1;
      while (i < lines.length && (lines[i]?.trim() || '') !== '') {
        i += 1;
      }
      continue;
    }

    // Check if current line is timestamp line or cue identifier
    const match = TIMESTAMP_LINE_REGEX.exec(line);
    let timestampLine = '';
    if (match) {
      timestampLine = line;
      i += 1;
    } else if (i + 1 < lines.length) {
      // Possible identifier on current line, timestamp on next line
      const nextLine = lines[i + 1]?.trim() || '';
      if (TIMESTAMP_LINE_REGEX.test(nextLine)) {
        timestampLine = nextLine;
        i += 2;
      } else {
        i += 1;
        continue;
      }
    } else {
      i += 1;
      continue;
    }

    const tsMatch = TIMESTAMP_LINE_REGEX.exec(timestampLine);
    if (!tsMatch) continue;

    const startSec = parseTimestamp(tsMatch[1] || '');
    const endSec = parseTimestamp(tsMatch[2] || '');
    if (startSec === null || endSec === null) continue;

    // Collect text lines until empty line
    const textLines: string[] = [];
    while (i < lines.length) {
      const textLine = lines[i] || '';
      if (textLine.trim() === '') {
        i += 1;
        break;
      }
      textLines.push(textLine);
      i += 1;
    }

    const rawText = textLines.join(' ');
    const cleanedText = decodeHtmlEntities(stripMarkup(rawText)).replace(/\s+/g, ' ').trim();
    if (cleanedText) {
      rawCues.push({
        startSec,
        endSec: Math.max(endSec, startSec + 0.1),
        text: cleanedText,
      });
    }
  }

  // De-duplicate rolling word overlap and enforce strictly monotonic timestamps
  const cues: TranscriptCue[] = [];
  let prevText = '';
  let prevEndSec = 0;

  for (const rawCue of rawCues) {
    let text = rawCue.text;
    if (prevText) {
      text = removeOverlappingWords(prevText, text).trim();
    }

    if (!text) continue;

    let startSec = rawCue.startSec;
    let endSec = rawCue.endSec;

    // Keep timestamps monotonically forward
    if (startSec < prevEndSec) {
      startSec = prevEndSec;
    }
    if (endSec <= startSec) {
      endSec = roundSeconds(startSec + 0.5);
    }

    cues.push([roundSeconds(startSec), roundSeconds(endSec), text]);
    prevText = text;
    prevEndSec = endSec;
  }

  return {
    videoId,
    language,
    source,
    cues,
  };
}
