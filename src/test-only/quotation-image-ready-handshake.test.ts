import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {
  BROWSER_RENDER_CAPABILITY,
  BROWSER_RENDER_READY_TYPE,
  BROWSER_RENDER_RESPONSE_TYPE,
  BROWSER_TRANSPORT_PROTOCOL,
  browserQuotationImageClientHtml,
  quotationRenderRequestIdentity,
} from '../browser-quotation-image';
import {
  QUOTATION_IMAGE_READY_HANDSHAKE_BRIDGE_PATH,
  QUOTATION_IMAGE_READY_HANDSHAKE_RENDERER_URL,
  QuotationImageReadyHandshakeFixture,
  quotationImageReadyHandshakeScopedRunKey,
} from './quotation-image-ready-handshake';

test('TEST run scope uses only the admin session cookie and isolates different sessions', () => {
  const runKey = 'a'.repeat(32);
  const expected = quotationImageReadyHandshakeScopedRunKey('lks_admin_session=session-a', runKey);
  assert.ok(expected);
  assert.equal(
    quotationImageReadyHandshakeScopedRunKey(
      'unrelated=one; lks_admin_session=session-a; preference=two',
      runKey,
    ),
    expected,
  );
  assert.equal(
    quotationImageReadyHandshakeScopedRunKey(
      'preference=changed; another=value; lks_admin_session=session-a',
      runKey,
    ),
    expected,
    'unrelated cookie additions, removals and reordering must not change the run scope',
  );
  assert.notEqual(
    quotationImageReadyHandshakeScopedRunKey('lks_admin_session=session-b', runKey),
    expected,
  );
  assert.equal(quotationImageReadyHandshakeScopedRunKey('unrelated=one', runKey), null);
  assert.equal(quotationImageReadyHandshakeScopedRunKey('lks_admin_session=session-a', 'bad'), null);
});

