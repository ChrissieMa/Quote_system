import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SupplierShippingRecoveryConflict,
  advanceSupplierShippingRecovery,
  assertSameSupplierShippingPayload,
  markSupplierShippingRecoveryFailure,
  nextSupplierShippingRecoveryAction,
  type SupplierShippingRecoveryReceipt,
} from './supplier-shipping-recovery';

const prepared = (): SupplierShippingRecoveryReceipt => ({
  sourceBatchId: 'SPCN-SYNTHETIC-RECOVERY-001',
  sourceRevision: 1,
  payloadSha256: 'a'.repeat(64),
  state: 'prepared',
  itemWritesVerified: false,
  shipmentRecordId: null,
  shipmentVerified: false,
  attemptCount: 0,
  lastFailureCode: null,
});

test('forward completion follows existing Item writes, Shipment create and final acknowledgement', () => {
  let receipt = prepared();
  assert.equal(nextSupplierShippingRecoveryAction(receipt), 'apply_and_verify_item_writes');
  receipt = advanceSupplierShippingRecovery(receipt, 'apply_and_verify_item_writes');
  assert.equal(nextSupplierShippingRecoveryAction(receipt), 'find_or_create_and_verify_shipment');
  receipt = advanceSupplierShippingRecovery(receipt, 'find_or_create_and_verify_shipment', {
    shipmentRecordId: 'recSyntheticShipment',
  });
  assert.equal(nextSupplierShippingRecoveryAction(receipt), 'mark_committed');
  receipt = advanceSupplierShippingRecovery(receipt, 'mark_committed');
  assert.equal(nextSupplierShippingRecoveryAction(receipt), 'acknowledge_committed');
  assert.equal(receipt.state, 'committed');
  assert.equal(receipt.attemptCount, 3);
});

test('failure after Item writes resumes at Shipment without duplicating the Item stage', () => {
  let receipt = advanceSupplierShippingRecovery(prepared(), 'apply_and_verify_item_writes');
  receipt = markSupplierShippingRecoveryFailure(receipt, 'synthetic_shipment_timeout');
  assert.equal(receipt.state, 'recovery_required');
  assert.equal(receipt.itemWritesVerified, true);
  assert.equal(nextSupplierShippingRecoveryAction(receipt), 'find_or_create_and_verify_shipment');
});

test('lost response after Shipment create can attach verified existing Shipment and finish once', () => {
  let receipt = advanceSupplierShippingRecovery(prepared(), 'apply_and_verify_item_writes');
  receipt = markSupplierShippingRecoveryFailure(receipt, 'synthetic_response_lost');
  receipt = advanceSupplierShippingRecovery(receipt, 'find_or_create_and_verify_shipment', {
    shipmentRecordId: 'recExistingSyntheticShipment',
  });
  receipt = advanceSupplierShippingRecovery(receipt, 'mark_committed');
  const replay = advanceSupplierShippingRecovery(receipt, 'acknowledge_committed');
  assert.deepEqual(replay, receipt);
});

test('changed revision or digest never resumes an existing receipt', () => {
  const receipt = prepared();
  assert.throws(() => assertSameSupplierShippingPayload(receipt, {
    sourceBatchId: receipt.sourceBatchId,
    sourceRevision: 1,
    payloadSha256: 'b'.repeat(64),
  }), (error: unknown) => error instanceof SupplierShippingRecoveryConflict && error.code === 'idempotency_conflict');
});

test('committed status requires verified Item and Shipment evidence', () => {
  const invalid = { ...prepared(), state: 'committed' as const };
  assert.throws(() => nextSupplierShippingRecoveryAction(invalid), (error: unknown) =>
    error instanceof SupplierShippingRecoveryConflict && error.code === 'invalid_committed_receipt');
});
