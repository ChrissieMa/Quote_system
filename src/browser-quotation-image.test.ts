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
  assert.equal(
    quotationImageBridgeCsp('https://lksdisplaybox.online/configurator/'),
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src https://lksdisplaybox.online; connect-src 'self'",
  );
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
  bridge.complete({
    requestId: job!.request_id,
    contract: '3d-render-v1', mimeType: 'image/png', width: 1280, height: 1280,
    requestIdentity: quotationRenderRequestIdentity(request),
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
  });
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
  const bridge = new BrowserQuotationImageBridge();
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

test('browser bridge rejects an artifact that is not bound to a pending request', () => {
  const bridge = new BrowserQuotationImageBridge();
  assert.throws(() => bridge.complete({
    requestId: `quote-${'c'.repeat(64)}`,
    contract: '3d-render-v1', mimeType: 'image/png', width: 1280, height: 1280,
    requestIdentity: `3d-render-v1:sha256:${'d'.repeat(64)}`,
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  }));
});
