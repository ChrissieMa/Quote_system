import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import {
  ADMIN_SESSION_COOKIE,
  LoginRateLimiter,
  adminSessionCookie,
  clearAdminSessionCookie,
  formatDeterministicPublicToken,
  generatePublicToken,
  isSameOriginWrite,
  isValidPublicToken,
  issueAdminSession,
  parseCookies,
  sanitizeAdminNextPath,
  verifyAdminSession,
} from './security';

test('admin session is signed, expires, and rejects tampering', () => {
  const now = 1_800_000_000_000;
  const token = issueAdminSession('owner', 'a-session-secret-with-enough-entropy', now);
  assert.equal(verifyAdminSession(token, 'owner', 'a-session-secret-with-enough-entropy', now + 1000), true);
  assert.equal(verifyAdminSession(`${token}x`, 'owner', 'a-session-secret-with-enough-entropy', now + 1000), false);
  assert.equal(verifyAdminSession(token, 'someone-else', 'a-session-secret-with-enough-entropy', now + 1000), false);
  assert.equal(verifyAdminSession(token, 'owner', 'a-session-secret-with-enough-entropy', now + 8 * 60 * 60 * 1000 + 1), false);
});

test('admin cookies use strict browser protections', () => {
  const header = adminSessionCookie('signed-value');
  assert.match(header, new RegExp(`^${ADMIN_SESSION_COOKIE}=`));
  assert.match(header, /HttpOnly/);
  assert.match(header, /Secure/);
  assert.match(header, /SameSite=Strict/);
  assert.match(clearAdminSessionCookie(), /Max-Age=0/);
  assert.equal(parseCookies(`${ADMIN_SESSION_COOKIE}=abc.def; another=value`)[ADMIN_SESSION_COOKIE], 'abc.def');
});

test('admin next paths cannot redirect off-site or carry arbitrary query data', () => {
  assert.equal(sanitizeAdminNextPath('/admin/costs'), '/admin/costs');
  assert.equal(sanitizeAdminNextPath('/quotes'), '/quotes');
  assert.equal(sanitizeAdminNextPath('https://evil.example'), '/quotes');
  assert.equal(sanitizeAdminNextPath('//evil.example'), '/quotes');
  assert.equal(sanitizeAdminNextPath('/invoice/secret'), '/quotes');
});

test('admin writes accept configured and current deployment origins but reject cross-site requests', () => {
  assert.equal(isSameOriginWrite('https://quote.example', '', 'https://quote.example'), true);
  assert.equal(isSameOriginWrite('', 'https://quote.example/admin', 'https://quote.example'), true);
  assert.equal(isSameOriginWrite(
    'https://quote.lksdisplaybox.online',
    '',
    'http://localhost:3000',
    'https://quote.lksdisplaybox.online',
  ), true);
  assert.equal(isSameOriginWrite(
    'https://service-production.up.railway.app',
    '',
    'https://quote.lksdisplaybox.online',
    'https://service-production.up.railway.app',
  ), true);
  assert.equal(isSameOriginWrite(
    '',
    '',
    'https://quote.example',
    'https://quote.example',
    'same-origin',
  ), true);
  assert.equal(isSameOriginWrite('https://evil.example', '', 'https://quote.example'), false);
  assert.equal(isSameOriginWrite(
    '',
    '',
    'https://quote.example',
    'https://quote.example',
    'cross-site',
  ), false);
  assert.equal(isSameOriginWrite('', '', 'https://quote.example'), false);
});

test('login limiter blocks repeated failures and clears on success', () => {
  const limiter = new LoginRateLimiter(2, 60_000);
  assert.equal(limiter.check('ip', 1000).allowed, true);
  limiter.fail('ip', 1000);
  assert.equal(limiter.check('ip', 1001).allowed, true);
  limiter.fail('ip', 1002);
  assert.equal(limiter.check('ip', 1003).allowed, false);
  limiter.success('ip');
  assert.equal(limiter.check('ip', 1004).allowed, true);
});

test('v2 public tokens use 256 random bits and reject legacy, wrong, future, and expired formats', () => {
  const now = 1_800_000_000_000;
  const token = generatePublicToken(now);
  assert.equal(isValidPublicToken(token, now + 1000), true);
  assert.equal(isValidPublicToken('7c7ecbe0bebc808a6d9780e94c3ae4a0', now), false);
  assert.equal(isValidPublicToken('v2_invalidtoken', now), false);
  assert.equal(isValidPublicToken(generatePublicToken(now + 10 * 60 * 1000), now), false);
  assert.equal(isValidPublicToken(token, now + 2000, 1000), false);
  const randomPart = token.match(/^v2_[0-9a-z]+_(.+)$/)?.[1] || '';
  assert.equal(Buffer.from(randomPart, 'base64url').length, 32);
});

test('deterministic v2 tokens remain stable for internal idempotent quote creation', () => {
  const issuedAt = 1_800_000_000_000;
  const digest = crypto.createHash('sha256').update('same-confirmation').digest();
  const first = formatDeterministicPublicToken(issuedAt, digest);
  const second = formatDeterministicPublicToken(issuedAt, digest);
  assert.equal(first, second);
  assert.equal(isValidPublicToken(first, issuedAt + 1000), true);
});
