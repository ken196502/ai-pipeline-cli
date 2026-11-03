import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import type { Page } from 'playwright-core';
import { adoptOrphanBrowser, readSessionInfo, spawnDetachedChromium } from '../src/libs/browser/session.js';
import { performDirectGoogleLogin } from '../src/libs/browser/direct-login.js';

async function temporaryProfile(t: TestContext): Promise<string> {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flowtutor-browser-fixes-'));
  t.after(() => fs.rm(profileDir, { recursive: true, force: true }));
  return profileDir;
}

test('orphan adoption requires matching lock PID, profile, debugging port and live CDP', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('Linux /proc ownership check');
    return;
  }
  const profileDir = await temporaryProfile(t);
  await fs.symlink('host-with-hyphens-7654321', path.join(profileDir, 'SingletonLock'));
  const originalReadFile = fs.readFile.bind(fs);
  let cmdline = `chromium\0--user-data-dir=${profileDir}\0--remote-debugging-port=9229\0`;
  t.mock.method(fs, 'readFile', async (file: string, ...args: any[]) => {
    if (file === '/proc/7654321/cmdline') return cmdline;
    return originalReadFile(file, ...args);
  });
  let pidAlive = true;
  t.mock.method(process, 'kill', () => {
    if (!pidAlive) throw new Error('No such process');
    return true;
  });
  let cdpAlive = true;
  const probe = t.mock.method(globalThis, 'fetch', async () => {
    if (!cdpAlive) throw new Error('Connection refused');
    return Response.json({ webSocketDebuggerUrl: 'ws://127.0.0.1:9229/devtools/browser/test' });
  });

  const adopted = await adoptOrphanBrowser(profileDir);
  assert.equal(adopted?.pid, 7654321);
  assert.equal(adopted?.port, 9229);
  assert.equal((await readSessionInfo(profileDir))?.wsEndpoint, adopted?.wsEndpoint);

  cmdline = `chromium\0--user-data-dir=${profileDir}-other\0--remote-debugging-port=9229\0`;
  assert.equal(await adoptOrphanBrowser(profileDir), null);
  cmdline = `chromium\0--user-data-dir=${profileDir}\0`;
  assert.equal(await adoptOrphanBrowser(profileDir), null);
  pidAlive = false;
  assert.equal(await adoptOrphanBrowser(profileDir), null);
  assert.equal(probe.mock.callCount(), 1, 'Rejected ownership must not probe CDP');
  pidAlive = true;
  cmdline = `chromium\0--user-data-dir=${profileDir}\0--remote-debugging-port=9229\0`;
  cdpAlive = false;
  assert.equal(await adoptOrphanBrowser(profileDir), null);
});

