import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeQuoteDeletion,
  issueDeleteConfirmation,
  maintenanceSnapshotFingerprint,
  requiredDeleteConfirmation,
  verifyDeleteConfirmation,
  type QuoteDeletionSnapshot,
} from './production-maintenance';

const snapshot = (overrides: Partial<QuoteDeletionSnapshot> = {}): QuoteDeletionSnapshot => ({
  capturedAt: '2026-07-30T09:00:00.000Z',
  quote: {
    tableId: 'tblQuotes',
    tableName: 'Quotes',
    id: 'recQuote175',
    fields: {
      'Quote Number': 'QT-2026-0175',
      Status: 'Draft',
      Total: 1649,
      Customer: ['recCustomer'],
    },
  },
  schema: [],
  convertedMarkers: {
    'Converted Order No': '',
    'Converted Invoice No': '',
    'Order Ref': [],
    'Invoice Public Token': '',
    'Converted At': '',
  },
  dependencies: {
    orders: [],
    orderItems: [],
    receipts: [],
    deliveries: [],
    other: [],
  },
  protectedNotDeleted: [{
    tableId: 'tblCustomers',
    tableName: 'Customers',
    id: 'recCustomer',
    fields: { 'Customer Name': 'Mr/Miss' },
  }],
  ...overrides,
});

test('Draft quote without downstream dependencies is eligible for one-record deletion', () => {
  const result = analyzeQuoteDeletion(snapshot());
  assert.equal(result.canDelete, true);
  assert.deepEqual(result.dependencyCounts, {
    orders: 0,
    orderItems: 0,
    receipts: 0,
    deliveries: 0,
    other: 0,
  });
  assert.equal(result.productionWriteCountOnConfirm, 1);
  assert.match(result.willNotDelete.join(' '), /Customer/);
});

test('converted markers or any dependency fail closed', () => {
  const converted = snapshot({ convertedMarkers: { 'Converted Order No': 'ORD-1' } });
  assert.equal(analyzeQuoteDeletion(converted).canDelete, false);
  const delivery = snapshot({
    dependencies: {
      orders: [],
      orderItems: [],
      receipts: [],
      deliveries: [{
        tableId: 'tblDelivery',
        tableName: 'Deliveries',
        id: 'recDelivery',
        fields: {},
      }],
      other: [],
    },
  });
  assert.equal(analyzeQuoteDeletion(delivery).canDelete, false);
});

test('delete confirmation locks exact snapshot, target and expiry', () => {
  const secret = 'test-secret-at-least-32-characters';
  const original = snapshot();
  const token = issueDeleteConfirmation(original, secret, 1_000, 'fixed-nonce');
  const verified = verifyDeleteConfirmation(token, secret, 2_000);
  assert.equal(verified.quoteNo, 'QT-2026-0175');
  assert.equal(verified.recordId, 'recQuote175');
  assert.equal(verified.snapshotFingerprint, maintenanceSnapshotFingerprint(original));
  assert.equal(requiredDeleteConfirmation(verified.quoteNo), '確認刪除 QT-2026-0175');
  assert.throws(() => verifyDeleteConfirmation(token, secret, 1_000 + (31 * 60 * 1000)), /expired/);
  assert.throws(() => verifyDeleteConfirmation(`${token}x`, secret, 2_000), /Invalid/);
});
