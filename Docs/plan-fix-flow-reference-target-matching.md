# Plan: Fix Target Card Aiming in resolveReferenceTarget

## 1. Problem Diagnosis
In Flow generation for clip 7 end-image:
```text
Refusing to right-click the wrong card: could not aim at image card "https://flow.google.com/asb/ANqvLOa9wfQiTzXIcVVL4HCsAkrjersbISL5g_PfIuvUMJcKgaWp2CclVbDeNeSPdeTxPigYOTaTHyg1gKPH3SaGMt2PtFU0cjdj2tVP9laa_xVgDJEaBY21MGQo1ac-dLr_jp1i8oCK9jm7GUG7OUjE1ifhrbOrBqJQ_IAPilEvzA=s1600-rw" — no image card found on canvas (mounted image keys: d799dace, 1a8d6909, a05d69b9, 7113f7cd, a29ecf19, 005adcee, f646d27b, 88900c20).
```
### Root Cause:
1. When generating `clip-007 end-image`, the caller passes `referenceKey: clip.imageTileKey` and `referenceSrc: clip.imageUrl`.
2. For clip 7 start-image, `clip.imageUrl` was a proxied `/asb/` URL:
   `https://flow.google.com/asb/ANqvLOa9wfQi...`
   and `clip.imageTileKey` was `file:76df6dd0685a6e7a1c220a763a141516c532fe2d`.
3. In `resolveReferenceTarget`, it checks:
   ```ts
   const matchKey = params.referenceKey && params.canvasKeys.has(params.referenceKey) ? params.referenceKey : null;
   const matchSrc = !matchKey && params.referenceSrc ? params.referenceSrc : null;
   return { matchKey, matchSrc };
   ```
   Notice that `matchSrc` was NOT validated against `canvasKeys`!
   Even when the URL is an ephemeral, expired, or non-matching proxy URL that does not exist in `canvasKeys`, `matchSrc` was returned as non-null.
4. As a result, `rightClickImageTile` received `matchSrc` and tried 6 times to find that exact URL on the canvas. Since the URL was not on the canvas, it threw:
   `Refusing to right-click the wrong card: could not aim at image card ...`
   instead of gracefully falling back to the latest image card (or skipping referencing if not present).

## 2. Solution
1. **Fix `resolveReferenceTarget` in `src/flow/client/clip-image.ts`**:
   Ensure `matchSrc` is also validated against `params.canvasKeys.has(params.referenceSrc)`.
   If neither `matchKey` nor `matchSrc` is present on the canvas:
   - For `referenceMode === 'optional'` (cut / 切分镜 clips), if no match is found, do NOT pass a stale `matchSrc` into `rightClickImageTile`. Log a warning and fall back to `matchKey: null, matchSrc: null` (which targets the latest image card on the canvas, or skips if none).
2. **Reset Clip 7 in script JSON**:
   Reset `clip.status = 'pending'` and clear `error` in `9-flow-video-script.json`.
3. **Verify and Rerun**:
   Run tests to verify `resolveReferenceTarget`.
   Restart `flowtutor-resume` session.
