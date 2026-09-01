import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {
  BROWSER_RENDER_CAPABILITY,
  BROWSER_RENDER_READY_TYPE,
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

test('production browser transport is safe and retries its first recovery fetch until HTTP success', async () => {
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
  assert.match(html, new RegExp(BROWSER_RENDER_READY_TYPE.replaceAll('.', '\\.')));
  assert.match(html, new RegExp(BROWSER_RENDER_CAPABILITY));
  assert.match(html, /event\.origin !== rendererOrigin/);
  assert.match(html, /event\.source !== frame\.contentWindow/);
  assert.match(html, /postMessage\(job, rendererOrigin\)/);
  assert.doesNotMatch(html, /postMessage\([^)]*,\s*['"]\*['"]\)/);
  assert.doesNotMatch(html, /rendererReadinessGraceMs/);
  assert.match(html, /rendererReadyTimeoutMs = 8000/);
  assert.match(html, /maxRendererReloads = 2/);
  assert.match(html, /rendererResponseTimeoutMs = 6000/);
  assert.match(html, /activeJob = null/);
  assert.match(html, /let recoverLatest = true/);
  assert.match(html, /recoveryQuery = recoverLatest \? '\?recover_latest=1' : ''/);
  assert.match(html, /recoverLatest = false/);
  assert.equal(
    quotationImageBridgeCsp('https://lksdisplaybox.online/configurator/'),
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src https://lksdisplaybox.online; connect-src 'self'",
  );
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script);
  for (const firstResult of ['reject', 'non-ok'] as const) {
    const requested: string[] = [];
    let fetchAttempt = 0;
    const frameListeners = new Map<string, () => void>();
    const windowListeners = new Map<string, (event: unknown) => void>();
    const contentWindow = { postMessage() {} };
    const frame = {
      contentWindow,
      addEventListener(type: string, listener: () => void) { frameListeners.set(type, listener); },
    };
    const context = vm.createContext({
      URL,
      ArrayBuffer,
      document: {
        getElementById(id: string) {
          return id === 'quotation-image-renderer' ? frame : { textContent: '' };
        },
      },
      window: { addEventListener(type: string, listener: (event: unknown) => void) { windowListeners.set(type, listener); } },
      console: { info() {} },
      clearTimeout() {},
      setTimeout() { return 1; },
      fetch: async (url: string) => {
        requested.push(url);
        fetchAttempt += 1;
        if (fetchAttempt === 1 && firstResult === 'reject') throw new Error('safe network fixture');
        if (fetchAttempt === 1) return { ok: false, status: 503, json: async () => ({}) };
        return { ok: true, status: 204, json: async () => ({}) };
      },
    });
    new vm.Script(script).runInContext(context);
    frameListeners.get('load')?.();
    windowListeners.get('message')?.({
      origin: 'https://lksdisplaybox.online', source: contentWindow,
      data: { protocol: BROWSER_TRANSPORT_PROTOCOL, type: BROWSER_RENDER_READY_TYPE, capability: BROWSER_RENDER_CAPABILITY },
    });

    await vm.runInContext('poll()', context);
    await vm.runInContext('poll()', context);
    await vm.runInContext('poll()', context);
    assert.deepEqual(requested, [
      '/quotation-image/browser-bridge/next?recover_latest=1',
      '/quotation-image/browser-bridge/next?recover_latest=1',
      '/quotation-image/browser-bridge/next',
    ], firstResult);
  }
});

test('iframe reload clears the active job and waits for renderer readiness before polling again', () => {
  const html = browserQuotationImageClientHtml('https://lksdisplaybox.online/configurator/');
  assert.match(html, /frame\.addEventListener\('load', \(\) => \{[\s\S]*rendererReady = false;/);
  assert.match(html, /clearTimeout\(responseTimer\);[\s\S]*activeJob = null;/);
  assert.doesNotMatch(html, /rendererReady = true; schedulePoll\(0\)/);
  assert.ok(html.includes(`response.type === '${BROWSER_RENDER_READY_TYPE}'`));
  assert.ok(html.includes(`response.capability === '${BROWSER_RENDER_CAPABILITY}'`));
  assert.match(html, /Object\.keys\(response\)\.length === 3/);
});

test('Production full bridge installs listeners before the first iframe navigation and completes once', async () => {
  const html = browserQuotationImageClientHtml('https://renderer.test/configurator/', {
    deferRendererLoadUntilListener: true,
  });
  assert.match(html, /data-renderer-src="https:\/\/renderer\.test\/configurator\/"/);
  assert.doesNotMatch(html, /<iframe[^>]+\ssrc="https:\/\/renderer\.test\/configurator\/"/);
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script);

  const order: string[] = [];
  const requests: Array<{ url: string; method: string }> = [];
  const posted: unknown[] = [];
  const stageLogs: string[] = [];
  const frameListeners = new Map<string, () => void>();
  const windowListeners = new Map<string, (event: any) => unknown>();
  const contentWindow = { postMessage(message: unknown) { posted.push(message); } };
  const status = { textContent: '' };
  const job = {
    protocol: BROWSER_TRANSPORT_PROTOCOL,
    type: BROWSER_RENDER_REQUEST_TYPE,
    request_id: `quote-${'b'.repeat(64)}`,
    render_request: request,
  };
  let frameSrc = '';
  let frameAssignments = 0;
  const exactReady = () => windowListeners.get('message')?.({
    origin: 'https://renderer.test',
    source: contentWindow,
    data: {
      protocol: BROWSER_TRANSPORT_PROTOCOL,
      type: BROWSER_RENDER_READY_TYPE,
      capability: BROWSER_RENDER_CAPABILITY,
    },
  });
  const frame = {
    contentWindow,
    get src() { return frameSrc; },
    set src(value: string) {
      order.push('iframe_src_set');
      frameAssignments += 1;
      frameSrc = value;
      void exactReady();
      frameListeners.get('load')?.();
    },
    addEventListener(type: string, listener: () => void) {
      if (type === 'load') order.push('iframe_load_listener_installed');
      frameListeners.set(type, listener);
    },
  };
  const context = vm.createContext({
    URL,
    ArrayBuffer,
    document: {
      getElementById(id: string) {
        return id === 'quotation-image-renderer' ? frame : status;
      },
    },
    window: {
      addEventListener(type: string, listener: (event: any) => unknown) {
        if (type === 'message') order.push('message_listener_installed');
        windowListeners.set(type, listener);
      },
    },
    console: { info(_label: string, payload: string) { stageLogs.push(payload); } },
    clearTimeout() {},
    setTimeout() { return 1; },
    fetch: async (url: string, options: { method?: string } = {}) => {
      const method = options.method || 'GET';
      requests.push({ url, method });
      if (url.includes('/next')) return { ok: true, status: 200, json: async () => job };
      if (url.includes('/status/')) return { ok: true, status: 200, json: async () => ({ state: 'ready' }) };
      return { ok: true, status: 202, json: async () => ({ state: 'processing' }) };
    },
  });

  new vm.Script(script).runInContext(context);
  assert.ok(order.indexOf('message_listener_installed') < order.indexOf('iframe_src_set'));
  assert.ok(order.indexOf('iframe_load_listener_installed') < order.indexOf('iframe_src_set'));
  assert.equal(frameAssignments, 1, 'happy path must navigate the iframe exactly once');
  assert.equal(frameSrc, 'https://renderer.test/configurator/');

  await vm.runInContext('poll()', context);
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0], job);

  await windowListeners.get('message')?.({
    origin: 'https://cross-origin.test',
    source: contentWindow,
    data: { protocol: BROWSER_TRANSPORT_PROTOCOL, type: BROWSER_RENDER_RESPONSE_TYPE, request_id: job.request_id },
  });
  await windowListeners.get('message')?.({
    origin: 'https://renderer.test',
    source: {},
    data: { protocol: BROWSER_TRANSPORT_PROTOCOL, type: BROWSER_RENDER_RESPONSE_TYPE, request_id: job.request_id },
  });
  assert.equal(requests.filter(value => value.method === 'POST').length, 0, 'cross-origin/source responses are ignored');

  const response = {
    protocol: BROWSER_TRANSPORT_PROTOCOL,
    type: BROWSER_RENDER_RESPONSE_TYPE,
    request_id: job.request_id,
    ok: true,
    artifact: {
      contract: BROWSER_RENDER_CAPABILITY,
      mime_type: 'image/png',
      width: 1280,
      height: 1280,
      request_identity: quotationRenderRequestIdentity(request),
      png_bytes: new ArrayBuffer(16),
    },
  };
  await windowListeners.get('message')?.({ origin: 'https://renderer.test', source: contentWindow, data: response });
  await windowListeners.get('message')?.({ origin: 'https://renderer.test', source: contentWindow, data: response });

  assert.equal(requests.filter(value => value.url.includes('/next')).length, 1);
  assert.equal(requests.filter(value => value.url.includes('/complete/')).length, 1);
  assert.equal(requests.filter(value => value.url.endsWith('/fail')).length, 0);
  assert.equal(frameAssignments, 1, 'success must not retry or reload the renderer');
  const latestStages = JSON.parse(stageLogs.at(-1) || '{}');
  assert.deepEqual(latestStages, {
    iframe_loaded: 1,
    ready_received: 1,
    request_sent: 1,
    response_received: 1,
    png_valid: 1,
    writer_ok: 1,
    fail_code: '',
  });
});

test('Production full bridge READY timeout stays fail-closed after bounded renderer reloads', () => {
  const html = browserQuotationImageClientHtml('https://renderer.test/configurator/', {
    deferRendererLoadUntilListener: true,
  });
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script);

  const frameListeners = new Map<string, () => void>();
  const timers = new Map<number, { callback: () => void; delay: number; cancelled: boolean }>();
  const stageLogs: string[] = [];
  const requests: string[] = [];
  const posted: unknown[] = [];
  let nextTimerId = 0;
  let frameAssignments = 0;
  const frame = {
    contentWindow: { postMessage(message: unknown) { posted.push(message); } },
    set src(_value: string) {
      frameAssignments += 1;
      frameListeners.get('load')?.();
    },
    addEventListener(type: string, listener: () => void) { frameListeners.set(type, listener); },
  };
  const context = vm.createContext({
    URL,
    ArrayBuffer,
    document: {
      getElementById(id: string) {
        return id === 'quotation-image-renderer' ? frame : { textContent: '' };
      },
    },
    window: { addEventListener() {} },
    console: { info(_label: string, payload: string) { stageLogs.push(payload); } },
    clearTimeout(id: number) {
      const timer = timers.get(id);
      if (timer) timer.cancelled = true;
    },
    setTimeout(callback: () => void, delay: number) {
      nextTimerId += 1;
      timers.set(nextTimerId, { callback, delay, cancelled: false });
      return nextTimerId;
    },
    fetch: async (url: string) => {
      requests.push(url);
      return { ok: true, status: 204, json: async () => ({}) };
    },
  });

  new vm.Script(script).runInContext(context);
  for (let timeout = 0; timeout < 3; timeout += 1) {
    const activeReadyTimer = [...timers.values()].find(timer => timer.delay === 8_000 && !timer.cancelled);
    assert.ok(activeReadyTimer, `missing READY timeout ${timeout + 1}`);
    activeReadyTimer.cancelled = true;
    activeReadyTimer.callback();
  }

  assert.equal(frameAssignments, 3, 'initial navigation plus two bounded reloads');
  assert.equal(requests.length, 0, 'READY timeout must never poll the bridge');
  assert.equal(posted.length, 0, 'READY timeout must never post a render request');
  assert.deepEqual(JSON.parse(stageLogs.at(-1) || '{}'), {
    iframe_loaded: 3,
    ready_received: 0,
    request_sent: 0,
    response_received: 0,
    png_valid: 0,
    writer_ok: 0,
    fail_code: 'quotation-image-renderer-ready-timeout',
  });
});

