# Plan: Fix Xhot Pipeline (Material Selection, High-Res Tweet Images, TTS Tone, Dual-Thread GPU Accelerated Rendering)

## Context & Objectives
In recent Xhot runs (e.g. `artifacts/xhot-1792903933950-wlxbmq`), four major usability and performance issues were identified:
1. **Low quality material tweets**: Harvesting was scanning arbitrary candidate tweets and relying on VL without filtering for community traction (views, replies, reposts). Tweets with no engagement were mixed into materials. Need to prioritize tweets by views/replies/reposts and discard zero-engagement or low-engagement noise.
2. **Degraded tweet images in explain video**: Low-res/compressed preview screenshots were being used as explain video assets instead of original media images or clear cards, resulting in poor visual fidelity.
3. **TTS tone sounding like whispering**: The Qwen3-TTS instruction (`ttsInstruct`) was set to "calm, steady, composed, professional documentary narrator tone. Avoid theatrical excitement or erratic pitch changes." which causes the model to whisper or sound overly quiet/subdued. Need to tune prompt/instruct and speaker config to sound energetic, confident, crisp, and broadcast-ready.
4. **Rendering is too slow (120 mins)**: Defaulting to single-thread CPU software rendering. Need to reference VideoGen to implement dual-thread chunk rendering with GPU acceleration (`--ignore-gpu-blocklist`, `--enable-gpu-rasterization`, `--enable-zero-copy`, concurrent chunk workers, and optimized ffmpeg preset/flags).

---

## Detailed Action Plan

### 1. Material Tweets Selection by Views & Engagement
- **File**: `src/modules/harvest/harvest.ts`, `src/modules/harvest/contracts.ts`, `src/modules/discovery/search.ts`
- **Changes**:
  - Extract tweet engagement metrics (`views`, `replies`, `reposts`, `likes`) during the harvest scan phase, similar to discovery.
  - Filter out tweets with 0 views or 0 engagement.
  - Sort/prioritize scanned tweets by an engagement score (e.g. `views * 1 + replies * 50 + reposts * 20 + likes * 5`).
  - Pass the prioritized high-volume candidates to VL richness evaluation and material download.

### 2. High-Quality Media Assets for Explain Video
- **File**: `src/modules/harvest/harvest.ts`, `src/modules/explainer-video/video.ts`
- **Changes**:
  - Ensure image download fetches `name=orig` or `name=4096x4096` instead of compressed thumbnails or low-res shots.
  - When capturing tweet card screenshots, ensure appropriate scale or deviceScaleFactor (or prefer full raw media attachments `kind: image` over screenshot cards for presentation).
  - In `video.ts`, prioritize real media images and video footage (`*-media-*`, `*-video-*`) in the storyboard and asset list over compressed tweet bounding-box screenshots.

### 3. TTS Tone Tuning (Crisp, Confident Broadcast Tone)
- **File**: `src/modules/explainer-video/video.ts`, `src/libs/player/tts.ts`
- **Changes**:
  - Update `ttsInstruct` to instruct a confident, crisp, energetic tech news anchor / broadcast documentary tone (e.g. "Speak with confidence, clarity, and crisp articulation like an engaging technology news anchor. Clear projection, energetic and professional, do not whisper or mumble.").
  - Support setting instruct and voice via pipeline options and environment variables if needed.

### 4. Dual-Thread GPU Accelerated Rendering (Reference VideoGen)
- **File**: `src/libs/player/render.ts`, `src/modules/explainer-video/video.ts`, `src/modules/explainer-video/produce.ts`
- **Changes**:
  - Align `resolveRenderConcurrency`: default concurrency to 2 (or allow explicit configuration), enabling dual-thread concurrent chunk rendering.
  - Ensure Chromium launch args have full GPU acceleration enabled:
    `--ignore-gpu-blocklist`, `--enable-gpu-rasterization`, `--enable-zero-copy`, `--use-gl=angle`, `--enable-accelerated-video-decode`, etc.
  - Optimize ffmpeg chunk encoding parameters (preset `ultrafast` / `veryfast`, tune threads per worker).
  - Verify auto-resume and chunk stitching.

### 5. Verification & Testing
- Build with `npm run build`.
- Run unit/integration tests to ensure no regressions in contracts or pipeline stages.
- Clean up any test artifacts.
