import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CUSTOMER_SOURCE_VALUES,
  customerSourceLabel,
  normalizeCustomerSource,
} from './customer-source';

test('customer source accepts exactly five current internal values', () => {
  assert.deepEqual(CUSTOMER_SOURCE_VALUES, [
    '朋友介紹',
    'Facebook',
    'IG',
    '網站搜尋 Google',
    'YouTube',
  ]);
  for (const value of CUSTOMER_SOURCE_VALUES) assert.equal(normalizeCustomerSource(value), value);
  assert.equal(normalizeCustomerSource(''), null);
  assert.equal(normalizeCustomerSource('Other'), null);
});

test('customer source preserves legacy Airtable values while showing clearer labels', () => {
  assert.equal(normalizeCustomerSource('Instagram'), 'IG');
  assert.equal(normalizeCustomerSource('網頁搜尋'), '網站搜尋 Google');
  assert.equal(customerSourceLabel('IG'), 'Instagram');
  assert.equal(customerSourceLabel('網站搜尋 Google'), '網頁搜尋');
  assert.equal(customerSourceLabel('朋友介紹', true), 'Referral');
  assert.equal(customerSourceLabel('網站搜尋 Google', true), 'Web Search');
});