test('client waits for an exact direct ready handshake, reloads on lost ready, and emits only aggregate stages', async () => {
  const html = browserQuotationImageClientHtml('https://renderer.test/configurator/');
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script);

  const frameListeners = new Map<string, () => void>();
  const windowListeners = new Map<string, (event: any) => void>();
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const requests: string[] = [];
  const posted: unknown[] = [];
  const stageLogs: string[] = [];
  const status = { textContent: '' };
  const contentWindow = { postMessage(message: unknown) { posted.push(message); } };
  let frameSrc = 'https://renderer.test/configurator/';
  const frame = {
    contentWindow,
    get src() { return frameSrc; },
    set src(value: string) { frameSrc = value; },
    addEventListener(type: string, listener: () => void) { frameListeners.set(type, listener); },
  };
  const job = {
    protocol: BROWSER_TRANSPORT_PROTOCOL,
    type: BROWSER_RENDER_REQUEST_TYPE,
    request_id: `quote-${'a'.repeat(64)}`,
    render_request: request,
  };
  const context = vm.createContext({
    URL,
    ArrayBuffer,
    document: { getElementById(id: string) { return id === 'quotation-image-renderer' ? frame : status; } },
    window: { addEventListener(type: string, listener: (event: any) => void) { windowListeners.set(type, listener); } },
    console: { info(_label: string, payload: string) { stageLogs.push(payload); } },
    clearTimeout() {},
    setTimeout(callback: () => void, delay: number) { timers.push({ callback, delay }); return timers.length; },
    fetch: async (url: string) => {
      requests.push(url);
      if (url.includes('/next')) return { ok: true, status: 200, json: async () => job };
      if (url.includes('/status/')) return { ok: true, status: 200, json: async () => ({ state: 'ready' }) };
      return { ok: true, status: 202, json: async () => ({ state: 'processing' }) };
    },
  });
  new vm.Script(script).runInContext(context);

  frameListeners.get('load')?.();
  assert.equal(requests.length, 0, 'iframe load alone must not poll or send work');
  assert.equal(posted.length, 0);

  windowListeners.get('message')?.({
    origin: 'https://wrong.test', source: contentWindow,
    data: { protocol: BROWSER_TRANSPORT_PROTOCOL, type: BROWSER_RENDER_READY_TYPE, capability: BROWSER_RENDER_CAPABILITY },
  });
  windowListeners.get('message')?.({
    origin: 'https://renderer.test', source: {},
    data: { protocol: BROWSER_TRANSPORT_PROTOCOL, type: BROWSER_RENDER_READY_TYPE, capability: BROWSER_RENDER_CAPABILITY },
  });
  windowListeners.get('message')?.({
    origin: 'https://renderer.test', source: contentWindow,
    data: { protocol: BROWSER_TRANSPORT_PROTOCOL, type: BROWSER_RENDER_READY_TYPE, capability: 'wrong-capability' },
  });
  windowListeners.get('message')?.({
    origin: 'https://renderer.test', source: contentWindow,
    data: {
      protocol: BROWSER_TRANSPORT_PROTOCOL, type: BROWSER_RENDER_READY_TYPE,
      capability: BROWSER_RENDER_CAPABILITY, extra: true,
    },
  });
  assert.equal(requests.length, 0, 'wrong origin, source, or capability must be ignored');

  const firstReadyTimeout = timers.find(timer => timer.delay === 8_000);
  assert.ok(firstReadyTimeout);
  firstReadyTimeout.callback();
  assert.equal(frameSrc, 'https://renderer.test/configurator/');
  assert.match(status.textContent, /正常建立/);

  frameListeners.get('load')?.();
  windowListeners.get('message')?.({
    origin: 'https://renderer.test', source: contentWindow,
    data: { protocol: BROWSER_TRANSPORT_PROTOCOL, type: BROWSER_RENDER_READY_TYPE, capability: BROWSER_RENDER_CAPABILITY },
  });
  await vm.runInContext('poll()', context);
  assert.equal(requests.length, 1);
  assert.equal(posted.length, 1);
  assert.equal((posted[0] as typeof job).request_id, job.request_id);

  windowListeners.get('message')?.({
    origin: 'https://renderer.test', source: contentWindow,
    data: { protocol: BROWSER_TRANSPORT_PROTOCOL, type: BROWSER_RENDER_READY_TYPE, capability: BROWSER_RENDER_CAPABILITY },
  });
  assert.equal(posted.length, 1, 'stale ready during an active job must not resend work');

  const renderResponse = {
    protocol: BROWSER_TRANSPORT_PROTOCOL,
    type: BROWSER_RENDER_RESPONSE_TYPE,
    request_id: job.request_id,
    ok: true,
    artifact: {
      contract: BROWSER_RENDER_CAPABILITY,
      mime_type: 'image/png', width: 1280, height: 1280,
      request_identity: quotationRenderRequestIdentity(request),
      png_bytes: new ArrayBuffer(16),
    },
  };
  await windowListeners.get('message')?.({
    origin: 'https://renderer.test', source: contentWindow, data: renderResponse,
  });
  const requestsAfterCompletion = requests.length;
  await windowListeners.get('message')?.({
    origin: 'https://renderer.test', source: contentWindow, data: renderResponse,
  });
  assert.equal(requests.length, requestsAfterCompletion, 'late duplicate response must be an exact no-op');
  assert.equal(requests.filter(url => url.includes('/complete/')).length, 1);

  const latestStages = JSON.parse(stageLogs.at(-1) || '{}');
  assert.deepEqual(Object.keys(latestStages).sort(), [
    'fail_code', 'iframe_loaded', 'png_valid', 'ready_received',
    'request_sent', 'response_received', 'writer_ok',
  ]);
  assert.equal(latestStages.iframe_loaded, 2);
  assert.equal(latestStages.ready_received, 1);
  assert.equal(latestStages.request_sent, 1);
  assert.equal(latestStages.response_received, 1);
  assert.equal(latestStages.png_valid, 1);
  assert.equal(latestStages.writer_ok, 1);
  assert.equal(latestStages.fail_code, 'quotation-image-renderer-ready-timeout');
  assert.doesNotMatch(JSON.stringify(latestStages), /quote-|sha256|renderer\.test/);
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
