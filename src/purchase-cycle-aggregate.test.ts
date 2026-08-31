import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPurchaseCycleAggregate,
  validateAggregateDateRange,
  type AggregateRecord,
} from './purchase-cycle-aggregate';

const record = (id: string, fields: Record<string, unknown>): AggregateRecord => ({ id, fields });

test('three quotes in one inquiry count as one quoted purchase cycle', () => {
  const result = buildPurchaseCycleAggregate({
    from: '2026-08-24',
    to: '2026-08-30',
    inquiries: [record('inq-1', { 'Inquiry Date': '2026-08-24' })],
    quotes: [
      record('quote-1', { 'Quote Date': '2026-08-24', Inquiry: ['inq-1'] }),
      record('quote-2', { 'Quote Date': '2026-08-25', Inquiry: [{ id: 'inq-1' }] }),
      record('quote-3', { 'Quote Date': '2026-08-26', Inquiry: ['inq-1'] }),
    ],
    orders: [],
  });
  assert.equal(result.inquiries_new_cycle_captured, 1);
  assert.equal(result.quoted_cycles, 1);
  assert.equal(result.linked_quoted_cycles, 1);
  assert.equal(result.deduped_quotes, 2);
  assert.equal(result.unlinked_quotes, 0);
  assert.equal(result.measurement_state, 'connected');
});

test('unlinked quotes make quoted cycles unknown rather than inflating customer counts', () => {
  const result = buildPurchaseCycleAggregate({
    from: '2026-08-24',
    to: '2026-08-30',
    inquiries: [],
    quotes: Array.from({ length: 11 }, (_, index) => record(`quote-${index}`, {
      'Quote Date': '2026-08-29',
    })),
    orders: [
      record('paid-order', { 'Pay Date': '2026-08-28', Status: 'Paid' }),
      record('unpaid-order', { 'Pay Date': '2026-08-28', Status: 'Unpaid' }),
    ],
  });
  assert.equal(result.inquiries_new_cycle_captured, 0);
  assert.equal(result.quoted_cycles, null);
  assert.equal(result.linked_quoted_cycles, 0);
  assert.equal(result.unlinked_quotes, 11);
  assert.equal(result.won_cycles, 1);
  assert.equal(result.measurement_state, 'incomplete_linkage');
});

test('records outside the selected HKT date range are excluded', () => {
  const result = buildPurchaseCycleAggregate({
    from: '2026-08-24',
    to: '2026-08-30',
    inquiries: [record('old', { 'Inquiry Date': '2026-08-23' })],
    quotes: [record('future', { 'Quote Date': '2026-08-31', Inquiry: ['inq-future'] })],
    orders: [record('old-paid', { 'Pay Date': '2026-08-23', Status: 'Paid' })],
  });
  assert.equal(result.inquiries_new_cycle_captured, 0);
  assert.equal(result.quoted_cycles, 0);
  assert.equal(result.won_cycles, 0);
});

test('aggregate response contains no customer, token, click-id or record identifiers', () => {
  const result = buildPurchaseCycleAggregate({
    from: '2026-08-24',
    to: '2026-08-30',
    inquiries: [record('secret-inquiry-id', {
      'Inquiry Date': '2026-08-24',
      Phone: '61234567',
      Name: 'Do not return',
    })],
    quotes: [record('secret-quote-id', {
      'Quote Date': '2026-08-24',
      Inquiry: ['secret-inquiry-id'],
      'Public Token': 'secret-token',
      gclid: 'secret-click-id',
    })],
    orders: [],
  });
  const serialized = JSON.stringify(result);
  for (const forbidden of [
    'secret-inquiry-id', 'secret-quote-id', '61234567', 'Do not return',
    'secret-token', 'secret-click-id', 'phone', 'token', 'gclid',
  ]) assert.ok(!serialized.toLowerCase().includes(forbidden.toLowerCase()), `leaked ${forbidden}`);
});

test('date range is strict, ordered and limited to 366 days', () => {
  assert.deepEqual(validateAggregateDateRange('2026-08-24', '2026-08-30'), {
    from: '2026-08-24',
    to: '2026-08-30',
  });
  for (const [from, to] of [
    ['2026-8-24', '2026-08-30'],
    ['2026-08-31', '2026-08-30'],
    ['2025-01-01', '2026-08-30'],
  ]) assert.throws(() => validateAggregateDateRange(from, to), /invalid-date-range/);
});
