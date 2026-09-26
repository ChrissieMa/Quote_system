import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLegacyCustomerMergeFields,
  extractCustomerId,
  nonBlankCustomerUpdates,
  normalizePhone,
  reconcileCustomerSearchResults,
  selectCanonicalCustomerId,
} from './customer-identity';

test('normalizes phones and extracts an existing legacy customer number from display text', () => {
  assert.equal(normalizePhone('+852 6123 4567'), '61234567');
  assert.equal(extractCustomerId('L795'), 'L0795');
  assert.equal(extractCustomerId('L0795 | legacy customer'), 'L0795');
  assert.equal(selectCanonicalCustomerId('L0795', 'L0999', 'L1000'), 'L0795');
  assert.equal(selectCanonicalCustomerId('', 'L0999', 'L1000'), 'L0999');
  assert.equal(selectCanonicalCustomerId('', '', 'L1000'), 'L1000');
});

test('legacy activation restores the old customer number and fills only missing profile fields', () => {
  const updates = buildLegacyCustomerMergeFields({
    'Customer ID': 'L0999',
    'Customer Name': 'Current Name',
    'Phone': '61234567',
    'Email': '',
    'Address': '',
  }, {
    'Customer ID': 'L0795',
    'Customer Name': 'Legacy Name',
    'Phone': '61234567',
    'Email': 'legacy@example.invalid',
    'Address': 'FICTIONAL ADDRESS',
    'Legacy Customer Ref': 'L0795',
  });

  assert.equal(updates['Customer ID'], 'L0795');
  assert.equal(updates['Address'], 'FICTIONAL ADDRESS');
  assert.equal(updates['Email'], 'legacy@example.invalid');
  assert.equal(updates['Customer Name'], undefined);
  assert.equal(updates['Phone'], undefined);
  assert.equal(updates['Customer Status'], 'Legacy Activated');
});

test('legacy activation never overwrites non-empty current profile data', () => {
  const updates = buildLegacyCustomerMergeFields({
    'Customer ID': 'L0795',
    'Customer Name': 'Current Name',
    'Phone': '61234567',
    'Email': 'current@example.invalid',
    'Address': 'CURRENT FICTIONAL ADDRESS',
  }, {
    'Customer ID': 'L0795',
    'Customer Name': 'Legacy Name',
    'Phone': '69876543',
    'Email': 'legacy@example.invalid',
    'Address': 'LEGACY FICTIONAL ADDRESS',
    'Legacy Customer Ref': 'L0795',
  });

  assert.equal(updates['Customer Name'], undefined);
  assert.equal(updates['Phone'], undefined);
  assert.equal(updates['Email'], undefined);
  assert.equal(updates['Address'], undefined);
});

test('blank submitted values never erase an existing customer address or email', () => {
  assert.deepEqual(nonBlankCustomerUpdates({
    'Customer Name': 'Updated Name',
    'Phone': '61234567',
    'Email': ' ',
    'Address': '',
  }), {
    'Customer Name': 'Updated Name',
    'Phone': '61234567',
  });
});

test('phone-matched official and legacy rows collapse to one legacy activation choice', () => {
  const results = reconcileCustomerSearchResults([{
    source: 'customers',
    id: 'rec-official',
    customerId: 'L0999',
    phone: '6123 4567',
    name: 'Current Name',
    address: '',
  }], [{
    source: 'legacy',
    id: 'rec-legacy',
    customerId: 'L0795',
    phone: '+852 6123 4567',
    name: 'Legacy Name',
    address: 'FICTIONAL ADDRESS',
  }]);

  assert.equal(results.length, 1);
  assert.equal(results[0].source, 'legacy');
  assert.equal(results[0].id, 'rec-legacy');
  assert.equal(results[0].customerId, 'L0795');
  assert.equal(results[0].name, 'Current Name');
  assert.equal(results[0].address, 'FICTIONAL ADDRESS');
});
