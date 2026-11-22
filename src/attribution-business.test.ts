import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAttributionBusinessHooks } from './attribution-business';
import { LocalAttributionStore } from './attribution-store';
import { AttributionRequest } from './attribution-validation';
import { SyntheticAttributionBusiness } from './test-only/attribution-business-fixture';

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

test('binding keeps first, updates latest, pins quotes, copies orders and never borrows a source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'attribution-business-'));
  try {
    const store = new LocalAttributionStore(join(dir, 'store.sqlite'), Buffer.alloc(32, 3));
    const business = new SyntheticAttributionBusiness();
    const hooks = createAttributionBusinessHooks(store, business, () => now, message => { throw new Error(message); });
    const first = store.create(input('b'), now);
    const next = store.create(input('c'), now + 1);
    if (first.outcome !== 'created' || next.outcome !== 'created') throw new Error('Expected receipts.');
    hooks.inquiry(first.shortCode, 'inquiry');
    hooks.quote(first.shortCode, 'inquiry', 'quote-one');
    hooks.order('quote-one', 'order-one');
    hooks.inquiry(next.shortCode, 'inquiry');
    hooks.quote(next.shortCode, 'inquiry', 'quote-two');
    assert.equal(business.inquiries.get('inquiry')?.first.shortCode, first.shortCode);
    assert.equal(business.inquiries.get('inquiry')?.latest.shortCode, next.shortCode);
    assert.equal(business.quotes.get('quote-one')?.shortCode, first.shortCode);
    assert.equal(business.orders.get('order-one')?.shortCode, first.shortCode);
    hooks.order('quote-two', 'order-two');
    assert.equal(business.orders.get('order-two')?.shortCode, next.shortCode);
    hooks.quote('', 'inquiry', 'missing');
    hooks.quote('[LKS-UNKNOWN]', 'inquiry', 'deleted');
    hooks.quote(`[${first.shortCode}] [${next.shortCode}]`, 'inquiry', 'ambiguous');
    assert.equal(business.quotes.get('missing'), null);
    assert.equal(business.quotes.get('deleted'), null);
    assert.equal(business.quotes.get('ambiguous'), null);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('revocation and failed projection do not bind late handoffs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'attribution-business-'));
  try {
    const store = new LocalAttributionStore(join(dir, 'store.sqlite'), Buffer.alloc(32, 3));
    const business = new SyntheticAttributionBusiness();
    const errors: string[] = [];
    const hooks = createAttributionBusinessHooks(store, business, () => now, message => errors.push(message));
    const receipt = store.create(input('b'), now);
    if (receipt.outcome !== 'created') throw new Error('Expected receipt.');
    const failing = createAttributionBusinessHooks(store, {
      attachInquiry() { throw new Error('synthetic failure'); },
      pinQuote() { throw new Error('synthetic failure'); },
      copyQuoteToOrder() { throw new Error('synthetic failure'); },
    }, () => now, message => errors.push(message));
    failing.inquiry(receipt.shortCode, 'inquiry');
    store.revoke(input('b').attributionId, receipt.revocationProof, now);
    hooks.quote(receipt.shortCode, 'inquiry', 'late');
    assert.equal(business.quotes.get('late'), null);
    assert.deepEqual(errors, ['Attribution inquiry binding unavailable.']);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('campaign projection uses only configured existing records with matching source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'attribution-business-'));
  try {
    const store = new LocalAttributionStore(join(dir, 'store.sqlite'), Buffer.alloc(32, 3));
    const business = new SyntheticAttributionBusiness(new Map([
      ['demo', { source: 'instagram', recordId: 'existing-campaign' }],
    ]));
    const hooks = createAttributionBusinessHooks(store, business, () => now, message => { throw new Error(message); });
    const request = input('b');
    request.firstTouch = { ...request.firstTouch, channel: 'meta_ads', source: 'instagram', medium: 'paid_social', evidence: 'paid_utm', campaignKey: 'demo' };
    request.lastTouch = { ...request.firstTouch, source: 'facebook' };
    const receipt = store.create(request, now);
    if (receipt.outcome !== 'created') throw new Error('Expected receipt.');
    hooks.quote(receipt.shortCode, 'inquiry', 'quote');
    assert.equal(business.attributions.get(receipt.shortCode)?.firstCampaign, 'existing-campaign');
    assert.equal(business.attributions.get(receipt.shortCode)?.lastCampaign, null);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
