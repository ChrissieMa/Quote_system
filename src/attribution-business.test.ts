import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAttributionBusinessHooks } from './attribution-business';
import { LocalAttributionStore } from './attribution-store';
import { AttributionProjector } from './attribution-projection';
import { SerializedAirtableProjectionTransport } from './attribution-airtable';
import { AttributionRequest } from './attribution-validation';
import { SyntheticAirtableClient, syntheticProjectionMapping } from './test-only/attribution-projection-fixture';

const now = Date.parse('2026-01-01T00:00:00Z');
const input = (requestId: string): AttributionRequest => ({
  contractVersion: '1.0.0', requestId: `ar_v1_${requestId.repeat(32)}`, attributionId: `aid_v1_${'a'.repeat(32)}`,
  firstTouch: {
    observedAt: '2026-01-01T00:00:00Z', channel: 'direct', source: '(direct)', medium: '(none)',
    campaignKey: null, landingPath: '/', evidence: 'direct_observed', confidence: 'signal_limited',
  },
  lastTouch: {
    observedAt: '2026-01-01T00:00:00Z', channel: 'direct', source: '(direct)', medium: '(none)',
    campaignKey: null, landingPath: '/', evidence: 'direct_observed', confidence: 'signal_limited',
  },
  entrySurface: 'wordpress',
  consent: { ad_storage: 'granted', analytics_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted' },
});

const waitFor = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error('Synthetic projection did not settle.');
};

