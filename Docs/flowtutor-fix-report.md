# FlowTutor fix report

Implemented on 2026-11-01 in the existing working tree. No git commit was made.

## Changes by fix

**F1 — Hardened LLM JSON re-orchestration**

- `src/research/script/generator.ts:13`: import the research `chatJsonObject` wrapper; remove unused raw `chat`, `LLMError`, and `extractJsonObject` imports.
- `src/research/script/generator.ts:435`: call the hardened helper with the existing messages, model, script/task context, temperature 0.2, 300000ms timeout, and `task: 'prompt re-orchestration'`. This uses JSON mode, balanced extraction, and two repair retries through the existing helper.
- `src/research/script/generator.ts:452`: preserve `AppError` identity/code, notify, and rethrow; other exceptions retain the existing `LLM_REQUEST_FAILED` wrapping.
- `src/research/script/generator.ts:464`: assert the returned `value` and retain clips/schema validation; remove the dead local JSON parse/error branch. No failure-triggered deterministic template was introduced.
- `src/research/llm/json-chat.ts:8` and `:14`: use the helper's `ChatJsonObjectOptions` type so the plan's optional `task` label is accepted and forwarded under TS strict.

**F2 — CDP startup deadline and failure cleanup**

- `src/libs/browser/session.ts:326`: default to 90000ms; accept finite `CDP_START_TIMEOUT_MS` values >=5000. Invalid/below-floor environment values use 90000ms as explicitly required by F2; an explicit `options.timeoutMs` keeps precedence.
- `src/libs/browser/session.ts:334`: put spawn/readiness/persistence inside one failure boundary; await the spawn event so actual asynchronous spawn errors (such as ENOENT) propagate.
- `src/libs/browser/session.ts:354`: check PID liveness and child exit/signal state each poll; immediately report `Chromium exited before CDP was ready (PID ...)` when the child exits.
- `src/libs/browser/session.ts:380`: on failure, SIGKILL the process tree when a PID exists, clear session metadata, and rethrow the original error.
- `src/libs/browser/session.ts:68`: rethrow session-file write errors after logging. The existing helper previously swallowed persistence failures; propagating them is necessary for fail-fast startup/adoption and cleanup.

**F3 — Verified orphan adoption**

- `src/libs/browser/session.ts:123`: add exported `adoptOrphanBrowser`. Linux only; read Chromium's `SingletonLock` symlink target and parse the PID after the last hyphen.
- `src/libs/browser/session.ts:133`: require a live PID, an exact resolved `--user-data-dir` argument, a valid `--remote-debugging-port` argument in NUL-separated `/proc/<pid>/cmdline`, and a responsive CDP endpoint. Failed ownership checks return null without killing the process.
- `src/libs/browser/session.ts:148`: persist PID/profile/port/WebSocket endpoint/timestamps, log `[browser] Adopted orphan browser pid ... on port ...`, and return the session.
- `src/libs/browser/launcher.ts:18` and `:731`: import and attempt adoption before `isSessionAlive`; successful adoption directly enters the existing reuse branch without a second CDP probe. Existing uncommitted profile-cache changes were preserved.

**F4 — Preserve authentication and stop on challenges**

- `src/libs/browser/direct-login.ts:25`: query YouTube/Google cookies before origin cleanup; skip both destructive clears when SAPISID, SID, or LOGIN_INFO exists and emit the specified Chinese log message.
- `src/libs/browser/direct-login.ts:10`, `:20`, and `:116`: detect challenge URLs/visible challenge markers, report the current URL, and return false. Guard initial navigation and the post-password path; also stop on challenges during landing/cookie polling.
- `src/libs/browser/direct-login.ts:69` and `:78`: remove the account chooser's fixed 2s delay and the swallowed 10s password selector wait; poll for at most 15s. A visible password field wins before challenge classification, allowing Google's normal `/challenge/pwd` password form. A challenge or timeout returns false with the required concrete message.
- `src/libs/browser/direct-login.ts:9`, `:52`, and `:98`: require configured credentials when needed and use the configured email for the chooser. Remove hardcoded credential defaults to comply with the no-silent-default rule.
- `src/libs/browser/direct-login.ts:31`, `:39`, `:141`, and `:160`: propagate storage/navigation/session-activation errors instead of swallowing them; detach CDP storage sessions in `finally`; do not invent an empty YouTube request context.
- `src/libs/browser/direct-login.ts:135`, `:173`, and `:179`: log landing timeout, missing authentication cookies, and caught exceptions. Remove the final single-cookie success shortcut; success still requires LOGIN_INFO plus SAPISID/SID.

