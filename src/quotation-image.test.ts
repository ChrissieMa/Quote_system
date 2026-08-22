import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FixtureQuotationImageRenderer,
  LocalTestQuotationImageStorage,
  QuotationImageCoordinator,
  QuotationImageError,
  createImmutableItemId,
  ensureImmutableItemIds,
  pendingQuotationImageMetadata,
  quotationImageEnabled,
  quotationImageIdempotencyKey,
  quotationImagePresentation,
  sanitizeRenderRequest,
  type QuotationImageRenderer,
  type RenderRequestV1,
  type RenderedQuotationImage,
} from './quotation-image';
import { buildPilotPreview } from './quote-pilot';

const PNG_FIXTURE = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fictional-test-only-png'),
]);

const renderedFixture = (): RenderedQuotationImage => ({
  bytes: PNG_FIXTURE,
  mimeType: 'image/png',
  width: 1280,
  height: 1280,
});

const renderRequest = (): RenderRequestV1 => ({
  purpose: 'quotation',
  product_type: 'Display box 展示盒',
  configuration_id: 'fictional-config-001',
  dimensions: {
    unit: 'cm',
    inner: { length: 30, depth: 20, height: 25 },
    outer: { length: 32, depth: 22, height: 28.5 },
    actual: { length: 32, depth: 22, height: 28.5 },
  },
  cabinet_layers: [],
  accessories: [{ accessory_type: '磁石門', quantity: 1 }],
  colours: { body: 'clear', background: 'light-gray-blue' },
  engraving: { enabled: false },
  model_preview: { enabled: false },
  camera_preset: 'quotation-default',
  output: { width: 1280, height: 1280, background: 'configured' },
  branding: { enabled: false, style: 'none' },
  show_dimensions: true,
  show_price: false,
});

const ITEM_ID = '18a15180-0f8a-4ec2-98f6-69c9f65a83eb';

test('new items receive server UUIDs while trusted existing IDs remain immutable', () => {
  const generated = [
    '4924d3d0-94b5-4b88-bca2-0985820a55d1',
    'e4ee749a-9f8b-4dcf-aec1-81ef80a3e2d3',
  ];
  const items = ensureImmutableItemIds([{ itemType: 'A' }, { itemType: 'B' }], {
    createId: () => generated.shift()!,
  });
  assert.deepEqual(items.map(item => item.item_id), [
    '4924d3d0-94b5-4b88-bca2-0985820a55d1',
    'e4ee749a-9f8b-4dcf-aec1-81ef80a3e2d3',
  ]);
  const preserved = ensureImmutableItemIds(items, { preserveExisting: true });
  assert.deepEqual(preserved.map(item => item.item_id), items.map(item => item.item_id));
  assert.equal(createImmutableItemId(ITEM_ID.toUpperCase()), ITEM_ID);
  assert.throws(
    () => ensureImmutableItemIds([{ item_id: ITEM_ID }, { item_id: ITEM_ID }], { preserveExisting: true }),
    /Duplicate item_id/,
  );
});

test('item identity does not alter authoritative pricing and survives calculated preview', () => {
  const input = {
    customer: 'FICTIONAL TEST CUSTOMER',
    phone: '00000000',
    items: [{
      itemType: 'Display box 展示盒' as const,
      forWhat: 'Fixture only',
      innerDimensions: { length: 30, depth: 20, height: 25 },
      quantity: 1,
      chinaFreight: 100,
      hongKongDelivery: 200,
      profit: 500,
    }],
  };
  const baseline = buildPilotPreview(input);
  const identified = buildPilotPreview({
    ...input,
    items: [{ ...input.items[0], item_id: ITEM_ID }],
  });
  assert.equal(identified.items[0].item_id, ITEM_ID);
  assert.equal(identified.items[0].amount, baseline.items[0].amount);
  assert.equal(identified.subtotal, baseline.subtotal);
  assert.equal(identified.finalTotal, baseline.finalTotal);
});

test('render contract is product-only, fixed at 1280 PNG intent and show_price false', () => {
  assert.deepEqual(sanitizeRenderRequest(renderRequest()), renderRequest());
  assert.throws(() => sanitizeRenderRequest({ ...renderRequest(), show_price: true }), /show_price must be false/);
  assert.throws(() => sanitizeRenderRequest({
    ...renderRequest(),
    output: { width: 640, height: 1280, background: 'configured' },
  }), /1280 x 1280/);
});

test('renderer payload rejects PII, Quote tokens, credentials, payment and price fields', () => {
  for (const forbidden of [
    { customer_email: 'person@example.test' },
    { quote_token: 'not-a-real-token' },
    { api_credentials: 'not-a-real-secret' },
    { payment_data: 'fictional' },
    { total_price: 999 },
  ]) {
    assert.throws(
      () => sanitizeRenderRequest({ ...renderRequest(), ...forbidden }),
      /forbidden field/,
    );
  }
});

test('idempotency is deterministic for the immutable item and canonical request', () => {
  const request = renderRequest();
  const reordered = JSON.parse(JSON.stringify(request)) as RenderRequestV1;
  reordered.colours = { background: request.colours.background, body: request.colours.body };
  assert.equal(
    quotationImageIdempotencyKey(ITEM_ID, request),
    quotationImageIdempotencyKey(ITEM_ID, reordered),
  );
  assert.notEqual(
    quotationImageIdempotencyKey(ITEM_ID, request),
    quotationImageIdempotencyKey('b8c72003-92fb-4c56-a552-e0d9773bb17b', request),
  );
});

