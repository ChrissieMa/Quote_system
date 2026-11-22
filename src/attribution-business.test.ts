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