test('TEST HTML installs the parent listener before loading the iframe and exposes aggregate counters only', async () => {
  const fixture = new QuotationImageReadyHandshakeFixture({ timeoutMs: 100 });
  fixture.begin('2026-09-01T09:00:00.000Z');
  const job = fixture.takeNext();
  assert.ok(job);
  const html = fixture.html();
  assert.match(html, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(html, /id="status" hidden aria-hidden="true"/);
  assert.match(html, /data-renderer-src="https:\/\/lksdisplaybox\.online\/configurator\/"/);
  assert.doesNotMatch(html, /<iframe[^>]+\ssrc="https:\/\/lksdisplaybox\.online\/configurator\/"/);
  for (const key of [
    'iframe_loaded', 'ready_received', 'request_sent', 'response_received',
    'png_valid', 'writer_ok', 'fail_code',
  ]) assert.match(html, new RegExp(`${key}=`));
  for (const forbidden of ['customer', 'phone', 'email', 'address', 'quote_token', 'airtable', 'secret']) {
    assert.doesNotMatch(html.toLowerCase(), new RegExp(forbidden));
  }

  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script);
  const order: string[] = [];
  const frameListeners = new Map<string, () => void>();
  const windowListeners = new Map<string, (event: any) => unknown>();
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const stageLogs: string[] = [];
  const fetches: Array<{ url: string; method: string }> = [];
  const status = { textContent: '' };
  const counters = { textContent: '' };
  const sessionValues = new Map<string, string>();
  const contentWindow = { postMessage(message: unknown) { order.push('request_sent'); assert.deepEqual(message, job); } };
  let frameSrc = '';
  const frame = {
    contentWindow,
    get src() { return frameSrc; },
    set src(value: string) { order.push('iframe_src_set'); frameSrc = value; },
    addEventListener(type: string, listener: () => void) {
      if (type === 'load') order.push('iframe_load_listener_installed');
      frameListeners.set(type, listener);
    },
  };
  const context = vm.createContext({
    URL,
    ArrayBuffer,
    Uint8Array,
    crypto: { getRandomValues(bytes: Uint8Array) { bytes.fill(0x11); return bytes; } },
    sessionStorage: {
      getItem(key: string) { return sessionValues.get(key) || null; },
      setItem(key: string, value: string) { sessionValues.set(key, value); },
    },
    document: {
      getElementById(id: string) {
        if (id === 'quotation-image-renderer') return frame;
        if (id === 'handshake-counters') return counters;
        return status;
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
    setTimeout(callback: () => void, delay: number) {
      timers.push({ callback, delay });
      return timers.length;
    },
    fetch: async (url: string, options: { method?: string } = {}) => {
      fetches.push({ url, method: options.method || 'GET' });
      if (url.startsWith(`${QUOTATION_IMAGE_READY_HANDSHAKE_BRIDGE_PATH}/next`)) {
        return { ok: true, status: 200, json: async () => job };
      }
      if (url.startsWith(`${QUOTATION_IMAGE_READY_HANDSHAKE_BRIDGE_PATH}/complete/`)) {
        return { ok: true, status: 202, json: async () => ({ state: 'processing' }) };
      }
      if (url.startsWith(`${QUOTATION_IMAGE_READY_HANDSHAKE_BRIDGE_PATH}/status/`)) {
        return { ok: true, status: 200, json: async () => ({ state: 'ready' }) };
      }
      return { ok: true, status: 204, json: async () => ({}) };
    },
  });
  new vm.Script(script).runInContext(context);
  assert.ok(order.indexOf('message_listener_installed') < order.indexOf('iframe_src_set'));
  assert.ok(order.indexOf('iframe_load_listener_installed') < order.indexOf('iframe_src_set'));
  assert.equal(frameSrc, QUOTATION_IMAGE_READY_HANDSHAKE_RENDERER_URL);

  frameListeners.get('load')?.();
  await windowListeners.get('message')?.({
    origin: 'https://lksdisplaybox.online',
    source: contentWindow,
    data: {
      protocol: BROWSER_TRANSPORT_PROTOCOL,
      type: BROWSER_RENDER_READY_TYPE,
      capability: BROWSER_RENDER_CAPABILITY,
    },
  });
  await vm.runInContext('poll()', context);
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
      request_identity: quotationRenderRequestIdentity(job.render_request),
      png_bytes: new ArrayBuffer(16),
    },
  };
  await windowListeners.get('message')?.({
    origin: 'https://lksdisplaybox.online', source: contentWindow, data: response,
  });
  await vm.runInContext('poll(); poll(); poll();', context);
  await windowListeners.get('message')?.({
    origin: 'https://lksdisplaybox.online', source: contentWindow, data: response,
  });
  frameListeners.get('load')?.();
  const fetchCount = fetches.length;
  await windowListeners.get('message')?.({
    origin: 'https://lksdisplaybox.online', source: contentWindow, data: response,
  });
  assert.equal(fetches.length, fetchCount, 'late duplicate response must be a no-op');
  assert.equal(order.filter(value => value === 'iframe_src_set').length, 1, 'happy path must not reload');
  assert.equal(fetches.filter(item => item.url.includes('/next')).length, 1);
  assert.equal(fetches.filter(item => item.url.includes('/complete/')).length, 1);
  assert.equal(fetches.filter(item => item.url.includes('/status/')).length, 1);
  assert.equal(fetches.filter(item => item.url.endsWith('/fail')).length, 0);
  assert.equal(timers.filter(timer => timer.delay === 8_000).length >= 1, true);

  const stages = JSON.parse(stageLogs.at(-1) || '{}');
  assert.deepEqual(stages, {
    iframe_loaded: 1,
    ready_received: 1,
    request_sent: 1,
    response_received: 1,
    png_valid: 1,
    writer_ok: 1,
    fail_code: '',
  });
  assert.equal(counters.textContent, [
    'iframe_loaded=1', 'ready_received=1', 'request_sent=1', 'response_received=1',
    'png_valid=1', 'writer_ok=1', 'fail_code=',
  ].join('\n'));
  assert.doesNotMatch(counters.textContent, /quote-|sha256|https?:|customer|phone|email/i);

  fixture.complete({
    requestId: job.request_id,
    contract: BROWSER_RENDER_CAPABILITY,
    mimeType: 'image/png',
    width: 1280,
    height: 1280,
    requestIdentity: quotationRenderRequestIdentity(job.render_request),
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
  });
  await fixture.waitForCompletion();
});

