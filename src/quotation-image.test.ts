import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  buildQuotationRenderRequestFromQuoteItem,
  FixtureQuotationImageRenderer,
  InMemoryQuotationImageJobScheduler,
  LocalTestQuotationImageStorage,
  QUOTE_TO_3D_ACCESSORIES,
  QuotationImageCoordinator,
  QuotationImageError,
  createImmutableItemId,
  ensureImmutableItemIds,
  linkQuoteItemsToOrderItemRecords,
  overlayConfirmedOrderItemsByIdentity,
  pendingQuotationImageMetadata,
  prepareNewQuoteItemsForQuotationImageJobs,
  prepareNewQuoteItemsWithQuotationImages,
  quotationImageEnabled,
  quotationImageIdempotencyKey,
  quotationImagePresentation,
  resolveQuotationImagePresentation,
  resolveQuotationImagePresentations,
  scheduleQuotationImageJobsAfterWrite,
  sanitizeRenderRequest,
  sanitizeQuotationRenderRequest,
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
  product_type: 'display_box',
  configuration_id: 'fictional-config-001',
  dimensions: {
    unit: 'cm',
    inner: { length: 30, depth: 20, height: 25 },
    outer: { length: 32, depth: 22, height: 28.5 },
    actual: { length: 32, depth: 22, height: 28.5 },
  },
  cabinet_layers: [],
  accessories: [{ accessory_type: 'door_magnetic', quantity: 1 }],
  colours: { body: 'clear_acrylic', background: 'light_blue_gray' },
  engraving: { enabled: false },
  model_preview: { enabled: false },
  camera_preset: 'quotation_square_three_quarter_v2',
  output: { width: 1280, height: 1280, background: 'configured' },
  branding: { enabled: false, style: 'none' },
  show_dimensions: true,
  show_price: false,
});

const ITEM_ID = '18a15180-0f8a-4ec2-98f6-69c9f65a83eb';

const storedQuoteItem = () => ({
  item_id: ITEM_ID,
  itemType: 'Display box 展示盒',
  forWhat: 'must not enter render payload',
  interL: '30',
  interD: '20',
  interH: '25',
  outerL: '32',
  outerD: '22',
  outerH: '28.5',
  accessories: ['磁石門'],
  accessoryQty: { '磁石門': 1 },
  qty: 1,
  freight: 100,
  hongKongDelivery: 200,
  profit: 500,
  amount: 1800,
});

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

test('convert linkage and share/invoice overlays follow immutable item identity across reorder/insert/remove', () => {
  const secondId = 'b8c72003-92fb-4c56-a552-e0d9773bb17b';
  const imageMetadata = (marker: string) => ({
    contract: 'quotation-image-v1' as const,
    state: 'ready' as const,
    idempotency_key: `sha256:${marker}`,
    asset_key: `quotation-images/${marker}.png`,
    attempts: 1,
    updated_at: '2026-08-22T12:00:00.000Z',
    marker,
  });
  const base = [
    { ...storedQuoteItem(), item_id: ITEM_ID, quotation_image: imageMetadata('image-a') },
    { ...storedQuoteItem(), item_id: secondId, itemType: 'Display Case 疊高展示櫃', quotation_image: imageMetadata('image-b') },
  ];
  const linked = linkQuoteItemsToOrderItemRecords(base, [{ id: 'rec-a' }, { id: 'rec-b' }]);
  assert.equal(linked[0].order_item_identity?.item_id, ITEM_ID);
  assert.equal(linked[1].order_item_identity?.item_id, secondId);

  const records = [{ id: 'rec-extra' }, { id: 'rec-b' }, { id: 'rec-a' }];
  const overlaid = overlayConfirmedOrderItemsByIdentity(
    linked,
    records,
    (item, record) => ({ ...item, confirmed_record: record.id }),
  );
  assert.deepEqual(overlaid.map(item => item.confirmed_record), ['rec-a', 'rec-b']);
  assert.deepEqual(overlaid.map(item => (item.quotation_image as { marker: string }).marker), ['image-a', 'image-b']);

  const removed = overlayConfirmedOrderItemsByIdentity(
    linked,
    [{ id: 'rec-b' }],
    (item, record) => ({ ...item, confirmed_record: record.id }),
  );
  assert.equal(removed[0].confirmed_record, undefined);
  assert.equal(removed[0].item_id, ITEM_ID);
  assert.equal(removed[1].confirmed_record, 'rec-b');
});

