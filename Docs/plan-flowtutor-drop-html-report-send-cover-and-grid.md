# Plan: FlowTutor — drop HTML report, deliver winner cover + doubled-frame tutorial grid

## Goal (user request)

1. Remove the `FINAL_REPORT.html` artifact from the **flowTutor** pipeline (the success
   notification currently attaches it).
2. On completion, deliver only:
   - the **cover of the selected (winning) YouTube video**, and
   - the **final tutorial video contact-sheet grid**, with **2× the frames** (12 → 24).
3. No new pipeline run is started as part of this change (code change + verification only).

Scope: `flowTutor` only. The `xhot` pipeline keeps its HTML report.

## Why the cover was not deliverable before

`FastEval` captures every candidate cover into an in-memory `thumbnailBuffer`, but
`toFastEvalData()` strips binary buffers before persisting, so the winner's cover never
existed as a file on disk — only as a tile inside `fasteval-grid.png`. Delivery needs a
real file path.

## Changes

### 1. Persist the winner cover (`src/research/fasteval/index.ts`)

After the VL evaluation resolves the winner:

- write `<outDir>/winner-cover.jpg` (`sharp` JPEG q=92) from `result.winner.thumbnailBuffer`
  (the buffer is the in-page fetched `maxresdefault`/`hq720` thumbnail, normalised to PNG);
- expose it as `winnerCoverPath` on `FastEvalResult` and in `fasteval-result.json`.

`src/research/fasteval/types.ts`: add optional `winnerCoverPath` to `FastEvalResult` and to
`FastEvalDataSchema` (optional keeps old run artifacts readable).

### 2. Double the tutorial grid frames (`src/tutorial/grid.ts`)

`createTutorialGrid` default `count` 12 → 24; the final-showcase allocation scales with it
(`floor(count/3)` capped at 8 showcase slots).

Tiling: 24 frames with the old auto layout produced a 7×4 sheet with 4 blank cells. New
`exactColumns()` picks the divisor pair closest to the aspect-ideal column count (24 ⇒ 6×4,
zero blanks). `buildFrameGrid` / `calculateGridLayout` gained an optional `columns` override
(backward compatible; other callers unchanged).
`src/tutorial/host-script.ts` ffmpeg fallback grid: 12 → 24 frames, `tile=3x4` → `tile=4x6`.

### 3. Remove the HTML report (`report.ts`, `execute.ts`, `contracts.ts`, `cli.ts`)

- `saveFinalReports()` returns `{ jsonPath, markdownPath }`; `markdownToHtml` import removed.
- `FlowTutorPipelineResult.reportHtmlPath` removed; report stage summary now says
  `FINAL_REPORT.md + final-report.json`.
- `printExecutiveSummary()` no longer prints an HTML report line.
- Markdown/JSON reports stay (they are the durable artifacts).

### 4. Success notification = caption + cover + grid (`src/pipelines/flowtutor/cli.ts`)

`sendMsg()` carries a single attachment, so the success path sends two messages to every
configured notify target:

1. summary caption + `winner-cover.jpg` (fallback: caption only if the cover is missing);
2. `tutorial-grid.jpg` (only when the tutorial stage produced a grid).

Both sends are individually `.catch()`-guarded so a delivery failure never fails the run.

## Verification (no pipeline run)

- `npx tsc --noEmit` (type check) + `npm run build` (dist).
- Targeted tests: `tests/flowtutor-pipeline.test.ts`, `tests/flowtutor-browser-fixes.test.ts`,
  `tests/notification-dual-channel.test.ts`.
- Offline grid check: `createTutorialGrid()` against the existing run's
  `tutorial/explainer-video.mp4` (one-off script `.tmp/verify-grid24.ts`, local ffmpeg only —
  no Flow/LLM tokens).
- Deliver the resulting cover + grid to the user's Telegram chat for visual confirmation.

## Result (done)

- `npx tsc --noEmit` clean; `dist` rebuilt; targeted tests 23/23 pass.
- Grid rebuilt offline from run `flowTutor-1793604323391-9wvalm` (157s tutorial):
  **24 frames, exact 6×4 grid, no blank cells**.
- Winner cover persisted for that run as `winner-cover.jpg` (1280×720) so the new delivery
  path has a real file to attach.
- Stale `FINAL_REPORT.html` deleted from the finished run dir; `FINAL_REPORT.md` and
  `final-report.json` remain.

## Rollback

Revert the four flowTutor files (`cli.ts`, `execute.ts`, `report.ts`, `contracts.ts`) plus
`src/research/fasteval/{index,types}.ts`, `src/research/media/frames.ts`,
`src/tutorial/{grid,host-script}.ts` to restore the HTML report and the 12-frame grid.
