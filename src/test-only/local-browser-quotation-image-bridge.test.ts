import assert from 'node:assert/strict';
import test from 'node:test';
import type { RenderRequestV1 } from '../quotation-image';
import { quotationRenderRequestIdentity } from '../browser-quotation-image';
import {
  LocalBrowserQuotationImageBridge,
  localBrowserQuotationImageClientHtml,
} from './local-browser-quotation-image-bridge';

const request: RenderRequestV1 = {
  purpose: 'quotation',
  product_type: 'display_box',
  configuration_id: '9e4f6e72-d31a-4d1a-8d15-730282c1b102',
  dimensions: {
    unit: 'cm',
    inner: { length: 46, depth: 40, height: 50 },
    outer: { length: 48, depth: 42, height: 52 },
    actual: { length: 48, depth: 42, height: 52 },
  },
  cabinet_layers: [],
  accessories: [{ accessory_type: 'mirror_back', quantity: 1 }],
  colours: { body: 'clear_acrylic', background: 'light_blue_gray' },
  camera_preset: 'quotation_square_three_quarter_v2',
  output: { width: 1280, height: 1280, background: 'configured' },
  branding: { enabled: false, style: 'none' },
  show_dimensions: true,
  show_price: false,
};

const idempotencyKey = `sha256:${'a'.repeat(64)}`;
const requestIdentity = quotationRenderRequestIdentity(request);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

test('local browser bridge carries the exact 3D protocol and accepts only a 1280 PNG', async () => {
  const bridge = new LocalBrowserQuotationImageBridge();
  const controller = new AbortController();
  const rendered = bridge.render(request, { idempotencyKey, signal: controller.signal });
  assert.deepEqual(bridge.takeNext(), {
    protocol: 'lks-quotation-image-local-v1',
    type: 'lks.quotation-image.render.request',
    request_id: `quote-${'a'.repeat(64)}`,
    render_request: request,
  });
  assert.equal(bridge.takeNext(), null);
  bridge.complete({
    requestId: `quote-${'a'.repeat(64)}`,
    contract: '3d-render-v1',
    mimeType: 'image/png',
    width: 1280,
    height: 1280,
    requestIdentity,
    bytes: png,
  });
  assert.deepEqual(await rendered, {
    bytes: new Uint8Array(png),
    mimeType: 'image/png',
    width: 1280,
    height: 1280,
  });
  assert.deepEqual(bridge.status(), {
    protocol: 'lks-quotation-image-local-v1',
    pending_count: 0,
    last_completed: {
      requestId: `quote-${'a'.repeat(64)}`,
      request,
      requestIdentity,
      pngSha256: '275f1bcbbb585c71e3b2184304eccfa0e37de92022ca3b6f4e9c10df32318d85',
      byteLength: png.length,
    },
  });
});

test('local browser bridge propagates renderer failure as a temporary fail-open error', async () => {
  const bridge = new LocalBrowserQuotationImageBridge();
  const rendered = bridge.render(request, {
    idempotencyKey: `sha256:${'c'.repeat(64)}`,
    signal: new AbortController().signal,
  });
  const job = bridge.takeNext();
  assert.ok(job);
  bridge.fail(job.request_id, 'renderer-temporary-failure');
  await assert.rejects(rendered, /renderer-temporary-failure/);
});

test('local browser bridge rejects an artifact identity that is not the exact request hash', async () => {
  const bridge = new LocalBrowserQuotationImageBridge();
  const rendered = bridge.render(request, {
    idempotencyKey: `sha256:${'d'.repeat(64)}`,
    signal: new AbortController().signal,
  });
  const job = bridge.takeNext()!;
  assert.throws(() => bridge.complete({
    requestId: job.request_id,
    contract: '3d-render-v1',
    mimeType: 'image/png',
    width: 1280,
    height: 1280,
    requestIdentity: `3d-render-v1:sha256:${'e'.repeat(64)}`,
    bytes: png,
  }));
  bridge.fail(job.request_id, 'request-identity-mismatch');
  await assert.rejects(rendered, /request-identity-mismatch/);
});

test('local browser client is loopback-only and never uses wildcard postMessage', () => {
  const html = localBrowserQuotationImageClientHtml('http://127.0.0.1:5175');
  assert.match(html, /lks-quotation-image-local-v1/);
  assert.match(html, /event\.origin !== rendererOrigin/);
  assert.match(html, /event\.source !== frame\.contentWindow/);
  assert.match(html, /postMessage\(job, rendererOrigin\)/);
  assert.doesNotMatch(html, /postMessage\([^)]*,\s*['"]\*['"]\)/);
  assert.throws(() => localBrowserQuotationImageClientHtml('https://example.invalid'));
  assert.throws(() => localBrowserQuotationImageClientHtml('*'));
});
