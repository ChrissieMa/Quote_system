import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { createAttributionRouter } from './attribution-router';
import { LocalAttributionStore } from './attribution-store';
import { issueAdminSession, verifyAdminSession, safeEqual, isSameOriginWrite } from './security';
import { AttributionRateLimit } from './attribution-rate-limit';

const now = Date.parse('2026-01-01T00:00:00Z');
const origin = 'https://lksdisplaybox.online';
const ownerOrigin = 'https://owner.example.test';
const sessionSecret = 'synthetic-session-secret';
const csrf = 'synthetic-owner-csrf';
const id = `ar_v1_${'a'.repeat(32)}`;
const aid = `aid_v1_${'b'.repeat(32)}`;
const touch = {
  observedAt: '2026-01-01T00:00:00Z', channel: 'direct', source: '(direct)', medium: '(none)',
  campaignKey: null, landingPath: '/', evidence: 'direct_observed', confidence: 'signal_limited',
};
const body = {
  contractVersion: '1.0.0', requestId: id, attributionId: aid, firstTouch: touch, lastTouch: touch,
  entrySurface: 'wordpress',
  consent: { ad_storage: 'granted', analytics_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted' },
};

test('rate limit bounds per-client requests and stored client state', () => {
  const limiter = new AttributionRateLimit(2, 1000, 1);
  assert.equal(limiter.allow('one', now), true);
  assert.equal(limiter.allow('one', now), true);
  assert.equal(limiter.allow('one', now), false);
  assert.equal(limiter.allow('two', now), false);
  assert.equal(limiter.allow('two', now + 1000), true);
});

test('isolated HTTP routes enforce origin, authentication, CSRF, body limits and revocation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'attribution-http-'));
  const store = new LocalAttributionStore(join(dir, 'store.sqlite'), Buffer.alloc(32, 2));
  const app = express();
  let allowed = true;
  app.use(createAttributionRouter({
    enabled: true, store, validation: { publicPaths: new Set(['/']), campaignKeys: new Set() }, now: () => now,
    allowRequest: () => allowed,
    requireOwner: (req, res, next) => {
      if (verifyAdminSession(req.get('x-test-session') || '', 'owner', sessionSecret, now)) next();
      else res.sendStatus(401);
    },
    requireOwnerOriginAndCsrf: (req, res, next) => {
      if (isSameOriginWrite(req.get('origin'), '', ownerOrigin) && safeEqual(req.get('x-csrf-token') || '', csrf)) next();
      else res.sendStatus(403);
    },
    reportError: message => { throw new Error(message); },
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const preflight = (path: string, originValue: string, method: string, headers: string) => fetch(base + path, {
    method: 'OPTIONS',
    headers: {
      origin: originValue,
      'access-control-request-method': method,
      'access-control-request-headers': headers,
    },
  });
  const post = (path: string, value: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value),
  });
  const publicHeaders = { origin, 'idempotency-key': id };
  const ownerHeaders = {
    origin: ownerOrigin, 'x-test-session': issueAdminSession('owner', sessionSecret, now), 'x-csrf-token': csrf,
  };
  try {
    const acceptedPreflight = await preflight('/api/attribution/v1/handoffs', origin, 'POST', 'content-type, idempotency-key');
    assert.equal(acceptedPreflight.status, 204);
    assert.equal(acceptedPreflight.headers.get('access-control-allow-origin'), origin);
    assert.equal(acceptedPreflight.headers.get('access-control-allow-methods'), 'POST');
    assert.equal(acceptedPreflight.headers.get('access-control-allow-headers'), 'Content-Type, Idempotency-Key');
    assert.equal(acceptedPreflight.headers.get('access-control-allow-credentials'), null);
    assert.notEqual(acceptedPreflight.headers.get('access-control-allow-origin'), '*');
    for (const [invalidOrigin, method, headers] of [
      ['null', 'POST', 'content-type'],
      ['https://evil.example.test', 'POST', 'content-type'],
      [origin, 'GET', 'content-type'],
      [origin, 'POST', 'authorization'],
    ]) {
      assert.equal((await preflight('/api/attribution/v1/handoffs', invalidOrigin, method, headers)).status, 403);
    }
    assert.equal((await post('/api/attribution/v1/handoffs', body, { ...publicHeaders, origin: 'https://other.example.test' })).status, 403);
    assert.equal((await post('/api/attribution/v1/handoffs?gclid=synthetic', body, publicHeaders)).status, 422);
    allowed = false;
    assert.equal((await post('/api/attribution/v1/handoffs', body, publicHeaders)).status, 429);
    allowed = true;
    assert.equal((await post('/api/attribution/v1/handoffs', { ...body, raw: 'x'.repeat(9000) }, publicHeaders)).status, 422);
    assert.equal((await post('/api/attribution/v1/handoffs', { ...body, raw: 'x' }, publicHeaders)).status, 422);
    assert.equal((await post('/api/attribution/v1/handoffs', body, { ...publicHeaders, 'idempotency-key': 'wrong' })).status, 422);
    const denied = await post('/api/attribution/v1/handoffs', { ...body, consent: { ...body.consent, ad_storage: 'denied' } }, publicHeaders);
    assert.equal((await denied.json() as { outcome: string }).outcome, 'unknown');
    const unknownTouch = { ...touch, channel: 'unknown', source: 'unknown', medium: 'unknown', evidence: 'none', confidence: 'unknown' };
    const unsupported = await post('/api/attribution/v1/handoffs', { ...body, firstTouch: unknownTouch, lastTouch: unknownTouch }, publicHeaders);
    assert.equal((await unsupported.json() as { outcome: string }).outcome, 'unknown');
    const createdResponse = await post('/api/attribution/v1/handoffs', body, publicHeaders);
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { shortCode: string; revocationProof: string };
    assert.equal((await post('/api/attribution/v1/handoffs', body, publicHeaders)).status, 200);
    assert.equal((await post('/api/attribution/v1/handoffs', { ...body, entrySurface: 'configurator' }, publicHeaders)).status, 409);
    assert.equal((await post('/api/attribution/v1/handoffs', { ...body, consent: { ...body.consent, ad_storage: 'denied' } }, publicHeaders)).status, 409);
    const resolveBody = { contractVersion: '1.0.0', shortCode: created.shortCode };
    assert.equal((await post('/admin/attribution/v1/resolve', resolveBody)).status, 401);
    assert.equal((await post('/admin/attribution/v1/resolve', resolveBody, { ...ownerHeaders, 'x-csrf-token': 'wrong' })).status, 403);
    assert.equal((await post('/admin/attribution/v1/resolve', resolveBody, { ...ownerHeaders, origin })).status, 403);
    assert.equal((await (await post('/admin/attribution/v1/resolve', resolveBody, ownerHeaders)).json() as { outcome: string }).outcome, 'matched');
    const ambiguous = { ...resolveBody, shortCode: `[${created.shortCode}] [LKS-1111111111111111]` };
    assert.equal((await (await post('/admin/attribution/v1/resolve', ambiguous, ownerHeaders)).json() as { outcome: string }).outcome, 'unknown');
    const unknownMarker = { ...resolveBody, shortCode: `[${created.shortCode}] [LKS-UNKNOWN]` };
    assert.equal((await (await post('/admin/attribution/v1/resolve', unknownMarker, ownerHeaders)).json() as { outcome: string }).outcome, 'unknown');
    const revokeBody = { contractVersion: '1.0.0', attributionId: aid, revocationProof: created.revocationProof };
    assert.equal((await post('/api/attribution/v1/revoke', revokeBody, { origin })).status, 204);
    assert.equal((await (await post('/admin/attribution/v1/resolve', resolveBody, ownerHeaders)).json() as { outcome: string }).outcome, 'unknown');
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
