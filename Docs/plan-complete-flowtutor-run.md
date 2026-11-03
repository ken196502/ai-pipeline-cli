# Plan: Complete Failed / Unfinished Stages for FlowTutor Run

## 1. Problem Diagnosis
In the last FlowTutor run (`flowTutor-1793604323391-9wvalm`):
1. **Initial Pipeline Failure**:
   During Stage 12 (`flow-generate`), clips 1-6 succeeded, but clip 7 timed out waiting for the new image tile on Google Flow. Because any clip failure was treated as terminal, the pipeline aborted.
2. **Subsequent Batch Resume**:
   Later, `flowtutor-resume` was executed via `src/flow/cli.ts batch` on `9-flow-video-script.json`. Both clip 7 and clip 8 were successfully generated on Google Flow and saved to `artifacts/flowtutor/flowTutor-1793604323391-9wvalm/generated-clips/` (`clip-007.mp4`, `clip-008.mp4`, and keyframe images).
3. **Missing Downstream Stages**:
   - `flow-result.json` was overwritten with only the 2 resumed clips (clips 7 and 8) instead of all 8 clips.
   - Stage 13 (`tutorial-gen`): AI commentary tutorial video (storyboard + edge-tts narration + frame render) was never executed.
   - Stage 14 (`report`): Execution reports (`FINAL_REPORT.md`, `FINAL_REPORT.html`, `final-report.json`, `manifest.json`) were never generated.
   - The final results were never packaged and delivered back to the user via Telegram/Pi.

## 2. Implementation Steps
1. **Unify `flow-result.json`**:
   Merge the 8 completed clips from `9-flow-video-script.json` and `flow-result.json` into a complete `flow-result.json` with `totalClips: 8`, `completedClips: 8`, `failedClips: 0`, and all clip output paths pointing to `generated-clips/clip-00N.mp4`.
2. **Execute Stage 13 (`tutorial-gen`)**:
   Use `RunContext` and `createTutorialFromRun` (or `handleTutorialCommand`) on run `flowTutor-1793604323391-9wvalm` to generate:
   - AI commentary storyboard from transcript & clips
   - edge-tts audio narration
   - Headless frame render & MP4 video assembly (`tutorial/tutorial.mp4`)
   - Visual QA and grid preview (`tutorial-grid.jpg`)
3. **Execute Stage 14 (`report`)**:
   Compile `FlowTutorPipelineResult` and generate:
   - `FINAL_REPORT.md`
   - `FINAL_REPORT.html`
   - `final-report.json`
   - `manifest.json`
   Update `run.json` status to `completed`.
4. **Notify User**:
   Send the completion summary, HTML report, and tutorial video back to Telegram & Pi inbound.
5. **Execution Environment**:
   Run the long-lived render/generation task inside a named tmux session `flowtutor-finish` per project guidelines.
