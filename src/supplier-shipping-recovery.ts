export const SUPPLIER_SHIPPING_RECOVERY_STATES = [
  'prepared',
  'applying_items',
  'items_verified',
  'creating_shipment',
  'shipment_verified',
  'recovery_required',
  'committed',
] as const;

export type SupplierShippingRecoveryState = typeof SUPPLIER_SHIPPING_RECOVERY_STATES[number];

export type SupplierShippingRecoveryReceipt = {
  sourceBatchId: string;
  sourceRevision: number;
  payloadSha256: string;
  state: SupplierShippingRecoveryState;
  itemWritesVerified: boolean;
  shipmentRecordId: string | null;
  shipmentVerified: boolean;
  attemptCount: number;
  lastFailureCode: string | null;
};

export type SupplierShippingRecoveryAction =
  | 'apply_and_verify_item_writes'
  | 'find_or_create_and_verify_shipment'
  | 'mark_committed'
  | 'acknowledge_committed';

export class SupplierShippingRecoveryConflict extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SupplierShippingRecoveryConflict';
  }
}

export const assertSameSupplierShippingPayload = (
  receipt: SupplierShippingRecoveryReceipt,
  expected: Pick<SupplierShippingRecoveryReceipt, 'sourceBatchId' | 'sourceRevision' | 'payloadSha256'>,
): void => {
  if (receipt.sourceBatchId !== expected.sourceBatchId) {
    throw new SupplierShippingRecoveryConflict('source_batch_conflict', 'Source batch ID does not match the receipt.');
  }
  if (receipt.sourceRevision !== expected.sourceRevision || receipt.payloadSha256 !== expected.payloadSha256) {
    throw new SupplierShippingRecoveryConflict('idempotency_conflict', 'Source revision or payload digest changed.');
  }
};

/**
 * Returns the next safe forward-completion action from durable evidence.
 * Airtable writes are never rolled back or deleted automatically. A retry
 * verifies the exact prior write and continues from the first missing stage.
 */
export const nextSupplierShippingRecoveryAction = (
  receipt: SupplierShippingRecoveryReceipt,
): SupplierShippingRecoveryAction => {
  if (receipt.state === 'committed') {
    if (!receipt.itemWritesVerified || !receipt.shipmentRecordId || !receipt.shipmentVerified) {
      throw new SupplierShippingRecoveryConflict('invalid_committed_receipt', 'Committed receipt lacks verified evidence.');
    }
    return 'acknowledge_committed';
  }
  if (!receipt.itemWritesVerified) return 'apply_and_verify_item_writes';
  if (!receipt.shipmentRecordId || !receipt.shipmentVerified) return 'find_or_create_and_verify_shipment';
  return 'mark_committed';
};

export const markSupplierShippingRecoveryFailure = (
  receipt: SupplierShippingRecoveryReceipt,
  failureCode: string,
): SupplierShippingRecoveryReceipt => ({
  ...receipt,
  state: 'recovery_required',
  attemptCount: receipt.attemptCount + 1,
  lastFailureCode: failureCode,
});

export const advanceSupplierShippingRecovery = (
  receipt: SupplierShippingRecoveryReceipt,
  action: SupplierShippingRecoveryAction,
  evidence?: { shipmentRecordId?: string },
): SupplierShippingRecoveryReceipt => {
  switch (action) {
    case 'apply_and_verify_item_writes':
      return {
        ...receipt,
        state: 'items_verified',
        itemWritesVerified: true,
        attemptCount: receipt.attemptCount + 1,
        lastFailureCode: null,
      };
    case 'find_or_create_and_verify_shipment': {
      const shipmentRecordId = String(evidence?.shipmentRecordId || '').trim();
      if (!shipmentRecordId) {
        throw new SupplierShippingRecoveryConflict('missing_shipment_evidence', 'Shipment verification requires a record ID.');
      }
      return {
        ...receipt,
        state: 'shipment_verified',
        shipmentRecordId,
        shipmentVerified: true,
        attemptCount: receipt.attemptCount + 1,
        lastFailureCode: null,
      };
    }
    case 'mark_committed':
      if (!receipt.itemWritesVerified || !receipt.shipmentRecordId || !receipt.shipmentVerified) {
        throw new SupplierShippingRecoveryConflict('incomplete_commit_evidence', 'Cannot commit before all writes are verified.');
      }
      return {
        ...receipt,
        state: 'committed',
        attemptCount: receipt.attemptCount + 1,
        lastFailureCode: null,
      };
    case 'acknowledge_committed':
      if (receipt.state !== 'committed') {
        throw new SupplierShippingRecoveryConflict('not_committed', 'Only committed receipts can be acknowledged.');
      }
      return receipt;
  }
};
