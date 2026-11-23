import test from 'node:test';
import assert from 'node:assert/strict';
import { createAttributionBrowserAdapter } from './attribution-browser-adapter';

const handoffPath = '/api/attribution/v1/handoffs';
const request = { requestId: `ar_v1_${'a'.repeat(32)}`, other: 'synthetic-only' };

test('browser adapter pins the first-party API request and omits credentials', async () => {
  let captured: { url: string; init: RequestInit } | undefined;
  const adapter = createAttributionBrowserAdapter(
    { location: { origin: 'https://lksdisplaybox.online' } } as Window,
    (async (input, init) => {
      captured = { url: String(input), init: init! };
      return Response.json({ shortCode: 'LKS-0000000000000000' }, { status: 201 });
    }) as typeof fetch,
  );
  const result = await adapter.create(handoffPath, request, { 'Idempotency-Key': request.requestId }) as { shortCode: string };
  assert.equal(result.shortCode, 'LKS-0000000000000000');
  assert.equal(captured?.url, `https://quote.lksdisplaybox.online${handoffPath}`);
  assert.equal(captured?.init.method, 'POST');
  assert.equal(captured?.init.mode, 'cors');
  assert.equal(captured?.init.credentials, 'omit');
  assert.equal(captured?.init.redirect, 'error');
  assert.equal(captured?.init.referrerPolicy, 'no-referrer');
  assert.deepEqual(captured?.init.headers, {
    'Content-Type': 'application/json',
    'Idempotency-Key': request.requestId,
  });
  assert.equal(new URL(captured!.url).search, '');
});

test('browser adapter rejects opaque, unapproved and malformed calls before fetch', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return Response.json({}, { status: 201 });
  }) as typeof fetch;
  for (const origin of ['null', 'https://evil.example.test', 'https://quote.lksdisplaybox.online']) {
    const adapter = createAttributionBrowserAdapter({ location: { origin } } as Window, fetchImpl);
    await assert.rejects(adapter.create(handoffPath, request, { 'Idempotency-Key': request.requestId }));
    await assert.rejects(adapter.revoke('/api/attribution/v1/revoke', {}));
  }
  const allowed = createAttributionBrowserAdapter(
    { location: { origin: 'https://lksdisplaybox.online' } } as Window,
    fetchImpl,
  );
  await assert.rejects(allowed.create(`${handoffPath}?campaign=x`, request, { 'Idempotency-Key': request.requestId }));
  await assert.rejects(allowed.create('/arbitrary', request, { 'Idempotency-Key': request.requestId }));
  await assert.rejects(allowed.create(handoffPath, request, { 'Idempotency-Key': 'mismatch' }));
  assert.equal(calls, 0);
});