**Offline regression coverage**

- `tests/flowtutor-browser-fixes.test.ts:19`: verify hyphenated-host lock parsing, saved endpoint metadata, profile/port/PID rejection, and dead CDP rejection.
- `tests/flowtutor-browser-fixes.test.ts:89`, `:108`, and `:133`: verify early exits, asynchronous/synchronous spawn errors, timeout override boundaries, SIGKILL group cleanup, stale metadata removal, and persistence failure propagation.
- `tests/flowtutor-browser-fixes.test.ts:144`: verify auth-cookie preservation, unauthenticated storage clearing, normal password entry on `/challenge/pwd`, stopping after password submission on `/challenge/totp`, challenge DOM handling, password timeout, and navigation error logging.
- Browser/process/CDP dependencies in these tests are controlled test doubles. These tests never launch a browser or contact a remote service; production failure paths receive no fake data or success values.

## Verification commands and key output

Commands ran from `/mnt/share/VM/AIGC-pipeline`. Logs were written under `/tmp`, outside the repo.

1. `npx tsc --noEmit > /tmp/flowtutor-tsc.log 2>&1`
   - Exit 0; no diagnostics. Reran after the final production edit.
2. `timeout --signal=TERM --kill-after=5s 180s npm test > /tmp/flowtutor-npm-test.log 2>&1`
   - Exit 124: the 180-second suite deadline terminated the test process group. No test/browser/pipeline process was killed outside that group.
   - Runner summary: `tests 85`, `pass 79`, `fail 1`, `cancelled 5`, `duration_ms 179816.576576`.
   - Both FlowTutor pipeline tests and the browser regression tests completed successfully before the deadline. The Telegram bot assertion failed as detailed below.
   - Live `tests/tts-multi.test.ts` remained pending: `✓ Line 1 synthesized: 2.14s, 11 words`, followed by `[tts] Qwen3-TTS request timed out after 60s; retrying 2/3...`. The worker had run about 167s when the whole-suite deadline fired.
   - Shutdown reported `'Promise resolution is still pending but the event loop has already resolved'` for `tests/tts-multi.test.ts` and outstanding `tests/tts-qwen3.test.ts`, `tests/winner-name-check.test.ts`, `tests/xdev-history.test.ts`, and `tests/xhot-pipeline.test.ts`. These cancellation/shutdown failures do not establish assertion failures or TTS non-regression. The full suite is not green.
3. `npx tsx --test tests/flowtutor-browser-fixes.test.ts tests/flowtutor-pipeline.test.ts > /tmp/flowtutor-targeted-tests.log 2>&1`
   - Exit 0 on final code: `tests 20`, `pass 20`, `fail 0`, `cancelled 0`, `duration_ms 3014.358016`.
   - Both existing FlowTutor pipeline schema/registration tests passed.
4. `npx tsx --test tests/telegram-bot-routing.test.ts > /tmp/flowtutor-telegram-tests.log 2>&1`
   - Exit 1: `tests 18`, `pass 17`, `fail 1`.
   - Failure at `tests/telegram-bot-routing.test.ts:134`: `Expected "actual" to be strictly unequal to: 'inspilot'`; actual and expected were both `inspilot`.
   - The test assumes the repo .env bot is `main`. `rg -n '^PI_TELEGRAM_BOT=' .env` returned `23:PI_TELEGRAM_BOT=inspilot`. Notification code and .env were not changed.
