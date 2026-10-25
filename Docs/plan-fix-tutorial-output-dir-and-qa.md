# Fix Tutorial Output Directory and Visual QA ENOENT Plan

## Problem Statement
FlowTutor failed at stage `tutorial-gen` with:
`ENOENT: no such file or directory, open '/mnt/share/VM/AIGC-pipeline/artifacts/flowTutor-1792920804876-5eok07/tutorial/tutorial.json'`

Although all Flow clips, Veo generations, Qwen3-TTS narration (Ryan), and full frame rendering (4697 frames, 40MB MP4) succeeded completely, the stage failed right at the automated visual QA check.

## Root Cause Analysis
1. `src/tutorial/index.ts` creates directory `tutorialDir = path.join(params.outDir, TUTORIAL_DIRNAME)` (i.e. `artifacts/.../tutorial`).
2. `createTutorialVideo` delegates player and render generation to `produceExplainerVideo`:
   ```typescript
   const summary = await produceExplainerVideo({
     outDir: params.outDir,
     // explainerDirname / tutorialDirname NOT PASSED
   ```
3. In `produceExplainerVideo` (`src/modules/explainer-video/produce.ts`):
   ```typescript
   const explainerDirname = options.explainerDirname ?? options.tutorialDirname ?? EXPLAINER_DEFAULTS.explainerDirname;
   ```
   Because neither was passed from `createTutorialVideo`, it defaulted to `'explainer'`, and created `artifacts/.../explainer/` where it placed `tutorial.json`, `explainer-player.html`, `explainer-video.mp4`, etc.
4. When `afterRender` was executed:
   ```typescript
   afterRender: async () => {
     const qa = await runTutorialVisualQa({
       tutorialDir, // Passed 'artifacts/.../tutorial' instead of where tutorial.json was written!
   ```
   `tutorialDir` did not have `tutorial.json` (which was written to `explainer/`), causing an immediate `ENOENT` exception and marking `tutorial-gen` failed.

## Proposed Fix
1. **Pass directory configurations explicitly to `produceExplainerVideo`**:
   - In `src/tutorial/index.ts`:
     Pass `explainerDirname: TUTORIAL_DIRNAME` (and `tutorialDirname: TUTORIAL_DIRNAME`) to `produceExplainerVideo`.
     This ensures all generated files (`tutorial.json`, `explainer.json`, player HTML, and videos) land in `<outDir>/tutorial/`, matching FlowTutor's expected directory layout.
   - Support `videoFilename: TUTORIAL_VIDEO_FILENAME` ('tutorial-video.mp4') and `gridFilename: 'tutorial-grid.jpg'` in `produceExplainerVideo` options.
   - For backwards compatibility, ensure both `tutorial-video.mp4` and `explainer-video.mp4` exist (via symlink or copy if necessary).
2. **Robust QA directory resolution**:
   - In `afterRender`, use `explainerDir` from the context (`afterRender: async ({ explainerDir }) => ...`), fallback to `tutorialDir`, and ensure `tutorial.json` exists or resolve from `explainerDir`.
3. **Verify and build**:
   - Run unit tests and compilation (`npm run build`).
   - Clean up any test artifacts.
