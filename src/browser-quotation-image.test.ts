import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BROWSER_RENDER_REQUEST_TYPE,
  BROWSER_RENDER_RESPONSE_TYPE,
  BROWSER_TRANSPORT_PROTOCOL,
  BrowserQuotationImageBridge,
  browserQuotationImageClientHtml,
  normalizeQuotationImageRendererUrl,
  quotationImageBridgeCsp,
  quotationRenderRequestIdentity,
} from './browser-quotation-image';
import type { RenderRequestV1 } from './quotation-image';

const request: RenderRequestV1 = {
  purpose: 'quotation', product_type: 'display_box',
  dimensions: {
    unit: 'cm',
    inner: { length: 40, depth: 30, height: 35 },
    outer: { length: 42, depth: 32, height: 36 },
    actual: { length: 42, depth: 32, height: 36 },
  },
  cabinet_layers: [], accessories: [],
  colours: { body: 'clear_acrylic', background: 'light_blue_gray' },
  camera_preset: 'quotation_square_three_quarter_v2',
  output: { width: 1280, height: 1280, background: 'configured' },
  branding: { enabled: false, style: 'none' }, show_dimensions: true, show_price: false,
};

test('production browser transport accepts only a safe HTTPS renderer URL', () => {
  assert.equal(
    normalizeQuotationImageRendererUrl('https://lksdisplaybox.online/configurator/'),
    'https://lksdisplaybox.online/configurator/',
  );
  for (const value of ['*', 'http://lksdisplaybox.online/configurator/', 'https://*.lksdisplaybox.online/configurator/', 'https://lksdisplaybox.online/configurator/?token=x', 'https://user@lksdisplaybox.online/configurator/']) {
    assert.throws(() => normalizeQuotationImageRendererUrl(value));
  }
  const html = browserQuotationImageClientHtml('https://lksdisplaybox.online/configurator/');
  assert.match(html, new RegExp(BROWSER_TRANSPORT_PROTOCOL));
  assert.match(html, new RegExp(BROWSER_RENDER_REQUEST_TYPE.replaceAll('.', '\\.')));
  assert.match(html, new RegExp(BROWSER_RENDER_RESPONSE_TYPE.replaceAll('.', '\\.')));
  assert.match(html, /event\.origin !== rendererOrigin/);
  assert.match(html, /event\.source !== frame\.contentWindow/);
  assert.match(html, /postMessage\(job, rendererOrigin\)/);
  assert.doesNotMatch(html, /postMessage\([^)]*,\s*['"]\*['"]\)/);
  assert.match(html, /rendererReadinessGraceMs = 1000/);
  assert.match(html, /rendererResponseTimeoutMs = 6000/);
  assert.match(html, /activeJob = null/);
  assert.equal(
    quotationImageBridgeCsp('https://lksdisplaybox.online/configurator/'),
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src https://lksdisplaybox.online; connect-src 'self'",
  );
});

test('iframe reload clears the active job and waits for renderer readiness before polling again', () => {
  const html = browserQuotationImageClientHtml('https://lksdisplaybox.online/configurator/');
  assert.match(html, /frame\.addEventListener\('load', \(\) => \{[\s\S]*rendererReady = false;/);
  assert.match(html, /clearTimeout\(responseTimer\);[\s\S]*activeJob = null;/);
  assert.match(html, /setTimeout\(\(\) => \{ rendererReady = true; schedulePoll\(0\); \}, rendererReadinessGraceMs\);/);
});

test('browser bridge binds one pending render to its deterministic request and accepted PNG', async () => {
  const bridge = new BrowserQuotationImageBridge();
  const controller = new AbortController();
  const render = bridge.render(request, {
    idempotencyKey: `sha256:${'a'.repeat(64)}`,
    signal: controller.signal,
  });
  const job = bridge.takeNext();
  assert.equal(job?.request_id, `quote-${'a'.repeat(64)}`);
  assert.deepEqual(job?.render_request, request);
  assert.equal(bridge.takeNext(), null);
  const completion = {
    requestId: job!.request_id,
    contract: '3d-render-v1', mimeType: 'image/png', width: 1280, height: 1280,
    requestIdentity: quotationRenderRequestIdentity(request),
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
  };
  assert.equal(bridge.complete(completion), true);
  assert.equal(bridge.complete(completion), false, 'late duplicate is an exact no-op');
  const artifact = await render;
  assert.equal(artifact.width, 1280);
  assert.equal(artifact.height, 1280);
  assert.equal(bridge.pendingCount, 0);
  assert.equal(bridge.status(job!.request_id)?.state, 'processing');
  bridge.markMetadataPersisted({
    contract: 'quotation-image-v1', state: 'ready',
    idempotency_key: `sha256:${'a'.repeat(64)}`,
    asset_key: `quotation-images/${'a'.repeat(64)}.png`, attempts: 1,
    updated_at: '2026-08-24T00:00:00.000Z',
  });
  assert.equal(bridge.status(job!.request_id)?.state, 'ready');
});

test('browser bridge rejects a valid-looking request identity that is not the request hash', async () => {
  const bridge = new BrowserQuotationImageBridge({ maxDeliveries: 1 });
  const render = bridge.render(request, {
    idempotencyKey: `sha256:${'e'.repeat(64)}`,
    signal: new AbortController().signal,
  });
  const job = bridge.takeNext()!;
  assert.throws(() => bridge.complete({
    requestId: job.request_id,
    contract: '3d-render-v1', mimeType: 'image/png', width: 1280, height: 1280,
    requestIdentity: `3d-render-v1:sha256:${'f'.repeat(64)}`,
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
  }));
  bridge.fail(job.request_id, 'request-identity-mismatch');
  await assert.rejects(render);
});

test('lost first message and worker reload redeliver the same identity after a bounded lease', async () => {
  let now = 1_000;
  const bridge = new BrowserQuotationImageBridge({
    deliveryLeaseMs: 5_000,
    maxDeliveries: 3,
    now: () => now,
  });
  const render = bridge.render(request, {
    idempotencyKey: `sha256:${'9'.repeat(64)}`,
    signal: new AbortController().signal,
  });
  const first = bridge.takeNext()!;
  assert.equal(bridge.status(first.request_id)?.delivery_count, 1);
  now += 4_999;
  assert.equal(bridge.takeNext(), null);
  now += 1;
  const redelivered = bridge.takeNext()!;
  assert.deepEqual(redelivered, first);
  assert.equal(bridge.status(first.request_id)?.delivery_count, 2);
  assert.deepEqual(Object.keys(bridge.status(first.request_id)!).sort(), ['delivery_count', 'state', 'updated_at']);
  bridge.complete({
    requestId: redelivered.request_id,
    contract: '3d-render-v1', mimeType: 'image/png', width: 1280, height: 1280,
    requestIdentity: quotationRenderRequestIdentity(request),
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
  });
  assert.equal((await render).width, 1280);
});

test('a safe renderer failure requeues the same deterministic job without resolving early', async () => {
  const bridge = new BrowserQuotationImageBridge({ maxDeliveries: 3 });
  const render = bridge.render(request, {
    idempotencyKey: `sha256:${'6'.repeat(64)}`,
    signal: new AbortController().signal,
  });
  const first = bridge.takeNext()!;
  bridge.fail(first.request_id, 'quotation-image-renderer-temporary');
  assert.equal(bridge.status(first.request_id)?.state, 'waiting');
  const retried = bridge.takeNext()!;
  assert.deepEqual(retried, first);
  assert.equal(bridge.status(first.request_id)?.delivery_count, 2);
  bridge.complete({
    requestId: retried.request_id,
    contract: '3d-render-v1', mimeType: 'image/png', width: 1280, height: 1280,
    requestIdentity: quotationRenderRequestIdentity(request),
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
  });
  assert.equal((await render).height, 1280);
});

test('all no-response deliveries exhaust without accepting an asset', async () => {
  let now = 0;
  const bridge = new BrowserQuotationImageBridge({
    deliveryLeaseMs: 100,
    maxDeliveries: 2,
    now: () => now,
  });
  const render = bridge.render(request, {
    idempotencyKey: `sha256:${'8'.repeat(64)}`,
    signal: new AbortController().signal,
  });
  assert.ok(bridge.takeNext());
  now = 100;
  assert.ok(bridge.takeNext());
  now = 200;
  assert.equal(bridge.takeNext(), null);
  await assert.rejects(render, /delivery-exhausted/);
  assert.equal(bridge.pendingCount, 0);
  assert.equal(bridge.status(`quote-${'8'.repeat(64)}`)?.delivery_count, 2);
  assert.equal(bridge.status(`quote-${'8'.repeat(64)}`)?.state, 'failed');
});

test('bad PNG signature is rejected before completion', async () => {
  const bridge = new BrowserQuotationImageBridge({ maxDeliveries: 1 });
  const controller = new AbortController();
  const render = bridge.render(request, {
    idempotencyKey: `sha256:${'7'.repeat(64)}`,
    signal: controller.signal,
  });
  const job = bridge.takeNext()!;
  assert.throws(() => bridge.complete({
    requestId: job.request_id,
    contract: '3d-render-v1', mimeType: 'image/png', width: 1280, height: 1280,
    requestIdentity: quotationRenderRequestIdentity(request),
    bytes: Buffer.from('not-a-png'),
  }), /invalid/i);
  controller.abort();
  await assert.rejects(render, /aborted/i);
});

test('browser bridge rejects an artifact that is not bound to a pending request', () => {
  const bridge = new BrowserQuotationImageBridge();
  assert.throws(() => bridge.complete({
    requestId: `quote-${'c'.repeat(64)}`,
    contract: '3d-render-v1', mimeType: 'image/png', width: 1280, height: 1280,
    requestIdentity: `3d-render-v1:sha256:${'d'.repeat(64)}`,
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  }));
});

test('browser bridge rejects a stale renderer response after its lease was aborted', async () => {
  const bridge = new BrowserQuotationImageBridge();
  const controller = new AbortController();
  const render = bridge.render(request, {
    idempotencyKey: `sha256:${'b'.repeat(64)}`,
    signal: controller.signal,
  });
  const job = bridge.takeNext()!;
  controller.abort();
  await assert.rejects(render, /aborted/i);
  assert.equal(bridge.pendingCount, 0);
  assert.throws(() => bridge.complete({
    requestId: job.request_id,
    contract: '3d-render-v1', mimeType: 'image/png', width: 1280, height: 1280,
    requestIdentity: quotationRenderRequestIdentity(request),
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
  }), /unavailable/i);
});