test('pending metadata is JSON-only and carries the deterministic asset identity', () => {
  const pending = pendingQuotationImageMetadata(
    ITEM_ID,
    renderRequest(),
    '2026-08-22T12:00:00.000Z',
  );
  assert.equal(pending.state, 'pending');
  assert.equal(pending.attempts, 0);
  assert.equal(pending.idempotency_key, quotationImageIdempotencyKey(ITEM_ID, renderRequest()));
  assert.equal('asset_key' in pending, false);
});

test('local end-to-end fixture renders, stores one durable asset_key and deduplicates replay', async () => {
  const renderer = new FixtureQuotationImageRenderer(renderedFixture());
  const storage = new LocalTestQuotationImageStorage();
  const coordinator = new QuotationImageCoordinator(renderer, storage, {
    now: () => '2026-08-22T12:00:00.000Z',
  });
  const first = await coordinator.process(ITEM_ID, renderRequest());
  const replay = await coordinator.process(ITEM_ID, renderRequest());
  assert.deepEqual(replay, first);
  assert.equal(first.state, 'ready');
  assert.match(first.asset_key || '', /^test-only\/quotation-images\/[a-f0-9]{64}\.png$/);
  assert.equal(renderer.calls, 1);
  assert.equal(storage.size, 1);
  assert.deepEqual(storage.get(first.asset_key!), PNG_FIXTURE);
  assert.equal(JSON.stringify(first).includes('PNG'), false);
  assert.equal(JSON.stringify(first).includes('http'), false);
});

test('concurrent duplicate requests share one renderer operation', async () => {
  let calls = 0;
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const renderer: QuotationImageRenderer = {
    async render() {
      calls += 1;
      await wait;
      return renderedFixture();
    },
  };
  const coordinator = new QuotationImageCoordinator(renderer, new LocalTestQuotationImageStorage());
  const first = coordinator.process(ITEM_ID, renderRequest());
  const second = coordinator.process(ITEM_ID, renderRequest());
  release();
  assert.deepEqual(await first, await second);
  assert.equal(calls, 1);
});

test('temporary failures retry within the bound while terminal failures fail open', async () => {
  let temporaryCalls = 0;
  const temporaryRenderer: QuotationImageRenderer = {
    async render() {
      temporaryCalls += 1;
      if (temporaryCalls < 3) throw new QuotationImageError('fixture unavailable', 'temporary');
      return renderedFixture();
    },
  };
  const successful = await new QuotationImageCoordinator(
    temporaryRenderer,
    new LocalTestQuotationImageStorage(),
    { maxAttempts: 3 },
  ).process(ITEM_ID, renderRequest());
  assert.equal(successful.state, 'ready');
  assert.equal(successful.attempts, 3);

  let terminalCalls = 0;
  const terminalRenderer: QuotationImageRenderer = {
    async render() {
      terminalCalls += 1;
      throw new QuotationImageError('invalid fixture', 'terminal');
    },
  };
  const failed = await new QuotationImageCoordinator(
    terminalRenderer,
    new LocalTestQuotationImageStorage(),
    { maxAttempts: 3 },
  ).process(ITEM_ID, renderRequest());
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error_class, 'terminal');
  assert.equal(terminalCalls, 1);
});

test('timeouts are bounded and return failed metadata instead of blocking Quote flow', async () => {
  let calls = 0;
  const renderer: QuotationImageRenderer = {
    async render(_request, { signal }) {
      calls += 1;
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      throw new QuotationImageError('aborted fixture', 'temporary');
    },
  };
  const result = await new QuotationImageCoordinator(
    renderer,
    new LocalTestQuotationImageStorage(),
    { timeoutMs: 5, maxAttempts: 2 },
  ).process(ITEM_ID, renderRequest());
  assert.equal(result.state, 'failed');
  assert.equal(result.error_class, 'timeout');
  assert.equal(result.attempts, 2);
  assert.equal(calls, 2);
});

test('legacy, missing, pending and failed images produce no broken presentation', () => {
  assert.equal(quotationImagePresentation({}), null);
  assert.equal(quotationImagePresentation({
    item_id: ITEM_ID,
    quotation_image: {
      contract: 'quotation-image-v1',
      state: 'pending',
      idempotency_key: 'sha256:pending',
      attempts: 0,
      updated_at: '2026-08-22T12:00:00.000Z',
    },
  }, '/temporary/image.png'), null);
  assert.equal(quotationImagePresentation({
    item_id: ITEM_ID,
    quotation_image: {
      contract: 'quotation-image-v1',
      state: 'failed',
      idempotency_key: 'sha256:failed',
      attempts: 1,
      error_class: 'terminal',
      updated_at: '2026-08-22T12:00:00.000Z',
    },
  }, '/temporary/image.png'), null);
});

test('ready presentation requires a separately resolved short-lived safe URL', () => {
  const item = {
    item_id: ITEM_ID,
    quotation_image: {
      contract: 'quotation-image-v1' as const,
      state: 'ready' as const,
      idempotency_key: 'sha256:ready',
      asset_key: 'quotation-images/fixture.png',
      attempts: 1,
      updated_at: '2026-08-22T12:00:00.000Z',
    },
  };
  assert.equal(quotationImagePresentation(item), null);
  assert.equal(quotationImagePresentation(item, 'javascript:alert(1)'), null);
  assert.deepEqual(quotationImagePresentation(item, '/temporary/signed/fixture.png'), {
    src: '/temporary/signed/fixture.png',
    alt: 'Quotation product preview',
  });
});

test('feature flag is explicitly opt-in and fully disabled otherwise', () => {
  assert.equal(quotationImageEnabled(undefined), false);
  assert.equal(quotationImageEnabled('false'), false);
  assert.equal(quotationImageEnabled('true'), true);
  assert.equal(quotationImageEnabled('enabled'), true);
});