test('TEST parent preserves an exact READY delivered before the matching iframe load', async () => {
  const fixture = new QuotationImageReadyHandshakeFixture({ timeoutMs: 100 });
  fixture.begin('2026-09-01T09:00:00.000Z');
  const job = fixture.takeNext();
  assert.ok(job);
  const script = fixture.html().match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script);

  const frameListeners = new Map<string, () => void>();
  const windowListeners = new Map<string, (event: any) => unknown>();
  const fetches: string[] = [];
  const stageLogs: string[] = [];
  const status = { textContent: '' };
  const counters = { textContent: '' };
  const sessionValues = new Map<string, string>();
  let frameAssignments = 0;
  let frameSrc = '';
  const contentWindow = { postMessage(message: unknown) { assert.deepEqual(message, job); } };
  const frame = {
    contentWindow,
    get src() { return frameSrc; },
    set src(value: string) { frameAssignments += 1; frameSrc = value; },
    addEventListener(type: string, listener: () => void) { frameListeners.set(type, listener); },
  };
  const context = vm.createContext({
    URL,
    ArrayBuffer,
    Uint8Array,
    crypto: { getRandomValues(bytes: Uint8Array) { bytes.fill(0x22); return bytes; } },
    sessionStorage: {
      getItem(key: string) { return sessionValues.get(key) || null; },
      setItem(key: string, value: string) { sessionValues.set(key, value); },
    },
    document: {
      getElementById(id: string) {
        if (id === 'quotation-image-renderer') return frame;
        if (id === 'handshake-counters') return counters;
        return status;
      },
    },
    window: {
      addEventListener(type: string, listener: (event: any) => unknown) {
        windowListeners.set(type, listener);
      },
    },
    console: { info(_label: string, payload: string) { stageLogs.push(payload); } },
    clearTimeout() {},
    setTimeout() { return 1; },
    fetch: async (url: string) => {
      fetches.push(url);
      if (url.startsWith(`${QUOTATION_IMAGE_READY_HANDSHAKE_BRIDGE_PATH}/next`)) {
        return { ok: true, status: 200, json: async () => job };
      }
      if (url.startsWith(`${QUOTATION_IMAGE_READY_HANDSHAKE_BRIDGE_PATH}/complete/`)) {
        return { ok: true, status: 202, json: async () => ({ state: 'processing' }) };
      }
      if (url.startsWith(`${QUOTATION_IMAGE_READY_HANDSHAKE_BRIDGE_PATH}/status/`)) {
        return { ok: true, status: 200, json: async () => ({ state: 'ready' }) };
      }
      return { ok: true, status: 204, json: async () => ({}) };
    },
  });
  new vm.Script(script).runInContext(context);

  await windowListeners.get('message')?.({
    origin: 'https://lksdisplaybox.online',
    source: contentWindow,
    data: {
      protocol: BROWSER_TRANSPORT_PROTOCOL,
      type: BROWSER_RENDER_READY_TYPE,
      capability: BROWSER_RENDER_CAPABILITY,
    },
  });
  frameListeners.get('load')?.();
  await vm.runInContext('poll()', context);
  await windowListeners.get('message')?.({
    origin: 'https://lksdisplaybox.online',
    source: contentWindow,
    data: {
      protocol: BROWSER_TRANSPORT_PROTOCOL,
      type: BROWSER_RENDER_RESPONSE_TYPE,
      request_id: job.request_id,
      ok: true,
      artifact: {
        contract: BROWSER_RENDER_CAPABILITY,
        mime_type: 'image/png',
        width: 1280,
        height: 1280,
        request_identity: quotationRenderRequestIdentity(job.render_request),
        png_bytes: new ArrayBuffer(16),
      },
    },
  });

  assert.equal(frameAssignments, 1, 'READY before load must not trigger a renderer reload');
  assert.equal(fetches.filter(url => url.includes('/next')).length, 1);
  assert.equal(fetches.filter(url => url.includes('/complete/')).length, 1);
  assert.equal(fetches.filter(url => url.includes('/status/')).length, 1);
  assert.equal(fetches.filter(url => url.endsWith('/fail')).length, 0);
  assert.deepEqual(JSON.parse(stageLogs.at(-1) || '{}'), {
    iframe_loaded: 1,
    ready_received: 1,
    request_sent: 1,
    response_received: 1,
    png_valid: 1,
    writer_ok: 1,
    fail_code: '',
  });
  assert.equal(counters.textContent, [
    'iframe_loaded=1', 'ready_received=1', 'request_sent=1', 'response_received=1',
    'png_valid=1', 'writer_ok=1', 'fail_code=',
  ].join('\n'));

  fixture.complete({
    requestId: job.request_id,
    contract: BROWSER_RENDER_CAPABILITY,
    mimeType: 'image/png',
    width: 1280,
    height: 1280,
    requestIdentity: quotationRenderRequestIdentity(job.render_request),
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
  });
  await fixture.waitForCompletion();
});

