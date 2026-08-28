import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendLinkedRecordId,
  linkedRecordIds,
  selectCanonicalInquiry,
} from './inquiry-attribution';

test('repeat quotes resolve to the earliest inquiry for the same phone', () => {
  const selected = selectCanonicalInquiry([
    { id: 'rec-second', inquiryDate: '2026-08-28', phone: '61234567', customerIds: [] },
    { id: 'rec-first', inquiryDate: '2026-08-01', phone: '61234567', customerIds: [] },
    { id: 'rec-other', inquiryDate: '2026-07-01', phone: '69876543', customerIds: [] },
  ], '61234567');
  assert.equal(selected?.id, 'rec-first');
});

test('linked customer identity reuses first-touch inquiry even when the entered phone format changed', () => {
  const selected = selectCanonicalInquiry([
    { id: 'rec-first-touch', inquiryDate: '2026-03-01', phone: '61234567', customerIds: ['rec-customer'] },
    { id: 'rec-unrelated', inquiryDate: '2026-01-01', phone: '69999999', customerIds: [] },
  ], '61111111', 'rec-customer');
  assert.equal(selected?.id, 'rec-first-touch');
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
