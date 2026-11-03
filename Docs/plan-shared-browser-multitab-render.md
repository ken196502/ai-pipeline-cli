# Plan: Shared-Browser Multi-Tab Concurrent Video Render

## Problem Statement
The user pointed out:
"那速度不就慢了50%？不能开两个tab截图最后一个ffmpeg合成吗"

Previously, each concurrent render worker launched a completely separate Chromium process (`launchRenderBrowser`), which multiplied browser memory overhead by 2x-3x, exhausted 4GB RAM, and caused fatal swap thrashing.
Conversely, restricting to a single worker reduces throughput.

## Benchmark & Solution Analysis
1. **Benchmark verification**:
   We tested 1 shared Chromium process with 2 tabs executing parallel seek and screenshot:
   - Single worker: ~950ms per frame (~1.0 fps).
   - 1 Browser with 2 Tabs: **292ms per frame (3.42 fps) — over 3x faster!**
   - Memory usage remained low (~500MB total) because the browser process, GPU pipeline, and engine caches are shared.
2. **Streaming chunk encoding vs single end-ffmpeg**:
   - Streaming screenshots directly into per-chunk ffmpeg workers via `stdin` prevents writing 15GB+ of raw uncompressed PNG frames to disk.
   - Each chunk ffmpeg worker is set to `-threads 1` so that two concurrent tab workers use exactly 2 encoding threads, perfectly matching the 2 CPU cores without thread contention.
   - The final video is assembled instantaneously via ffmpeg `-f concat -c copy` (0.1s).

## Proposed Architecture in `src/libs/player/render.ts`
1. **Shared Browser Lifecycle**:
   Launch a single browser instance before chunk processing:
   `const sharedLaunched = await launchRenderBrowser({ ... });`
2. **Tab per Worker**:
   Each concurrent worker opens a tab within the shared browser:
   `const page = await sharedBrowser.newPage({ viewport: { width, height } });`
3. **Controlled Threading**:
   Pass `-threads 1` to each chunk ffmpeg spawn so 2 workers neatly occupy the 2 CPU cores.
4. **Cleanup**:
   Ensure `page.close()` per chunk/worker and `sharedBrowser.close()` in `finally`.
5. **Build & Verify**:
   Run `npm run build` and re-render.