test('TEST parent reload restores terminal counters and never polls or reloads the renderer again', async () => {
  const fixture = new QuotationImageReadyHandshakeFixture({ timeoutMs: 100 });
  const script = fixture.html().match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script);
  const runKey = '33'.repeat(16);
  const sessionValues = new Map<string, string>([
    ['lks-quotation-image-test-run-v1', runKey],
    [`lks-quotation-image-test-run-v1:complete:${runKey}`, '1'],
  ]);
  const frameListeners = new Map<string, () => void>();
  const windowListeners = new Map<string, (event: any) => unknown>();
  const counters = { textContent: '' };
  const status = { textContent: '' };
  const fetches: string[] = [];
  let frameAssignments = 0;
  const contentWindow = { postMessage() { throw new Error('terminal reload must not post a job'); } };
  const frame = {
    contentWindow,
    get src() { return ''; },
    set src(_value: string) { frameAssignments += 1; },
    addEventListener(type: string, listener: () => void) { frameListeners.set(type, listener); },
  };
  const context = vm.createContext({
    URL,
    ArrayBuffer,
    Uint8Array,
    crypto: { getRandomValues() { throw new Error('stored run key must be reused'); } },
    sessionStorage: {
      getItem(key: string) { return sessionValues.get(key) || null; },
      setItem(key: string, value: string) { sessionValues.set(key, value); },
    },
    document: {
      getElementById(id: string) {
        if (id === 'quotation-image-renderer') return frame;
        if (id === 'handshake-counters') return counters;
        return status;
      },
    },
    window: {
      addEventListener(type: string, listener: (event: any) => unknown) {
        windowListeners.set(type, listener);
      },
    },
    console: { info() {} },
    clearTimeout() {},
    setTimeout() { throw new Error('terminal reload must not schedule a timer'); },
    fetch: async (url: string) => {
      fetches.push(url);
      return { ok: true, status: 204, json: async () => ({}) };
    },
  });
  new vm.Script(script).runInContext(context);
  await vm.runInContext('poll(); poll(); poll(); poll();', context);
  frameListeners.get('load')?.();
  await windowListeners.get('message')?.({
    origin: 'https://lksdisplaybox.online',
    source: contentWindow,
    data: {
      protocol: BROWSER_TRANSPORT_PROTOCOL,
      type: BROWSER_RENDER_READY_TYPE,
      capability: BROWSER_RENDER_CAPABILITY,
    },
  });
  assert.equal(frameAssignments, 0);
  assert.deepEqual(fetches, []);
  assert.equal(counters.textContent, [
    'iframe_loaded=1', 'ready_received=1', 'request_sent=1', 'response_received=1',
    'png_valid=1', 'writer_ok=1', 'fail_code=',
  ].join('\n'));
});

