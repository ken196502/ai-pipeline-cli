import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DOWNLOAD_FORMAT, VIDEO_ONLY_DOWNLOAD_FORMAT } from '../src/research/youtube/ytdlp.js';

test('DEFAULT_DOWNLOAD_FORMAT prioritizes >=720p', () => {
  assert.ok(DEFAULT_DOWNLOAD_FORMAT.includes('height>=720'), 'Should contain height>=720 priority');
  assert.ok(DEFAULT_DOWNLOAD_FORMAT.includes('bestaudio'), 'Should include audio stream when requested');
});

test('VIDEO_ONLY_DOWNLOAD_FORMAT requests pure video track with >=720p priority without bundling audio', () => {
  assert.ok(VIDEO_ONLY_DOWNLOAD_FORMAT.includes('bestvideo[height<=1080][height>=720]'), 'Should target 720p-1080p video');
  assert.ok(!VIDEO_ONLY_DOWNLOAD_FORMAT.includes('bestaudio'), 'Should NOT request audio in video-only mode');
});
