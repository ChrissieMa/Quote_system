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
} from './quotation-image-ready-handshake';

test('TEST HTML installs the parent listener before loading the iframe and exposes aggregate counters only', async () => {
  const fixture = new QuotationImageReadyHandshakeFixture({ timeoutMs: 100 });
  fixture.begin('2026-09-01T09:00:00.000Z');
  const job = fixture.takeNext();
  assert.ok(job);
  const html = fixture.html();
  assert.match(html, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(html, /id="status" hidden aria-hidden="true"/);
  assert.match(html, /data-renderer-src="https:\/\/lksdisplaybox\.online\/configurator-test\/"/);
  assert.doesNotMatch(html, /<iframe[^>]+\ssrc="https:\/\/lksdisplaybox\.online\/configurator-test\/"/);
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

test('Production parent defaults remain on the existing worker and eager iframe behavior', () => {
  const html = browserQuotationImageClientHtml('https://lksdisplaybox.online/configurator/');
  assert.match(html, /<iframe[^>]+src="https:\/\/lksdisplaybox\.online\/configurator\/"/);
  assert.doesNotMatch(html, /data-renderer-src=/);
  assert.doesNotMatch(html, /handshake-counters/);
  assert.doesNotMatch(html, /id="status" hidden/);
  assert.match(html, /fetch\("\/quotation-image\/browser-bridge\/next" \+ recoveryQuery/);
  assert.doesNotMatch(html, /test-only\/quotation-image-ready-handshake/);
});
