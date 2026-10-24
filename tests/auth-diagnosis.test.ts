import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchXChallengeUrl,
  matchXLoginFailureUrl,
  classifyXLoginDom,
  diagnoseXLoginPage,
} from '../src/modules/auth/auth.js';
import type { XDomProbe } from '../src/modules/auth/contracts.js';

function probe(partial: Partial<XDomProbe>): XDomProbe {
  return {
    hasCodeInput: false,
    hasVisibleCaptcha: false,
    passwordFormVisible: false,
    bodyText: '',
    ...partial,
  };
}

test('matchXChallengeUrl recognises X verification URLs', () => {
  assert.ok(matchXChallengeUrl('https://x.com/signup_phone'));
  assert.ok(matchXChallengeUrl('https://x.com/i/flow/phone_verification'));
  assert.ok(matchXChallengeUrl('https://x.com/account/access'));
  assert.ok(matchXChallengeUrl('https://x.com/i/flow/login_verification'));
  assert.ok(matchXChallengeUrl('https://x.com/challenge'));
});

test('matchXChallengeUrl ignores normal login/home URLs', () => {
  assert.equal(matchXChallengeUrl('https://x.com/i/flow/login'), null);
  assert.equal(matchXChallengeUrl('https://x.com/home'), null);
  assert.equal(matchXChallengeUrl('https://x.com/explore'), null);
});

test('matchXLoginFailureUrl flags locked accounts but not normal pages', () => {
  assert.ok(matchXLoginFailureUrl('https://x.com/account/locked'));
  assert.equal(matchXLoginFailureUrl('https://x.com/i/flow/login'), null);
});

test('classifyXLoginDom treats the verification-code input as a challenge', () => {
  const res = classifyXLoginDom(probe({ hasCodeInput: true, bodyText: 'Confirm your identity' }));
  assert.equal(res.state, 'challenge');
});

test('classifyXLoginDom treats a visible Arkose/CAPTCHA frame as a challenge', () => {
  const res = classifyXLoginDom(probe({ hasVisibleCaptcha: true }));
  assert.equal(res.state, 'challenge');
});

test('classifyXLoginDom treats SMS/email code text as a challenge', () => {
  const res = classifyXLoginDom(probe({ bodyText: 'Enter the code we sent to your phone' }));
  assert.equal(res.state, 'challenge');

  const res2 = classifyXLoginDom(probe({ bodyText: "We've detected unusual activity on your account" }));
  assert.equal(res2.state, 'challenge');
});

test('classifyXLoginDom does not mistake the normal Chinese login form for a challenge', () => {
  const res = classifyXLoginDom(
    probe({
      passwordFormVisible: true,
      bodyText: '登录 X\n手机号码、电子邮件地址或用户名\n密码\n忘记密码？\n登录',
    })
  );
  assert.equal(res.state, 'unknown');
});

test('classifyXLoginDom reports rejected credentials as failed (never a challenge)', () => {
  const res = classifyXLoginDom(
    probe({ passwordFormVisible: true, bodyText: 'Wrong password. Please try again.' })
  );
  assert.equal(res.state, 'failed');

  const res2 = classifyXLoginDom(probe({ passwordFormVisible: true, bodyText: '密码错误，请重试' }));
  assert.equal(res2.state, 'failed');
});

test('diagnoseXLoginPage: normal login form stays unknown (no recovery trigger)', async () => {
  const fakePage: any = {
    url: () => 'https://x.com/i/flow/login',
    context: () => ({ cookies: async () => [], addCookies: async () => {} }),
    evaluate: async () => ({
      hasCodeInput: false,
      hasVisibleCaptcha: false,
      passwordFormVisible: true,
      bodyText: '手机号码、电子邮件地址或用户名',
    }),
    $: async () => null,
  };

  const diagnosis = await diagnoseXLoginPage(fakePage);
  assert.equal(diagnosis.state, 'unknown');
});

test('diagnoseXLoginPage: challenge DOM yields challenge state', async () => {
  const fakePage: any = {
    url: () => 'https://x.com/i/flow/login',
    context: () => ({ cookies: async () => [], addCookies: async () => {} }),
    evaluate: async () => ({
      hasCodeInput: true,
      hasVisibleCaptcha: false,
      passwordFormVisible: false,
      bodyText: 'Confirm your phone number',
    }),
    $: async () => null,
  };

  const diagnosis = await diagnoseXLoginPage(fakePage);
  assert.equal(diagnosis.state, 'challenge');
  assert.match(diagnosis.reason, /验证/);
});

test('diagnoseXLoginPage: challenge URL short-circuits the DOM probe', async () => {
  let evaluated = false;
  const fakePage: any = {
    url: () => 'https://x.com/account/access',
    context: () => ({ cookies: async () => [], addCookies: async () => {} }),
    evaluate: async () => {
      evaluated = true;
      return { hasCodeInput: false, hasVisibleCaptcha: false, passwordFormVisible: false, bodyText: '' };
    },
    $: async () => null,
  };

  const diagnosis = await diagnoseXLoginPage(fakePage);
  assert.equal(diagnosis.state, 'challenge');
  assert.equal(evaluated, false);
});

test('ensureXLogin: a verification challenge delegates to onChallenge (reset flow)', async () => {
  process.env.X_COOKIES_FILE = '/tmp/definitely-missing-x-cookies-for-test.json';
  const { ensureXLogin } = await import('../src/modules/auth/auth.js');

  const fakePage: any = {
    url: () => 'https://x.com/signup_phone',
    context: () => ({ cookies: async () => [], addCookies: async () => {} }),
    evaluate: async () => ({
      hasCodeInput: false,
      hasVisibleCaptcha: false,
      passwordFormVisible: false,
      bodyText: '',
    }),
    $: async () => null,
    goto: async () => null,
    waitForTimeout: async () => {},
    waitForSelector: async () => null,
  };

  const calls: string[] = [];
  const result = await ensureXLogin(fakePage, {
    username: 'tester',
    password: 'secret',
    persistCookies: false,
    onChallenge: async (diagnosis) => {
      calls.push(diagnosis.reason);
      return { loggedIn: true, page: fakePage, recovered: true, reason: diagnosis.reason };
    },
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0], /手机号验证/);
  assert.equal(result.recovered, true);
});

test('ensureXLogin: a normal login form never triggers onChallenge', async () => {
  process.env.X_COOKIES_FILE = '/tmp/definitely-missing-x-cookies-for-test.json';
  const { ensureXLogin } = await import('../src/modules/auth/auth.js');

  let url = 'https://x.com/i/flow/login';
  const fakePage: any = {
    url: () => url,
    context: () => ({ cookies: async () => [], addCookies: async () => {} }),
    evaluate: async () => ({
      hasCodeInput: false,
      hasVisibleCaptcha: false,
      passwordFormVisible: true,
      bodyText: '手机号码、电子邮件地址或用户名',
    }),
    $: async (sel: string) => {
      if (sel.includes('username')) {
        return { isVisible: async () => true, click: async () => {}, fill: async () => {}, press: async () => {} };
      }
      return null;
    },
    goto: async () => null,
    waitForTimeout: async () => {},
    waitForSelector: async () => null,
  };

  let challenged = false;
  await ensureXLogin(fakePage, {
    username: 'tester',
    password: 'secret',
    timeoutMs: 1,
    persistCookies: false,
    onChallenge: async (diagnosis) => {
      challenged = true;
      return { loggedIn: true, page: fakePage, recovered: true, reason: diagnosis.reason };
    },
  }).catch(() => {
    // "unknown" (no success / no blocker) is the expected outcome and throws.
  });

  assert.equal(challenged, false);
});