test('TEST fixture validates and writes one synthetic PNG exactly once', async () => {
  const fixture = new QuotationImageReadyHandshakeFixture({ timeoutMs: 100 });
  fixture.begin('2026-09-01T09:00:00.000Z');
  const job = fixture.takeNext();
  assert.ok(job);
  assert.equal(JSON.stringify(job).match(/customer|phone|email|address|token|amount/gi), null);
  assert.equal(job.render_request.show_price, false);
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  const completion = {
    requestId: job.request_id,
    contract: BROWSER_RENDER_CAPABILITY,
    mimeType: 'image/png',
    width: 1280,
    height: 1280,
    requestIdentity: quotationRenderRequestIdentity(job.render_request),
    bytes,
  };
  assert.equal(fixture.complete(completion), true);
  assert.equal(fixture.complete(completion), false);
  assert.equal((await fixture.waitForCompletion())?.state, 'ready');
  assert.deepEqual(fixture.evidence(), {
    active: true,
    started_at: '2026-09-01T09:00:00.000Z',
    completed_at: fixture.evidence().completed_at,
    complete: 1,
    storage: 1,
    attachment: 1,
    writer: 1,
    fail: 0,
    png_bytes: bytes.length,
    png_sha256: '275f1bcbbb585c71e3b2184304eccfa0e37de92022ca3b6f4e9c10df32318d85',
    request_identity: completion.requestIdentity,
  });
  assert.match(String(fixture.evidence().completed_at), /^2026-/);
});

test('TEST fixture isolates overlapping tabs and completed runs stay terminal across later polls', async () => {
  const fixture = new QuotationImageReadyHandshakeFixture({ timeoutMs: 100 });
  const runA = 'a'.repeat(32);
  const runB = 'b'.repeat(32);
  fixture.begin('2026-09-01T09:00:00.000Z', runA);
  fixture.begin('2026-09-01T09:00:01.000Z', runB);
  const jobA = fixture.takeNext(runA);
  const jobB = fixture.takeNext(runB);
  assert.ok(jobA);
  assert.ok(jobB);
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  const completion = (job: NonNullable<typeof jobA>) => ({
    requestId: job.request_id,
    contract: BROWSER_RENDER_CAPABILITY,
    mimeType: 'image/png',
    width: 1280,
    height: 1280,
    requestIdentity: quotationRenderRequestIdentity(job.render_request),
    bytes,
  });
  assert.equal(fixture.complete(completion(jobA), runA), true);
  assert.equal(fixture.complete(completion(jobA), runA), false, 'late duplicate complete must be a no-op');
  assert.equal((await fixture.waitForCompletion(runA))?.state, 'ready');
  assert.equal(fixture.takeNext(runA), null);
  assert.equal(fixture.takeNext(runA), null);
  assert.equal(fixture.takeNext(runA), null, 'completed run must remain empty after more than two polls');
  assert.equal(fixture.evidence(runB).writer, 0, 'run A must not complete overlapping run B');
  assert.equal(fixture.complete(completion(jobB), runB), true);
  assert.equal((await fixture.waitForCompletion(runB))?.state, 'ready');
  assert.equal(fixture.takeNext(runB), null);
  for (const runKey of [runA, runB]) {
    assert.deepEqual(
      {
        complete: fixture.evidence(runKey).complete,
        storage: fixture.evidence(runKey).storage,
        attachment: fixture.evidence(runKey).attachment,
        writer: fixture.evidence(runKey).writer,
        fail: fixture.evidence(runKey).fail,
      },
      { complete: 1, storage: 1, attachment: 1, writer: 1, fail: 0 },
    );
  }
});

