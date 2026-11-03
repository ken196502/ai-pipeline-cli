# Plan: Fix Flow Image Generation Timeout and Add Refresh Rescue & Retry

## 1. Problem Diagnosis
In run `flowTutor-1793604323391-9wvalm`, clip 7 start-image and video generated successfully, but clip 7 end-image failed with:
```text
Timed out after 120s waiting for new image tile. Baseline: 19 known image card(s). Use --headed to inspect the Flow UI.
```
Looking at the debug evidence:
- At `03-image-generate-clicked.png`, the prompt was submitted and an in-progress card was created (`image 0%`).
- At `image-generation-failure.png` (after 120s), the canvas showed no pending card and no active prompt. Google Flow had either finished the image in the background or dropped the frontend card update due to WebSocket/DOM disconnection.
- In `waitForVideoUrl` (for videos), `REFRESH_INTERVAL_MS` (60s) periodically reloads the page to sync server-side generation status. Furthermore, video generation has a final reload rescue.
- In `waitForNewImageTile` (for images), there was:
  1. No periodic refresh to synchronize frontend state with Google Flow server.
  2. No final reload rescue before throwing timeout.
  3. Timeout was only 120s. Flow image generation during peak hours or complex prompts can take > 90s, leaving no room for network delays.
  4. In `withRiskControlRetry`, "Timed out after ... waiting for new image tile" was NOT treated as a retryable transient generation error, so it immediately aborted the whole batch instead of refreshing the page and retrying.

## 2. Solution
1. **Extend Image Timeout and Periodic Sync in `waitForNewImageTile`**:
   - Increase default timeout from 120s to 180s.
   - At ~75s without a new card, reload/refresh the page to sync server-side state from Google Flow without cancelling the backend job.
   - Before timing out at deadline, perform a final reload rescue and inspect the canvas for the new completed image card.
2. **Make Image Generation Timeout Retryable in `withRiskControlRetry`**:
   - Update `isTransientGenerationError` to include `Timed out after \d+s waiting for new image tile`.
   - When an image generation times out, `withRiskControlRetry` will refresh the page, clear any stuck state, and retry (up to 3 attempts).
3. **Verify and Build**:
   - Run `npm run build` in `AIGC-pipeline`.
   - Test `isTransientGenerationError`.
