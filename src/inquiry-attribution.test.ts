import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendLinkedRecordId,
  firstTouchValue,
  isInquiryCycleActive,
  linkedRecordIds,
  resolveInquiryCycleInactivityDays,
  selectCanonicalInquiry,
  type InquiryAttributionCandidate,
} from './inquiry-attribution';

const activeInquiry = (
  overrides: Partial<InquiryAttributionCandidate> = {},
): InquiryAttributionCandidate => ({
  id: 'rec-cycle',
  inquiryDate: '2026-08-28',
  createdTime: '2026-08-28T09:00:00.000Z',
  lastActivityDate: '2026-08-28',
  phone: '61234567',
  customerIds: [],
  status: 'Quoted',
  orderIds: [],
  ...overrides,
});

test('three same-day quotes reuse one active inquiry and preserve its first touch', () => {
  const selected = selectCanonicalInquiry([
    activeInquiry({ id: 'rec-first', inquiryDate: '2026-08-28', createdTime: '2026-08-28T01:00:00.000Z' }),
    activeInquiry({ id: 'rec-duplicate', inquiryDate: '2026-08-28', createdTime: '2026-08-28T02:00:00.000Z' }),
    activeInquiry({ id: 'rec-other', phone: '69876543' }),
  ], '61234567', '', { asOfDate: '2026-08-28' });
  assert.equal(selected?.id, 'rec-first');
  assert.equal(firstTouchValue('Google Ads', 'Instagram'), 'Google Ads');
});

test('linked customer identity reuses the active cycle even when the entered phone changed', () => {
  const selected = selectCanonicalInquiry([
    activeInquiry({ id: 'rec-first-touch', customerIds: ['rec-customer'] }),
    activeInquiry({ id: 'rec-unrelated', phone: '69999999' }),
  ], '61111111', 'rec-customer', { asOfDate: '2026-08-28' });
  assert.equal(selected?.id, 'rec-first-touch');
});

test('a completed purchase two months ago starts a new inquiry and source cycle today', () => {
  const selected = selectCanonicalInquiry([
    activeInquiry({
      id: 'rec-old-purchase',
      inquiryDate: '2026-06-20',
      lastActivityDate: '2026-06-28',
      status: 'Converted',
      orderIds: ['rec-order-old'],
    }),
  ], '61234567', '', { asOfDate: '2026-08-28' });
  assert.equal(selected, null);
});

test('a confirmed order closes the cycle even when the phone and date still match', () => {
  const selected = selectCanonicalInquiry([
    activeInquiry({ orderIds: ['rec-order-today'] }),
  ], '61234567', '', { asOfDate: '2026-08-28' });
  assert.equal(selected, null);
});

test('an active cycle is reused instead of creating a duplicate inquiry', () => {
  const selected = selectCanonicalInquiry([
    activeInquiry({ inquiryDate: '2026-08-10', lastActivityDate: '2026-08-27' }),
  ], '61234567', '', { asOfDate: '2026-08-28' });
  assert.equal(selected?.id, 'rec-cycle');
});

test('the 30-day inactivity boundary is inclusive and day 31 starts a new cycle', () => {
  const candidate = activeInquiry({ inquiryDate: '2026-07-01', lastActivityDate: '2026-07-29' });
  assert.equal(isInquiryCycleActive(candidate, '2026-08-28', 30), true);
  assert.equal(isInquiryCycleActive(candidate, '2026-08-29', 30), false);
  assert.equal(
    selectCanonicalInquiry([candidate], '61234567', '', {
      asOfDate: '2026-08-29',
      inactivityDays: 30,
    }),
    null,
  );
});

test('inactivity window is configurable and defaults safely to 30 days', () => {
  assert.equal(resolveInquiryCycleInactivityDays(undefined), 30);
  assert.equal(resolveInquiryCycleInactivityDays('45'), 45);
  assert.equal(resolveInquiryCycleInactivityDays('0'), 30);
  assert.equal(resolveInquiryCycleInactivityDays('not-a-number'), 30);
});

test('a new cycle with missing source remains unknown and never borrows a closed source', () => {
  const oldCycle = activeInquiry({
    status: 'Converted',
    orderIds: ['rec-order-old'],
  });
  const selected = selectCanonicalInquiry([oldCycle], '61234567', '', { asOfDate: '2026-08-28' });
  assert.equal(selected, null);
  assert.equal(firstTouchValue(selected ? 'Google Ads' : '', ''), '');
});

test('quote links are appended without replacing or duplicating earlier quotes', () => {
  assert.deepEqual(linkedRecordIds(['rec-quote-1', { id: 'rec-quote-2' }]), ['rec-quote-1', 'rec-quote-2']);
  assert.deepEqual(
    appendLinkedRecordId(['rec-quote-1', 'rec-quote-2'], 'rec-quote-2'),
    ['rec-quote-1', 'rec-quote-2'],
  );
  assert.deepEqual(
    appendLinkedRecordId(['rec-quote-1'], 'rec-quote-3'),
    ['rec-quote-1', 'rec-quote-3'],
  );
});
