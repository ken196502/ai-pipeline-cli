# Fix Final Showcase Video Freeze Duration Plan

## Problem Statement
In the generated tutorial video, the last ~13 seconds are completely frozen/static.

## Root Cause Analysis
1. In `src/tutorial/tts.ts` and `src/libs/player/tts.ts` inside `buildOpusVoiceTrack`:
   ```typescript
   for (let li = 0; li < shot.elements.length; li += 1) {
     const isFinalVideo = refId === 'final-ai-video';
     if (isFinalVideo) {
       aDur = finalDur;
       ...
       audioParts.push(segWavPath);
     }
     ...
     currentCursor += aDur;
   }
   ```
2. The final showcase clip's shot has 2 elements:
   ```json
   "elements": [
     ["Final voiced AI video", "final-ai-video"],
     ["Complete generated sequence", "final-ai-video"]
   ]
   ```
3. Because both elements reference `final-ai-video`:
   - Line 0 pushed `finalDur` (12.051s) to the audio track and added line gap (0.12s).
   - Line 1 pushed `finalDur` (12.051s) AGAIN to the audio track.
   - Result: `shot.vDur` became `24.223s` (12.05s * 2).
4. In `player.ts`, `drawVisualCell`:
   ```javascript
   var targetT = isFinal ? Math.min(dur, Math.max(0, sl * rate)) : ((sl * rate) % dur);
   ```
   The final video has `dur = 12.051s`.
   Once `sl` exceeds `12.051s` (at the halfway mark of the 24.223s shot), `targetT` stays clamped at `12.051s`.
   The video stops playing and displays a frozen frame for the remaining 12.17 seconds (the last ~13 seconds).

## Proposed Fix
1. In `buildOpusVoiceTrack` (`src/tutorial/tts.ts` and `src/libs/player/tts.ts`):
   - Track `finalVideoHandledInShot = false` per shot.
   - For `isFinalVideo`:
     - If `finalVideoHandledInShot` is already true, set `aDur = 0` and do not re-extract audio, do not push silence, and do not add line gap.
     - Only the first occurrence in the shot allocates `aDur = finalDur` and extracts/adds audio.
   - This ensures the final showcase shot duration matches `finalDur` exactly (12.05s).
2. Clean rebuild:
   - Compile code with `npm run build`.
   - Re-render the tutorial video so it ends smoothly when the final video finishes without any static freeze.
   - Verify duration and send to Telegram.
