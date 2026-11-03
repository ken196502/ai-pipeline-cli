# Plan: Fix Headless Render Concurrency and Frame Timeout

## Problem Statement
FlowTutor failed in stage `tutorial-gen` with:
`Single frame 761 render timed out after 30s (concurrency 2, 2 CPUs)`

## Root Cause Analysis
1. In `src/libs/player/render.ts`:
   ```typescript
   export function resolveRenderConcurrency(cpuCount: number, override?: number): number {
     if (override !== undefined && Number.isFinite(override) && override > 0) {
       return Math.max(1, Math.floor(override));
     }
     return 2; // Hardcoded 2!
   }
   ```
2. Each render worker spawns:
   - 1 headless Chromium browser instance performing canvas seeking & screenshot capture.
   - 1 ffmpeg process encoding raw PNG stream with libx264.
3. On a 2-core VM (`cpuCount = 2`), running concurrency 2 means 4 heavy processes competing for 2 CPU cores (200% oversubscription).
4. Under heavy CPU contention during video canvas seeking, single frame capture took slightly over the default 30s ceiling, triggering the timeout guard on frame 761.

## Proposed Fix
1. **Dynamic CPU-Aware Concurrency**:
   In `src/libs/player/render.ts`, align with `src/tutorial/render.ts`:
   - If `cpuCount <= 2`: default concurrency = 1 (1 worker = 1 browser + 1 ffmpeg = ideal for 2 cores).
   - If `cpuCount >= 4`: default concurrency = `Math.min(4, Math.floor(cpuCount / 2))`.
2. **Generous Timeout Ceiling**:
   - Increase default `FRAME_TIMEOUT_MS` from 30s to 60s in `src/libs/player/render.ts` and `src/tutorial/render.ts`.
3. **Resume / Complete Current Run**:
   - Resume the rendering for run `flowTutor-1792951035836-7qkeln` in tmux so the tutorial video completes without losing the synthesized clips and narration.