test('position fallback is retained only when both Quote items and confirmed records are legacy', () => {
  const legacy = [{ description: 'legacy-a' }, { description: 'legacy-b' }];
  const records = [{ id: 'rec-b' }, { id: 'rec-a' }];
  const overlaid = overlayConfirmedOrderItemsByIdentity(
    legacy,
    records,
    (item, record) => ({ ...item, confirmed_record: record.id }),
  );
  assert.deepEqual(overlaid.map(item => item.confirmed_record), ['rec-b', 'rec-a']);

  const unsafeMixed = overlayConfirmedOrderItemsByIdentity(
    [{ ...storedQuoteItem(), item_id: ITEM_ID }],
    [{ id: 'rec-x' }],
    (item, record) => ({ ...item, confirmed_record: record.id }),
  );
  assert.equal(unsafeMixed[0].confirmed_record, undefined);
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

test('new Quote item builds a central-schema request without price or customer fields', () => {
  const request = buildQuotationRenderRequestFromQuoteItem(storedQuoteItem());
  assert.ok(request);
  assert.equal(request.configuration_id, ITEM_ID);
  assert.equal(request.purpose, 'quotation');
  assert.equal(request.product_type, 'display_box');
  assert.equal(request.colours.body, 'clear_acrylic');
  assert.equal(request.colours.background, 'light_blue_gray');
  assert.equal(request.camera_preset, 'quotation_square_three_quarter_v2');
  assert.equal(request.show_price, false);
  assert.equal(request.output.width, 1280);
  assert.equal(request.output.height, 1280);
  assert.deepEqual(request.accessories, [{ accessory_type: 'door_magnetic', quantity: 1 }]);
  const serialized = JSON.stringify(request);
  for (const forbidden of ['forWhat', 'freight', 'hongKongDelivery', 'profit', 'amount', 'quote_token']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('every provider-free Quote accessory maps to the exact 3D browser applicator support matrix', () => {
  const expected = {
    '趟門': ['door_sliding'],
    '磁石門': ['door_magnetic'],
    '黑底板': ['bottom_base_black'],
    '透明底板': ['bottom_base_clear'],
    '獨立燈板 - 上燈': [
      'light_board_top_independent',
      'light_top_outer_ring', 'light_top_middle_ring', 'light_top_inner_ring',
    ],
    '獨立燈板 - 下燈': [
      'light_board_bottom_independent',
      'light_bottom_outer_ring', 'light_bottom_middle_ring', 'light_bottom_inner_ring',
    ],
    '獨立燈板 - 上下燈': [
      'light_board_both_independent',
      'light_top_outer_ring', 'light_top_middle_ring', 'light_top_inner_ring',
      'light_bottom_outer_ring', 'light_bottom_middle_ring', 'light_bottom_inner_ring',
    ],
    '上下燈': [
      'light_board_both_standard',
      'light_top_outer_ring', 'light_top_middle_ring', 'light_top_inner_ring',
      'light_bottom_outer_ring', 'light_bottom_middle_ring', 'light_bottom_inner_ring',
    ],
    '背燈': ['back_light', 'background_back'],
    '左板鏡面': ['mirror_left'],
    '右板鏡面': ['mirror_right'],
    '底板鏡面': ['mirror_bottom'],
    '頂板鏡面': ['mirror_top'],
    '背板鏡面': ['mirror_back'],
  } as const;
  assert.deepEqual(Object.keys(QUOTE_TO_3D_ACCESSORIES), Object.keys(expected));
  for (const [quoteAccessory, canonicalTypes] of Object.entries(expected)) {
    const request = buildQuotationRenderRequestFromQuoteItem({
      ...storedQuoteItem(),
      accessories: [quoteAccessory],
      accessoryQty: { [quoteAccessory]: 1 },
    });
    assert.deepEqual(
      request?.accessories.map(accessory => accessory.accessory_type),
      canonicalTypes,
      quoteAccessory,
    );
  }
  assert.deepEqual(QUOTE_TO_3D_ACCESSORIES['背燈'][0], {
    accessory_type: 'back_light', quantity: 1, colour: 'white',
  });
});

test('unsupported accessories and ambiguous combinations skip scheduling without perpetual pending metadata', () => {
  const unsupported = [
    { '前板白色刻字': 1 },
    { '前板彩色刻字': 1 },
    { '左板圖片': 1 },
    { '右板圖片': 1 },
    { '底板圖片': 1 },
    { '頂板圖片': 1 },
    { '背板圖片': 1 },
    { '未來配件': 1 },
    { '背燈': 2 },
    { '趟門': 1, '磁石門': 1 },
    { '黑底板': 1, '透明底板': 1 },
    { '獨立燈板 - 上燈': 1, '上下燈': 1 },
  ];
  const runtime = {
    coordinator: new QuotationImageCoordinator(
      new FixtureQuotationImageRenderer(renderedFixture()),
      new LocalTestQuotationImageStorage(),
    ),
    jobScheduler: new InMemoryQuotationImageJobScheduler(),
    metadataWriter: { async update() {} },
  };
  for (const accessoryQty of unsupported) {
    const item = { ...storedQuoteItem(), accessories: Object.keys(accessoryQty), accessoryQty };
    assert.equal(buildQuotationRenderRequestFromQuoteItem(item), null);
    const prepared = prepareNewQuoteItemsForQuotationImageJobs([item], { enabled: true, runtime });
    assert.equal(prepared.jobs.length, 0);
    assert.equal(prepared.items[0].quotation_image, undefined);
  }
});

test('Quote item type mapping matches 3D applicator canonical fixtures and rejects unsupported types', () => {
  const stacked = buildQuotationRenderRequestFromQuoteItem({
    ...storedQuoteItem(),
    itemType: 'Display Case 疊高展示櫃',
    noOfLevels: 2,
    levelHeights: '第1層：25 cm｜第2層：30 cm',
  });
  assert.equal(stacked?.product_type, 'stacked_cabinet');
  assert.deepEqual(stacked?.cabinet_layers, [
    { layer_id: 'layer-1', position: 1, actual_height: 25 },
    { layer_id: 'layer-2', position: 2, actual_height: 30 },
  ]);
  assert.equal(buildQuotationRenderRequestFromQuoteItem({
    ...storedQuoteItem(),
    itemType: '階梯',
  }), null);
  assert.equal(buildQuotationRenderRequestFromQuoteItem({
    ...storedQuoteItem(),
    itemType: 'Unknown future product',
  }), null);
});

test('create-core persistence attaches metadata in Quote Items JSON without changing pricing', async () => {
  const renderer = new FixtureQuotationImageRenderer(renderedFixture());
  const storage = new LocalTestQuotationImageStorage();
  const coordinator = new QuotationImageCoordinator(renderer, storage, {
    now: () => '2026-08-22T12:00:00.000Z',
  });
  const original = storedQuoteItem();
  const prepared = await prepareNewQuoteItemsWithQuotationImages([original], {
    enabled: true,
    coordinator,
  });
  const persisted = JSON.parse(JSON.stringify(prepared))[0];
  assert.equal(persisted.item_id, ITEM_ID);
  assert.equal(persisted.amount, original.amount);
  assert.equal(persisted.freight, original.freight);
  assert.equal(persisted.profit, original.profit);
  assert.equal(persisted.quotation_image.state, 'ready');
  assert.match(persisted.quotation_image.asset_key, /^quotation-images\//);
  assert.equal(JSON.stringify(persisted).includes('http'), false);
  assert.equal(JSON.stringify(persisted).includes('fictional-test-only-png'), false);
});

test('create-core is a complete no-op when feature or provider is unavailable', async () => {
  const renderer = new FixtureQuotationImageRenderer(renderedFixture());
  const coordinator = new QuotationImageCoordinator(renderer, new LocalTestQuotationImageStorage());
  const item = storedQuoteItem();
  assert.deepEqual(await prepareNewQuoteItemsWithQuotationImages([item], {
    enabled: false,
    coordinator,
  }), [item]);
  assert.deepEqual(await prepareNewQuoteItemsWithQuotationImages([item], {
    enabled: true,
  }), [item]);
  assert.equal(renderer.calls, 0);
});

test('authoritative create persists deterministic pending metadata before non-blocking slow render job', async () => {
  let renderCalls = 0;
  let release!: () => void;
  const slow = new Promise<void>(resolve => { release = resolve; });
  const renderer: QuotationImageRenderer = {
    async render() {
      renderCalls += 1;
      await slow;
      return renderedFixture();
    },
  };
  const scheduler = new InMemoryQuotationImageJobScheduler();
  const updates: Array<{ quoteRecordId: string; itemId: string; state: string }> = [];
  const runtime = {
    coordinator: new QuotationImageCoordinator(renderer, new LocalTestQuotationImageStorage()),
    jobScheduler: scheduler,
    metadataWriter: {
      async update(input: { quoteRecordId: string; itemId: string; metadata: { state: string } }) {
        updates.push({ quoteRecordId: input.quoteRecordId, itemId: input.itemId, state: input.metadata.state });
      },
    },
  };
  const prepared = prepareNewQuoteItemsForQuotationImageJobs([storedQuoteItem()], {
    enabled: true,
    runtime,
    now: '2026-08-22T12:00:00.000Z',
  });
  assert.equal(prepared.items[0].quotation_image?.state, 'pending');
  assert.match(prepared.items[0].quotation_image?.asset_key || '', /^quotation-images\/[a-f0-9]{64}\.png$/);
  assert.equal(renderCalls, 0);

  // Simulates successful tableQuotes.create. Scheduling returns immediately;
  // the slow renderer has not started and cannot delay the create response.
  let authoritativeCreateReturned = true;
  scheduleQuotationImageJobsAfterWrite(prepared.jobs, 'rec-fake-quote', runtime);
  assert.equal(authoritativeCreateReturned, true);
  assert.equal(scheduler.size, 1);
  assert.equal(renderCalls, 0);

  const drained = scheduler.drain();
  await Promise.resolve();
  assert.equal(renderCalls, 1);
  assert.equal(updates.length, 0);
  release();
  await drained;
  assert.deepEqual(updates, [{
    quoteRecordId: 'rec-fake-quote',
    itemId: ITEM_ID,
    state: 'ready',
  }]);
});

test('after-write preparation is a no-op unless coordinator, scheduler and writer are all configured', () => {
  const item = storedQuoteItem();
  const coordinator = new QuotationImageCoordinator(
    new FixtureQuotationImageRenderer(renderedFixture()),
    new LocalTestQuotationImageStorage(),
  );
  for (const runtime of [
    {},
    { coordinator },
    { coordinator, jobScheduler: new InMemoryQuotationImageJobScheduler() },
  ]) {
    const prepared = prepareNewQuoteItemsForQuotationImageJobs([item], { enabled: true, runtime });
    assert.deepEqual(prepared, { items: [item], jobs: [] });
  }
});

test('central render schema stays broad while quotation policy requires 1280 and quotation purpose', () => {
  assert.deepEqual(sanitizeRenderRequest(renderRequest()), renderRequest());
  assert.throws(() => sanitizeRenderRequest({ ...renderRequest(), show_price: true }), /show_price must be false/);
  assert.equal(sanitizeRenderRequest({
    ...renderRequest(),
    purpose: 'social',
    output: { width: 640, height: 1280, background: 'configured' },
  }).purpose, 'social');
  assert.throws(() => sanitizeQuotationRenderRequest({
    ...renderRequest(),
    output: { width: 640, height: 1280, background: 'configured' },
  }), /1280 x 1280/);
  assert.throws(() => sanitizeQuotationRenderRequest({
    ...renderRequest(), purpose: 'website',
  }), /purpose must be quotation/);
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
  assert.match(pending.asset_key || '', /^quotation-images\/[a-f0-9]{64}\.png$/);
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
  assert.match(first.asset_key || '', /^quotation-images\/[a-f0-9]{64}\.png$/);
  assert.equal(renderer.calls, 1);
  assert.equal(storage.size, 1);
  assert.deepEqual(Buffer.from(storage.get(first.asset_key!)!), PNG_FIXTURE);
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

test('exhausted temporary result is not permanently cached and a later call retries renderer', async () => {
  let calls = 0;
  const renderer: QuotationImageRenderer = {
    async render() {
      calls += 1;
      if (calls <= 2) throw new QuotationImageError('temporary fixture outage', 'temporary');
      return renderedFixture();
    },
  };
  const coordinator = new QuotationImageCoordinator(
    renderer,
    new LocalTestQuotationImageStorage(),
    { maxAttempts: 2 },
  );
  const first = await coordinator.process(ITEM_ID, renderRequest());
  assert.equal(first.state, 'failed');
  assert.equal(first.error_class, 'temporary');
  assert.equal(first.attempts, 2);
  const later = await coordinator.process(ITEM_ID, renderRequest());
  assert.equal(later.state, 'ready');
  assert.equal(later.attempts, 1);
  assert.equal(calls, 3);
});

test('create-core persists failed metadata but never throws or changes the Quote price', async () => {
  const renderer: QuotationImageRenderer = {
    async render() {
      throw new QuotationImageError('terminal fictional fixture', 'terminal');
    },
  };
  const item = storedQuoteItem();
  const [prepared] = await prepareNewQuoteItemsWithQuotationImages([item], {
    enabled: true,
    coordinator: new QuotationImageCoordinator(renderer, new LocalTestQuotationImageStorage()),
  });
  assert.equal(prepared.quotation_image?.state, 'failed');
  assert.equal(prepared.quotation_image?.error_class, 'terminal');
  assert.equal(prepared.amount, item.amount);
  assert.equal(prepared.profit, item.profit);
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

test('exhausted timeout remains retryable on a later coordinator call', async () => {
  let calls = 0;
  const renderer: QuotationImageRenderer = {
    async render(_request, { signal }) {
      calls += 1;
      if (calls > 2) return renderedFixture();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      throw new QuotationImageError('aborted timeout fixture', 'temporary');
    },
  };
  const coordinator = new QuotationImageCoordinator(
    renderer,
    new LocalTestQuotationImageStorage(),
    { timeoutMs: 5, maxAttempts: 2 },
  );
  const timedOut = await coordinator.process(ITEM_ID, renderRequest());
  assert.equal(timedOut.state, 'failed');
  assert.equal(timedOut.error_class, 'timeout');
  const recovered = await coordinator.process(ITEM_ID, renderRequest());
  assert.equal(recovered.state, 'ready');
  assert.equal(calls, 3);
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

test('provider-neutral resolver supplies ready presentation and absence remains image-less', async () => {
  const item = {
    ...storedQuoteItem(),
    quotation_image: {
      contract: 'quotation-image-v1' as const,
      state: 'ready' as const,
      idempotency_key: 'sha256:ready',
      asset_key: 'quotation-images/fixture.png',
      attempts: 1,
      updated_at: '2026-08-22T12:00:00.000Z',
    },
  };
  assert.equal(await resolveQuotationImagePresentation(item), null);
  const resolver = {
    async resolve(assetKey: string, context: { itemId: string }) {
      assert.equal(assetKey, 'quotation-images/fixture.png');
      assert.equal(context.itemId, ITEM_ID);
      return {
        src: '/temporary/signed/fixture.png',
        expiresAt: '2026-08-22T13:00:00.000Z',
      };
    },
  };
  assert.deepEqual(
    await resolveQuotationImagePresentation(item, resolver, Date.parse('2026-08-22T12:00:00.000Z')),
    { src: '/temporary/signed/fixture.png', alt: 'Quotation product preview' },
  );
  const resolved = await resolveQuotationImagePresentations([item], {
    enabled: true,
    resolver,
    now: Date.parse('2026-08-22T12:00:00.000Z'),
  });
  assert.equal(resolved.get(ITEM_ID)?.src, '/temporary/signed/fixture.png');
  assert.equal((await resolveQuotationImagePresentations([item], { enabled: false, resolver })).size, 0);
  assert.equal((await resolveQuotationImagePresentations([item], { enabled: true })).size, 0);
});

test('real create, public Quote and invoice routes use the shared integration core', () => {
  const source = readFileSync(path.join(__dirname, 'index.ts'), 'utf8');
  assert.match(source, /prepareNewQuoteItemsForQuotationImageJobs\(items,/);
  assert.match(source, /scheduleQuotationImageJobsAfterWrite\(/);
  assert.match(source, /'Quote Items JSON': itemsJson/);
  assert.match(source, /linkQuoteItemsToOrderItemRecords\(items, createdOrderItems\)/);
  assert.match(source, /quoteItemsMutationLock\.run\(quote\.id,/);
  assert.match(source, /'Quote Items JSON': JSON\.stringify\(mergedItems\)/);
  assert.equal((source.match(/items = await getConfirmedOrderItems\(/g) || []).length, 2);
  assert.equal((source.match(/await resolveQuotationImagePresentations\(items,/g) || []).length, 2);
  assert.equal((source.match(/renderOptionalQuotationImageRow\(quotationImagePresentations\.get/g) || []).length, 2);
});

test('feature flag is explicitly opt-in and fully disabled otherwise', () => {
  assert.equal(quotationImageEnabled(undefined), false);
  assert.equal(quotationImageEnabled('false'), false);
  assert.equal(quotationImageEnabled('true'), true);
  assert.equal(quotationImageEnabled('enabled'), true);
});
