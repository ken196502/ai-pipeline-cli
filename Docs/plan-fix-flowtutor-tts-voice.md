# Fix FlowTutor Qwen3-TTS Default Voice Implementation Plan

## Problem Statement
During the FlowTutor pipeline execution (stage `tutorial-gen`), the narration synthesis failed with:
`Qwen3-TTS synthesis failed: Value: local-clone is not in the list of choices: ['Aiden', 'Dylan', 'Eric', 'Ono_anna', 'Ryan', 'Serena', 'Sohee', 'Uncle_fu', 'Vivian']`

## Root Cause Analysis
When migrating from legacy local clone TTS to Qwen3-TTS:
1. `src/tutorial/index.ts` line 155 defaulted `params.ttsVoice` to `'local-clone'`.
2. `src/tutorial/tts.ts` lines 510 and 844 defaulted `params.voice` / `options.voice` to `'local-clone'`.
3. `src/libs/player/tts.ts` lines 554 and 891 defaulted `params.voice` / `options.voice` to `'local-clone'`.
4. As a result, when no explicit voice parameter was provided to the FlowTutor pipeline CLI / executor, `'local-clone'` was sent as the `speaker` argument to Qwen3-TTS Gradio 5 API, which rejected the value since it expects one of `['Aiden', 'Dylan', 'Eric', 'Ono_anna', 'Ryan', 'Serena', 'Sohee', 'Uncle_fu', 'Vivian']`.

## Proposed Fixes
1. **Update defaults in Tutorial & Player TTS modules**:
   - Change `src/tutorial/index.ts`: `const voice = params.ttsVoice || 'Ryan';`
   - Change `src/tutorial/tts.ts`:
     - Line 510: `voice: options.voice || 'Ryan'`
     - Line 844: `const voice = params.voice || 'Ryan'`
   - Change `src/libs/player/tts.ts`:
     - Line 554: `voice: options.voice || 'Ryan'`
     - Line 891: `const voice = params.voice || 'Ryan'`
2. **Prevent legacy 'local-clone' string from leaking into Qwen3-TTS**:
   - In `src/tutorial/tts.ts` and `src/libs/player/tts.ts` within `synthesizeNarrationSegment`: if `options.voice === 'local-clone'` or falsy, normalize it to `'Ryan'` before calling `synthesizeQwen3Tts`.
3. **Build & Verify**:
   - Recompile TypeScript with `npm run build`.
   - Run TTS unit tests / verification scripts.
   - Clean up any test processes and artifacts.