test('successful business hooks request one coalesced nonblocking projection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'attribution-business-'));
  try {
    const store = new LocalAttributionStore(join(dir, 'store.sqlite'), Buffer.alloc(32, 3));
    const client = new SyntheticAirtableClient();
    client.seed('Inquiries', 'inquiry');
    client.seed('Quotes', 'quote');
    client.seed('Quotes', 'unknown');
    client.seed('Orders', 'order');
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const blocked = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    client.beforeUpdate = async table => {
      if (table === 'Inquiries') { entered?.(); await gate; }
    };
    const errors: string[] = [];
    const projector = new AttributionProjector(store, new SerializedAirtableProjectionTransport(store, client.table, true), syntheticProjectionMapping(), message => errors.push(message));
    const hooks = createAttributionBusinessHooks(store, () => now, message => errors.push(message), () => projector.requestFlush());
    const receipt = store.create(input('b'), now);
    if (receipt.outcome !== 'created') throw new Error('Expected receipt.');
    assert.equal(hooks.inquiry(receipt.shortCode, 'inquiry').outcome, 'matched');
    assert.deepEqual(client.writes, { create: 0, update: 0 });
    await blocked;
    assert.equal(hooks.quote(receipt.shortCode, 'inquiry', 'quote').outcome, 'matched');
    hooks.order('quote', 'order');
    assert.equal(hooks.quote('', 'inquiry', 'unknown').outcome, 'unknown');
    release?.();
    await waitFor(() => store.nextProjection() === null);
    const quote = await client.read('Quotes', 'quote');
    assert.deepEqual((await client.read('Orders', 'order')).fields['Attribution Snapshot'], quote.fields['Attribution Snapshot']);
    assert.equal((await client.read('Quotes', 'unknown')).fields['Attribution Snapshot'], undefined);
    assert.equal(client.count('Attributions'), 1);
    assert.deepEqual(errors, []);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('only successful local bindings request projection and callback failure stays fail-open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'attribution-business-'));
  try {
    const store = new LocalAttributionStore(join(dir, 'store.sqlite'), Buffer.alloc(32, 3));
    const errors: string[] = [];
    let requests = 0;
    const hooks = createAttributionBusinessHooks(store, () => now, message => errors.push(message), () => { requests += 1; throw new Error('Synthetic callback failure'); });
    assert.equal(hooks.inquiry('', 'inquiry').outcome, 'unknown');
    assert.equal(hooks.inquiry(`LKS-${'0'.repeat(16)}`, 'inquiry').reason, 'not_found');
    assert.equal(requests, 0);
    const receipt = store.create(input('b'), now);
    if (receipt.outcome !== 'created') throw new Error('Expected receipt.');
    assert.equal(hooks.inquiry(receipt.shortCode, 'inquiry').outcome, 'matched');
    assert.equal(hooks.quote('', 'inquiry', 'quote').outcome, 'unknown');
    hooks.order('quote', 'order');
    assert.equal(requests, 3);
    store.close();
    assert.equal(hooks.inquiry(receipt.shortCode, 'inquiry').reason, 'service_unavailable');
    assert.equal(hooks.quote(receipt.shortCode, 'inquiry', 'other').reason, 'service_unavailable');
    hooks.order('quote', 'other');
    assert.equal(requests, 3);
    assert.equal(errors.filter(message => message === 'Attribution projection unavailable; retry is required.').length, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('automatic projection leaves uncertain writes pending without recovery or duplicate creation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'attribution-business-'));
  try {
    const store = new LocalAttributionStore(join(dir, 'store.sqlite'), Buffer.alloc(32, 3));
    const client = new SyntheticAirtableClient();
    client.seed('Inquiries', 'inquiry');
    client.seed('Quotes', 'quote');
    const errors: string[] = [];
    const projector = new AttributionProjector(store, new SerializedAirtableProjectionTransport(store, client.table, true), syntheticProjectionMapping(), message => errors.push(message));
    const hooks = createAttributionBusinessHooks(store, () => now, message => errors.push(message), () => projector.requestFlush());
    const receipt = store.create(input('b'), now);
    if (receipt.outcome !== 'created') throw new Error('Expected receipt.');
    client.failure = { operation: 'create', after: true };
    assert.equal(hooks.quote(receipt.shortCode, 'inquiry', 'quote').outcome, 'matched');
    await waitFor(() => store.projectionWriterStatus().state === 'uncertain');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(client.count('Attributions'), 1);
    assert.ok(store.nextProjection());
    hooks.order('quote', 'order');
    await waitFor(() => errors.length >= 2);
    assert.equal(store.projectionWriterStatus().state, 'uncertain');
    assert.equal(client.count('Attributions'), 1);
    assert.ok(store.nextProjection());
    assert.ok(errors.every(message => message === 'Attribution projection unavailable; retry is required.'));
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('automatic projection reports pending after one bounded batch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'attribution-business-'));
  try {
    const store = new LocalAttributionStore(join(dir, 'store.sqlite'), Buffer.alloc(32, 3));
    const client = new SyntheticAirtableClient();
    const errors: string[] = [];
    const projector = new AttributionProjector(store, new SerializedAirtableProjectionTransport(store, client.table, true), syntheticProjectionMapping(), message => errors.push(message));
    const hooks = createAttributionBusinessHooks(store, () => now, message => errors.push(message), () => projector.requestFlush());
    for (let index = 0; index < 101; index += 1) {
      const id = `quote-${index}`;
      client.seed('Quotes', id);
      hooks.quote('', '', id);
    }
    await waitFor(() => errors.length > 0);
    assert.deepEqual(errors, ['Attribution projection pending; retry is required.']);
    assert.equal(store.nextProjection()?.entityId, 'quote-100');
    hooks.quote('', '', 'quote-100');
    await waitFor(() => store.nextProjection() === null);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('durable bindings preserve first, latest, quote and order snapshots without borrowing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'attribution-business-'));
  try {
    const path = join(dir, 'store.sqlite');
    let store = new LocalAttributionStore(path, Buffer.alloc(32, 3));
    const transport = new SyntheticAirtableClient();
    transport.seed('Inquiries', 'inquiry');
    for (const id of ['one', 'two', 'missing', 'deleted', 'ambiguous']) transport.seed('Quotes', id);
    transport.seed('Orders', 'order-one');
    transport.seed('Orders', 'order-two');
    let hooks = createAttributionBusinessHooks(store, () => now, message => { throw new Error(message); });
    const first = store.create(input('b'), now);
    const next = store.create(input('c'), now + 1);
    if (first.outcome !== 'created' || next.outcome !== 'created') throw new Error('Expected receipts.');
    assert.equal(hooks.inquiry(first.shortCode, 'inquiry').outcome, 'matched');
    hooks.quote(first.shortCode, 'inquiry', 'one');
    hooks.order('one', 'order-one');
    hooks.inquiry(next.shortCode, 'inquiry');
    hooks.quote(next.shortCode, 'inquiry', 'two');
    hooks.order('two', 'order-two');
    hooks.quote('', 'inquiry', 'missing');
    hooks.quote('[LKS-UNKNOWN]', 'inquiry', 'deleted');
    hooks.quote(`[${first.shortCode}] [${next.shortCode}]`, 'inquiry', 'ambiguous');
    store.close();
    store = new LocalAttributionStore(path, Buffer.alloc(32, 3));
    hooks = createAttributionBusinessHooks(store, () => now, message => { throw new Error(message); });
    hooks.quote(next.shortCode, 'inquiry', 'one');
    hooks.order('two', 'order-one');
    const projector = new AttributionProjector(store, new SerializedAirtableProjectionTransport(store, transport.table, true), syntheticProjectionMapping(), message => { throw new Error(message); });
    assert.equal((await projector.flush()).pending, false);
    const inquiry = await transport.read('Inquiries', 'inquiry');
    const firstLink = (inquiry.fields['First Attribution'] as string[])[0];
    const latestLink = (inquiry.fields['Latest Attribution'] as string[])[0];
    assert.notEqual(firstLink, latestLink);
    assert.equal((await transport.read('Attributions', firstLink)).fields.Code, first.shortCode);
    assert.equal((await transport.read('Attributions', latestLink)).fields.Code, next.shortCode);
    assert.deepEqual((await transport.read('Quotes', 'one')).fields['Attribution Snapshot'], [firstLink]);
    assert.deepEqual((await transport.read('Orders', 'order-one')).fields['Attribution Snapshot'], [firstLink]);
    assert.deepEqual((await transport.read('Orders', 'order-two')).fields['Attribution Snapshot'], [latestLink]);
    for (const id of ['missing', 'deleted', 'ambiguous']) assert.equal((await transport.read('Quotes', id)).fields['Attribution Snapshot'], undefined);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unknown outcome on revoke and ambiguous external write is retried after reopen without duplicates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'attribution-business-'));
  try {
    const path = join(dir, 'store.sqlite');
    let store = new LocalAttributionStore(path, Buffer.alloc(32, 3));
    const transport = new SyntheticAirtableClient();
    transport.seed('Inquiries', 'inquiry');
    transport.seed('Quotes', 'quote');
    const errors: string[] = [];
    let hooks = createAttributionBusinessHooks(store, () => now, message => errors.push(message));
    const first = store.create(input('b'), now);
    if (first.outcome !== 'created') throw new Error('Expected receipt.');
    hooks.quote(first.shortCode, 'inquiry', 'quote');
    transport.failure = { operation: 'create', after: true };
    let projector = new AttributionProjector(store, new SerializedAirtableProjectionTransport(store, transport.table, true), syntheticProjectionMapping(), message => errors.push(message));
    assert.deepEqual(await projector.flush(), { attempted: 1, completed: 0, pending: true, failed: true });
    assert.equal(transport.count('Attributions'), 1);
    store.revoke(input('b').attributionId, first.revocationProof, now);
    assert.ok(store.resolve(first.shortCode, now));
    store.close();
    store = new LocalAttributionStore(path, Buffer.alloc(32, 3));
    hooks = createAttributionBusinessHooks(store, () => now, message => errors.push(message));
    projector = new AttributionProjector(store, new SerializedAirtableProjectionTransport(store, transport.table, true), syntheticProjectionMapping(), message => errors.push(message));
    assert.equal((await projector.flush()).failed, true);
    const status = store.projectionWriterStatus();
    assert.equal(status.state, 'uncertain');
    if (!status.owner) throw new Error('Expected recovery owner.');
    const matches = await transport.table('Attributions').select({ filterByFormula: `{Code} = '${first.shortCode}'`, maxRecords: 2, pageSize: 2 }).firstPage();
    assert.equal(matches.length, 1);
    store.recoverProjectionWriter(status.owner, 'external-writes-settled-and-reconciled', [{ code: first.shortCode, recordId: matches[0].id }]);
    assert.equal((await projector.flush()).pending, false);
    assert.equal(transport.count('Attributions'), 1);
    const unbound = store.create(input('c'), now);
    if (unbound.outcome !== 'created') throw new Error('Expected receipt.');
    store.revoke(input('c').attributionId, unbound.revocationProof, now);
    assert.equal(hooks.quote(unbound.shortCode, 'inquiry', 'late').reason, 'not_found');
    assert.deepEqual(errors, ['Attribution projection unavailable; retry is required.', 'Attribution projection unavailable; retry is required.']);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('exclusive projection serializes writers while bindings continue locally', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'attribution-business-'));
  try {
    const store = new LocalAttributionStore(join(dir, 'store.sqlite'), Buffer.alloc(32, 3));
    const underlying = new SyntheticAirtableClient();
    underlying.seed('Inquiries', 'inquiry');
    let release: (() => void) | undefined;
    let blocked: (() => void) | undefined;
    const entered = new Promise<void>(resolve => { blocked = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    underlying.beforeUpdate = async (table, fields) => {
      if (table === 'Inquiries' && fields['Projection Revision'] === 1) { blocked?.(); await gate; }
    };
    const hooks = createAttributionBusinessHooks(store, () => now, message => { throw new Error(message); });
    const first = store.create(input('b'), now);
    const second = store.create(input('c'), now);
    if (first.outcome !== 'created' || second.outcome !== 'created') throw new Error('Expected receipts.');
    hooks.inquiry(first.shortCode, 'inquiry');
    const firstFlush = new AttributionProjector(store, new SerializedAirtableProjectionTransport(store, underlying.table, true), syntheticProjectionMapping(), message => { throw new Error(message); }).flush();
    await entered;
    hooks.inquiry(second.shortCode, 'inquiry');
    const errors: string[] = [];
    assert.equal((await new AttributionProjector(store, new SerializedAirtableProjectionTransport(store, underlying.table, true), syntheticProjectionMapping(), message => errors.push(message)).flush()).failed, true);
    release?.();
    assert.equal((await firstFlush).pending, false);
    const inquiry = await underlying.read('Inquiries', 'inquiry');
    const latest = (inquiry.fields['Latest Attribution'] as string[])[0];
    assert.equal((await underlying.read('Attributions', latest)).fields.Code, second.shortCode);
    assert.equal(inquiry.fields['Projection Revision'], 2);
    assert.deepEqual(errors, ['Attribution projection unavailable; retry is required.']);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('uncertain update remains locked across restart until explicit reconciliation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'attribution-business-'));
  try {
    const path = join(dir, 'store.sqlite');
    let store = new LocalAttributionStore(path, Buffer.alloc(32, 3));
    const client = new SyntheticAirtableClient();
    client.seed('Inquiries', 'inquiry');
    client.seed('Quotes', 'quote');
    const hooks = createAttributionBusinessHooks(store, () => now, () => {});
    const receipt = store.create(input('b'), now);
    if (receipt.outcome !== 'created') throw new Error('Expected receipt.');
    assert.equal(hooks.quote(receipt.shortCode, 'inquiry', 'quote').outcome, 'matched');
    assert.deepEqual(client.writes, { create: 0, update: 0 });
    client.failure = { operation: 'update', after: true };
    const projection = () => new AttributionProjector(store, new SerializedAirtableProjectionTransport(store, client.table, true), syntheticProjectionMapping(), () => {});
    assert.equal((await projection().flush()).failed, true);
    const status = store.projectionWriterStatus();
    assert.equal(status.state, 'uncertain');
    assert.equal(status.inflight, true);
    if (!status.owner) throw new Error('Expected owner.');
    store.close();
    store = new LocalAttributionStore(path, Buffer.alloc(32, 3));
    assert.equal((await projection().flush()).failed, true);
    assert.throws(() => store.recoverProjectionWriter('wrong', 'external-writes-settled-and-reconciled', []));
    store.recoverProjectionWriter(status.owner, 'external-writes-settled-and-reconciled', []);
    assert.equal((await projection().flush()).pending, false);
    assert.equal(client.writes.create, 1);
    assert.equal(client.writes.update, 2);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('conflicting external pins are never overwritten', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'attribution-business-'));
  try {
    const store = new LocalAttributionStore(join(dir, 'store.sqlite'), Buffer.alloc(32, 3));
    const client = new SyntheticAirtableClient();
    client.seed('Inquiries', 'inquiry');
    client.seed('Quotes', 'quote', { 'Attribution Snapshot': ['existing-other'] });
    const hooks = createAttributionBusinessHooks(store, () => now, () => {});
    const receipt = store.create(input('b'), now);
    if (receipt.outcome !== 'created') throw new Error('Expected receipt.');
    hooks.quote(receipt.shortCode, 'inquiry', 'quote');
    const projector = new AttributionProjector(store, new SerializedAirtableProjectionTransport(store, client.table, true), syntheticProjectionMapping(), () => {});
    assert.equal((await projector.flush()).failed, true);
    assert.deepEqual((await client.read('Quotes', 'quote')).fields['Attribution Snapshot'], ['existing-other']);
    assert.equal(store.projectionWriterStatus().state, 'idle');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('active writer survives restart without automatic takeover', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'attribution-business-'));
  try {
    const path = join(dir, 'store.sqlite');
    let store = new LocalAttributionStore(path, Buffer.alloc(32, 3));
    const owner = store.acquireProjectionWriter();
    store.close();
    store = new LocalAttributionStore(path, Buffer.alloc(32, 3));
    const client = new SyntheticAirtableClient();
    const projector = new AttributionProjector(store, new SerializedAirtableProjectionTransport(store, client.table, true), syntheticProjectionMapping(), () => {});
    assert.equal((await projector.flush()).failed, true);
    assert.equal(store.projectionWriterStatus().state, 'active');
    store.recoverProjectionWriter(owner, 'external-writes-settled-and-reconciled', []);
    assert.equal((await projector.flush()).failed, false);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