test('TEST capacity pressure never evicts a first-fail run that is still retryable', async () => {
  const fixture = new QuotationImageReadyHandshakeFixture({ timeoutMs: 200 });
  const retryRun = '00'.repeat(16);
  fixture.begin('2026-09-01T09:00:00.000Z', retryRun);
  const firstJob = fixture.takeNext(retryRun);
  assert.ok(firstJob);
  fixture.fail(firstJob.request_id, 'safe-first-delivery-failed', retryRun);
  assert.equal(fixture.evidence(retryRun).fail, 1);

  for (let index = 1; index < 32; index += 1) {
    const runKey = index.toString(16).padStart(32, '0');
    fixture.begin(`2026-09-01T09:00:${String(index).padStart(2, '0')}.000Z`, runKey);
  }
  const overflowRun = 'ff'.repeat(16);
  assert.throws(
    () => fixture.takeNext(overflowRun),
    /run capacity reached/,
    'capacity pressure must fail closed while all 32 runs remain active',
  );
  const retryJob = fixture.takeNext(retryRun);
  assert.deepEqual(retryJob, firstJob, 'the original retryable run identity must survive capacity pressure');
  assert.equal(fixture.evidence(retryRun).fail, 1, 'retryable run state must not be reset');

  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  assert.equal(fixture.complete({
    requestId: retryJob!.request_id,
    contract: BROWSER_RENDER_CAPABILITY,
    mimeType: 'image/png',
    width: 1280,
    height: 1280,
    requestIdentity: quotationRenderRequestIdentity(retryJob!.render_request),
    bytes,
  }, retryRun), true);
  assert.equal((await fixture.waitForCompletion(retryRun))?.state, 'ready');
  assert.equal(fixture.evidence(retryRun).writer, 1);
  assert.ok(fixture.takeNext(overflowRun), 'one terminal run may be evicted to admit a new isolated run');
  assert.equal(fixture.takeNext(retryRun), null, 'evicted terminal run key must remain replay-blocked');
});

test('Production parent defaults remain on the existing worker and eager iframe behavior', () => {
  const html = browserQuotationImageClientHtml('https://lksdisplaybox.online/configurator/');
  assert.match(html, /<iframe[^>]+src="https:\/\/lksdisplaybox\.online\/configurator\/"/);
  assert.doesNotMatch(html, /data-renderer-src=/);
  assert.doesNotMatch(html, /handshake-counters/);
  assert.doesNotMatch(html, /id="status" hidden/);
  assert.match(html, /fetch\("\/quotation-image\/browser-bridge\/next" \+ recoveryQuery/);
  assert.doesNotMatch(html, /bridgeFetch|sessionStorage|X-LKS-Test-Run|testRunKey|terminalSuccess/);
  assert.doesNotMatch(html, /test-only\/quotation-image-ready-handshake/);
});

test('an unexpected child self-load still clears readiness until a fresh exact READY', async () => {
  const html = browserQuotationImageClientHtml('https://lksdisplaybox.online/configurator/');
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(script);
  const frameListeners = new Map<string, () => void>();
  const windowListeners = new Map<string, (event: any) => unknown>();
  const requests: string[] = [];
  const contentWindow = { postMessage() {} };
  const frame = {
    contentWindow,
    src: 'https://lksdisplaybox.online/configurator/',
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
    window: {
      addEventListener(type: string, listener: (event: any) => unknown) {
        windowListeners.set(type, listener);
      },
    },
    console: { info() {} },
    clearTimeout() {},
    setTimeout() { return 1; },
    fetch: async (url: string) => {
      requests.push(url);
      return { ok: true, status: 204, json: async () => ({}) };
    },
  });
  new vm.Script(script).runInContext(context);
  const ready = {
    origin: 'https://lksdisplaybox.online',
    source: contentWindow,
    data: {
      protocol: BROWSER_TRANSPORT_PROTOCOL,
      type: BROWSER_RENDER_READY_TYPE,
      capability: BROWSER_RENDER_CAPABILITY,
    },
  };
  await windowListeners.get('message')?.(ready);
  frameListeners.get('load')?.();
  await vm.runInContext('poll()', context);
  assert.equal(requests.length, 0, 'untracked self-load must clear the earlier READY');
  await windowListeners.get('message')?.(ready);
  await vm.runInContext('poll()', context);
  assert.equal(requests.length, 1, 'fresh READY after self-load may resume polling');
});