function mockChromium(t: TestContext, mode: 'running' | 'exited' | 'spawn-error' | 'sync-error') {
  const kills: Array<[number, string | number | undefined]> = [];
  t.mock.method(process, 'kill', (pid: number, signal?: string | number) => {
    kills.push([pid, signal]);
    return true;
  });
  t.mock.method(childProcess, 'spawn', () => {
    if (mode === 'sync-error') throw new Error('spawn Chromium argument error');
    const child = Object.assign(new EventEmitter(), {
      pid: mode === 'spawn-error' ? undefined : 7654321,
      exitCode: mode === 'exited' ? 1 : null,
      signalCode: null,
      unref() {},
    });
    queueMicrotask(() => {
      if (mode === 'spawn-error') child.emit('error', new Error('spawn Chromium ENOENT'));
      else child.emit('spawn');
    });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return kills;
}

test('Chromium early exit and spawn errors fail immediately and clear stale metadata', async (t) => {
  for (const mode of ['exited', 'spawn-error', 'sync-error'] as const) {
    await t.test(mode, async (t) => {
      const profileDir = await temporaryProfile(t);
      await fs.writeFile(path.join(profileDir, '.browser-session.json'), '{}');
      const kills = mockChromium(t, mode);
      const probe = t.mock.method(globalThis, 'fetch', () => {
        throw new Error('CDP must not be probed');
      });
      await assert.rejects(spawnDetachedChromium({
        executablePath: '/test/chromium', args: [], profileDir, port: 9229,
      }), mode === 'exited' ? /Chromium exited before CDP was ready/ : mode === 'spawn-error' ? /ENOENT/ : /argument error/);
      assert.equal(probe.mock.callCount(), 0);
      assert.equal(await readSessionInfo(profileDir), null);
      if (mode === 'exited') assert.ok(kills.some(([pid, signal]) => pid === -7654321 && signal === 'SIGKILL'));
    });
  }
});

test('Chromium timeout defaults to 90s, validates the environment override and kills the process group', async (t) => {
  for (const [override, expected] of [[undefined, 90_000], ['invalid', 90_000], ['4999', 90_000], ['5000', 5000], ['120000', 120_000]] as const) {
    await t.test(String(override), async (t) => {
      const previous = process.env.CDP_START_TIMEOUT_MS;
      if (override === undefined) delete process.env.CDP_START_TIMEOUT_MS;
      else process.env.CDP_START_TIMEOUT_MS = override;
      t.after(() => {
        if (previous === undefined) delete process.env.CDP_START_TIMEOUT_MS;
        else process.env.CDP_START_TIMEOUT_MS = previous;
      });
      const profileDir = await temporaryProfile(t);
      await fs.writeFile(path.join(profileDir, '.browser-session.json'), '{}');
      const kills = mockChromium(t, 'running');
      t.mock.method(globalThis, 'fetch', async () => { throw new Error('Connection refused'); });
      let clockReads = 0;
      t.mock.method(Date, 'now', () => clockReads++ < 2 ? 0 : expected);
      await assert.rejects(spawnDetachedChromium({
        executablePath: '/test/chromium', args: [], profileDir, port: 9229,
      }), new RegExp(`within ${expected}ms`));
      assert.ok(kills.some(([pid, signal]) => pid === -7654321 && signal === 'SIGKILL'));
      assert.equal(await readSessionInfo(profileDir), null);
    });
  }
});

test('Chromium session persistence errors are rethrown after process cleanup', async (t) => {
  const profileDir = await temporaryProfile(t);
  const kills = mockChromium(t, 'running');
  t.mock.method(globalThis, 'fetch', async () => Response.json({ webSocketDebuggerUrl: 'ws://test' }));
  t.mock.method(fs, 'writeFile', async () => { throw new Error('Session disk is read-only'); });
  await assert.rejects(spawnDetachedChromium({
    executablePath: '/test/chromium', args: [], profileDir, port: 9229,
  }), /Session disk is read-only/);
  assert.ok(kills.some(([pid, signal]) => pid === -7654321 && signal === 'SIGKILL'));
});

test('direct login preserves cookies and stays on challenges before and after password submission', async (t) => {
  for (const scenario of ['existing-cookie', 'no-cookie', 'challenge-dom', 'password-timeout', 'navigation-error'] as const) {
    await t.test(scenario, async (t) => {
      const previousPassword = process.env.GOOGLE_LOGIN_PWD;
      process.env.GOOGLE_LOGIN_PWD = 'test-password';
      t.after(() => {
        if (previousPassword === undefined) delete process.env.GOOGLE_LOGIN_PWD;
        else process.env.GOOGLE_LOGIN_PWD = previousPassword;
      });
      const logs: string[] = [];
      t.mock.method(console, 'log', (message: string) => logs.push(message));
      let now = 0;
      t.mock.method(Date, 'now', () => now);
      let url = 'https://www.youtube.com';
      const navigations: string[] = [];
      const storageClears: string[] = [];
      let submitted = false;
      const page = {
        url: () => url,
        context: () => ({
          cookies: async () => scenario === 'existing-cookie' ? [{ name: 'SID' }] : [],
          newCDPSession: async () => ({
            send: async (_command: string, options: { origin: string }) => storageClears.push(options.origin),
            detach: async () => {},
          }),
        }),
        goto: async (target: string) => {
          navigations.push(target);
          if (scenario === 'navigation-error') throw new Error('ServiceLogin navigation failed');
          url = scenario === 'existing-cookie' || scenario === 'no-cookie'
            ? 'https://accounts.google.com/challenge/pwd'
            : 'https://accounts.google.com/signin';
        },
        waitForTimeout: async (ms: number) => { now += ms; },
        $: async (selector: string) => {
          if (selector.includes('Passwd') && !submitted && (scenario === 'existing-cookie' || scenario === 'no-cookie')) {
            return {
              isVisible: async () => true,
              fill: async () => {},
              press: async () => { submitted = true; url = 'https://accounts.google.com/challenge/totp'; },
            };
          }
          if (selector.includes('#totpPin') && scenario === 'challenge-dom') return { isVisible: async () => true };
          return null;
        },
      } as unknown as Page;
      assert.equal(await performDirectGoogleLogin(page), false);
      assert.equal(navigations.length, scenario === 'challenge-dom' ? 0 : 1, 'No navigation may leave a challenge');
      assert.equal(storageClears.length, scenario === 'existing-cookie' || scenario === 'challenge-dom' ? 0 : 2);
      if (scenario === 'existing-cookie' || scenario === 'no-cookie') {
        assert.ok(submitted, 'Normal /challenge/pwd must accept password input');
        assert.equal(url, 'https://accounts.google.com/challenge/totp');
        assert.ok(logs.some((line) => line.includes('二次验证/挑战页')));
      }
      if (scenario === 'password-timeout') assert.ok(logs.some((line) => line.includes('未出现密码框也未出现挑战页')));
      if (scenario === 'navigation-error') assert.ok(logs.some((line) => line.includes('ServiceLogin navigation failed')));
    });
  }
});