5. `npx tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --esModuleInterop --strict --skipLibCheck tests/flowtutor-browser-fixes.test.ts > /tmp/flowtutor-test-types.log 2>&1`
   - Exit 0; no diagnostics. The normal tsconfig includes only src, so this separately verifies the new test under strict typing.
6. `grep -n "responseFormat" src/libs/llm/client.ts`
   - Exit 0; lines 184, 193, 323, 455. Line 455 checks `args.responseFormat === 'json_object'`; the hardened helper sets that option.
7. `grep -n "adoptOrphanBrowser" src/libs/browser/*.ts`
   - Exit 0: launcher import at 18, launcher call at 731, session definition at 123.
8. `rg -n 'CDP_START_TIMEOUT_MS|configuredTimeoutMs >= 5000|90_000|Chromium exited before CDP|killProcessTree\(pid, .SIGKILL.\)' src/libs/browser/session.ts`
   - Exit 0: environment override at 326, floor at 328, default at 330, early-exit error at 355, SIGKILL cleanup at 381.
9. `rg -n 'goto|challenge|15_000|return false|catch|clearDataForOrigin|cookies' src/libs/browser/direct-login.ts`
   - Exit 0: deadline at 78; goto calls at 39 and 141. Each detected challenge logs and returns false; no challenge branch contains or falls through to goto. Post-password check at 116 guards the YouTube goto. Regression tests verify no navigation leaves a challenge.
10. `rg -n 'extractJsonObject|await chat\(' src/research/script/generator.ts`
    - Exit 1 with no matches, as intended: the dead parser/raw chat path is gone.
11. `git diff --check`
    - Exit 0; no whitespace errors.
12. Read-only Python comparison of the initial `git diff --binary` snapshot against the current diff, permitting only the five edited source files.
    - `PASS: all unrelated tracked diffs are unchanged`. New repo files are this report and the focused regression test.

The exact diff-preservation verification command was:

```bash
python3 - <<'PY'
import subprocess
from pathlib import Path
allowed = {'src/libs/browser/session.ts', 'src/libs/browser/launcher.ts', 'src/libs/browser/direct-login.ts', 'src/research/script/generator.ts', 'src/research/llm/json-chat.ts'}
def sections(raw):
    result = {}
    for section in raw.split('diff --git ')[1:]:
        header = section.splitlines()[0]
        filename = header.split(' b/', 1)[1]
        result[filename] = section
    return result
before = sections(Path('/tmp/flowtutor-working-tree-before.diff').read_text())
after = sections(subprocess.check_output(['git', 'diff', '--binary'], text=True))
changed = sorted(p for p in before.keys() | after.keys() if before.get(p) != after.get(p))
print('Tracked files changed during task:', ', '.join(changed))
assert set(changed) <= allowed, changed
print('PASS: all unrelated tracked diffs are unchanged')
PY
```

## Residual risk and deliberately excluded work

- Real Chromium startup, live orphan adoption, Google authentication/challenges, and live LLM repair responses were not exercised; verification uses type checking, tests, and source inspection. No browser, long-running pipeline, or network render was manually started.
- Existing `npm test` includes live TTS and other service probes; its external-service outcome does not establish TTS non-regression unless it completes successfully. The Telegram configuration assertion above remains outside the requested fixes.
- Orphan adoption intentionally declines non-Linux hosts, inaccessible/missing locks or /proc data, noncanonical profile arguments, and unresponsive CDP. It does not kill processes that fail ownership verification.
- An authentication cookie only controls whether destructive storage cleanup is allowed; it does not certify a valid login. Challenges requiring human action return false and keep the page open. Per the requested ordering, a `/challenge/` URL with a password field not yet visible can be classified as a challenge.
- Persistence errors now fail callers that previously received only a warning, intentionally exposing the real failure. Credentials must be supplied through GOOGLE_LOGIN_EMAIL/GOOGLE_LOGIN_PWD when the corresponding form needs them.
- No edits to `src/pipelines/xdev/**`, `tools/**`, other plan files, package.json/scripts, .gitignore, notification configuration, or unrelated pre-existing changes. No commits or production process changes.
