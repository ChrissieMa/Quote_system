import crypto from 'crypto';
import type { FieldSet } from 'airtable';
import { buildChinaShipmentWritePlan } from './china-shipment-input';
import {
  SupplierShippingContractError,
  SupplierShippingRetryableError,
  stableSupplierShippingJson,
  supplierBatchToChinaShipmentInput,
  type SupplierShippingAdapter,
  type SupplierShippingAttempt,
  type SupplierShippingItem,
  type SupplierShippingReceipt,
  type SupplierShippingTarget,
  type ValidatedSupplierShippingBatch,
} from './supplier-shipping-receiver';

type AirtableRecordLike = { id: string; fields: FieldSet };
type AirtableTableLike = {
  find(id: string): Promise<AirtableRecordLike>;
  select(options?: Record<string, unknown>): { firstPage(): Promise<AirtableRecordLike[]> };
  create(records: Array<{ fields: FieldSet }>): Promise<AirtableRecordLike[]>;
  update(records: Array<{ id: string; fields: FieldSet }>): Promise<AirtableRecordLike[]>;
};

export type SupplierShippingAirtableTables = {
  orderItems: AirtableTableLike;
  chinaShipments: AirtableTableLike;
  receipts: AirtableTableLike;
};

const RECEIPT_FIELDS = {
  batch: 'Source Batch ID',
  revision: 'Source Revision',
  hash: 'Payload SHA256',
  version: 'Source Version',
  state: 'State',
  recovery: 'Recovery State',
  attempts: 'Attempts JSON',
  payload: 'Original Payload JSON',
  shipment: 'Shipment Record ID',
  itemsVerified: 'Item Writes Verified',
  shipmentVerified: 'Shipment Verified',
  lastFailure: 'Last Failure Code',
  updatedAt: 'Updated At',
  committedAt: 'Committed At',
} as const;

const SHIPMENT_SOURCE_FIELDS = {
  batch: 'Supplier Source Batch ID',
  revision: 'Supplier Source Revision',
  hash: 'Supplier Payload SHA256',
  version: 'Supplier Source Version',
} as const;

const formulaLiteral = (value: string): string => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

const asStringArray = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string')
  : [];

const parseAttempts = (value: unknown): SupplierShippingAttempt[] => {
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const parsePayload = (value: unknown): ValidatedSupplierShippingBatch['batch'] => {
  if (typeof value !== 'string' || !value) {
    throw new SupplierShippingRetryableError('receipt_payload_missing', 'Receipt payload evidence is missing.');
  }
  try {
    return JSON.parse(value) as ValidatedSupplierShippingBatch['batch'];
  } catch {
    throw new SupplierShippingRetryableError('receipt_payload_invalid', 'Receipt payload evidence is invalid.');
  }
};

const toReceipt = (record: AirtableRecordLike): SupplierShippingReceipt => {
  const fields = record.fields;
  const state = String(fields[RECEIPT_FIELDS.state] || 'retryable_failure') === 'committed'
    ? 'committed' as const
    : 'retryable_failure' as const;
  return {
    sourceBatchId: String(fields[RECEIPT_FIELDS.batch] || ''),
    sourceRevision: Number(fields[RECEIPT_FIELDS.revision] || 0),
    payloadSha256: String(fields[RECEIPT_FIELDS.hash] || ''),
    state,
    originalPayload: parsePayload(fields[RECEIPT_FIELDS.payload]),
    attempts: parseAttempts(fields[RECEIPT_FIELDS.attempts]),
    shipmentRecordId: String(fields[RECEIPT_FIELDS.shipment] || '') || null,
  };
};

const attempt = (
  input: ValidatedSupplierShippingBatch,
  state: SupplierShippingAttempt['state'],
  code: string | null,
  recordedAt: string,
): SupplierShippingAttempt => ({
  attemptId: crypto.randomUUID(),
  sourceRevision: input.batch.sourceRevision,
  payloadSha256: input.payloadSha256,
  state,
  code,
  recordedAt,
});

const receiptBaseFields = (input: ValidatedSupplierShippingBatch, recordedAt: string): FieldSet => ({
  [RECEIPT_FIELDS.batch]: input.batch.sourceBatchId,
  [RECEIPT_FIELDS.revision]: input.batch.sourceRevision,
  [RECEIPT_FIELDS.hash]: input.payloadSha256,
  [RECEIPT_FIELDS.version]: input.batch.sourceVersion,
  [RECEIPT_FIELDS.payload]: stableSupplierShippingJson(input.batch),
  [RECEIPT_FIELDS.updatedAt]: recordedAt,
});

const sameSet = (left: string[], right: string[]): boolean =>
  left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);

export class AirtableSupplierShippingAdapter implements SupplierShippingAdapter {
  constructor(
    private readonly tables: SupplierShippingAirtableTables,
    private readonly afterVerifiedCommit: (orderItemIds: string[]) => Promise<void> = async () => undefined,
  ) {}

  private async receiptRecord(sourceBatchId: string): Promise<AirtableRecordLike | null> {
    const records = await this.tables.receipts.select({
      filterByFormula: `{${RECEIPT_FIELDS.batch}} = '${formulaLiteral(sourceBatchId)}'`,
      maxRecords: 2,
    }).firstPage();
    if (records.length > 1) {
      throw new SupplierShippingRetryableError('duplicate_receipt_records', 'More than one receipt exists for the source batch.');
    }
    return records[0] || null;
  }

  async getReceipt(sourceBatchId: string): Promise<SupplierShippingReceipt | null> {
    const record = await this.receiptRecord(sourceBatchId);
    return record ? toReceipt(record) : null;
  }

  async findShipmentByNumber(shipmentNo: string) {
    const records = await this.tables.chinaShipments.select({
      filterByFormula: `{Shipment No.} = '${formulaLiteral(shipmentNo)}'`,
      maxRecords: 2,
    }).firstPage();
    if (records.length > 1) {
      throw new SupplierShippingRetryableError('duplicate_shipment_numbers', 'Duplicate Shipment No. records require review.');
    }
    const record = records[0];
    return record ? {
      shipmentRecordId: record.id,
      sourceBatchId: String(record.fields[SHIPMENT_SOURCE_FIELDS.batch] || '') || null,
    } : null;
  }

  private async shipmentSourceBatchIds(ids: string[]): Promise<Array<string | null>> {
    return Promise.all(ids.map(async id => {
      try {
        const record = await this.tables.chinaShipments.find(id);
        return String(record.fields[SHIPMENT_SOURCE_FIELDS.batch] || '') || null;
      } catch {
        return null;
      }
    }));
  }

  async resolveTargets(items: SupplierShippingItem[]): Promise<SupplierShippingTarget[]> {
    return Promise.all(items.map(async item => {
      try {
        const record = await this.tables.orderItems.find(item.orderItemRecordId);
        const linkedChinaShipmentIds = asStringArray(record.fields['China Shipments']);
        return {
          sourceItemId: item.sourceItemId,
          orderItemRecordId: item.orderItemRecordId,
          status: 'matched' as const,
          linkedChinaShipmentIds,
          linkedChinaShipmentSourceBatchIds: await this.shipmentSourceBatchIds(linkedChinaShipmentIds),
        };
      } catch {
        return {
          sourceItemId: item.sourceItemId,
          orderItemRecordId: item.orderItemRecordId,
          status: 'missing' as const,
          linkedChinaShipmentIds: [],
          linkedChinaShipmentSourceBatchIds: [],
        };
      }
    }));
  }

  async recordRetryableFailure(
    input: ValidatedSupplierShippingBatch,
    code: string,
    recordedAt: string,
  ): Promise<SupplierShippingReceipt> {
    const existingRecord = await this.receiptRecord(input.batch.sourceBatchId);
    if (existingRecord) {
      const existing = toReceipt(existingRecord);
      if (existing.state === 'committed') return existing;
      const attempts = [...existing.attempts, attempt(input, 'retryable_failure', code, recordedAt)];
      const [updated] = await this.tables.receipts.update([{
        id: existingRecord.id,
        fields: {
          ...receiptBaseFields(input, recordedAt),
          [RECEIPT_FIELDS.state]: 'retryable_failure',
          [RECEIPT_FIELDS.recovery]: 'recovery_required',
          [RECEIPT_FIELDS.attempts]: stableSupplierShippingJson(attempts),
          [RECEIPT_FIELDS.lastFailure]: code,
        },
      }]);
      return toReceipt(updated);
    }
    const attempts = [attempt(input, 'retryable_failure', code, recordedAt)];
    const [created] = await this.tables.receipts.create([{
      fields: {
        ...receiptBaseFields(input, recordedAt),
        [RECEIPT_FIELDS.state]: 'retryable_failure',
        [RECEIPT_FIELDS.recovery]: 'recovery_required',
        [RECEIPT_FIELDS.attempts]: stableSupplierShippingJson(attempts),
        [RECEIPT_FIELDS.lastFailure]: code,
        [RECEIPT_FIELDS.itemsVerified]: false,
        [RECEIPT_FIELDS.shipmentVerified]: false,
      },
    }]);
    return toReceipt(created);
  }

  private async writeReceiptPhase(
    record: AirtableRecordLike,
    input: ValidatedSupplierShippingBatch,
    phase: string,
    recordedAt: string,
    fields: FieldSet = {},
  ): Promise<AirtableRecordLike> {
    const [updated] = await this.tables.receipts.update([{
      id: record.id,
      fields: {
        ...receiptBaseFields(input, recordedAt),
        [RECEIPT_FIELDS.recovery]: phase,
        ...fields,
      },
    }]);
    return updated;
  }

  private async sourceShipment(sourceBatchId: string): Promise<AirtableRecordLike | null> {
    const records = await this.tables.chinaShipments.select({
      filterByFormula: `{${SHIPMENT_SOURCE_FIELDS.batch}} = '${formulaLiteral(sourceBatchId)}'`,
      maxRecords: 2,
    }).firstPage();
    if (records.length > 1) {
      throw new SupplierShippingContractError('duplicate_source_batch', 'Source batch already has multiple China Shipments.');
    }
    return records[0] || null;
  }

  private verifyShipment(record: AirtableRecordLike, input: ValidatedSupplierShippingBatch, expectedItemIds: string[]): void {
    const fields = record.fields;
    const checks = [
      String(fields[SHIPMENT_SOURCE_FIELDS.batch] || '') === input.batch.sourceBatchId,
      Number(fields[SHIPMENT_SOURCE_FIELDS.revision]) === input.batch.sourceRevision,
      String(fields[SHIPMENT_SOURCE_FIELDS.hash] || '') === input.payloadSha256,
      String(fields[SHIPMENT_SOURCE_FIELDS.version] || '') === input.batch.sourceVersion,
      String(fields['Shipment Date'] || '') === input.batch.shipment.shipmentDate,
      Number(fields['SF Freight RMB']) === Number(input.batch.shipment.sfFreightRmb),
      sameSet(asStringArray(fields['Order Items']), expectedItemIds),
    ];
    if (input.batch.shipment.shipmentNo) checks.push(String(fields['Shipment No.'] || '') === input.batch.shipment.shipmentNo);
    if (input.batch.shipment.sfActualWeightKg !== null) {
      checks.push(Number(fields['SF Actual Weight KG']) === Number(input.batch.shipment.sfActualWeightKg));
    }
    if (input.batch.shipment.sfChargeableWeightKg !== null) {
      checks.push(Number(fields['SF Chargeable Weight KG']) === Number(input.batch.shipment.sfChargeableWeightKg));
    }
    if (checks.some(check => !check)) {
      throw new SupplierShippingRetryableError('shipment_verification_failed', 'China Shipment verification failed.');
    }
  }

  async commitAtomically(
    input: ValidatedSupplierShippingBatch,
    targets: SupplierShippingTarget[],
    recordedAt: string,
  ): Promise<SupplierShippingReceipt> {
    try {
      let receiptRecord = await this.receiptRecord(input.batch.sourceBatchId);
      if (!receiptRecord) {
        const [created] = await this.tables.receipts.create([{
          fields: {
            ...receiptBaseFields(input, recordedAt),
            [RECEIPT_FIELDS.state]: 'retryable_failure',
            [RECEIPT_FIELDS.recovery]: 'prepared',
            [RECEIPT_FIELDS.attempts]: '[]',
            [RECEIPT_FIELDS.itemsVerified]: false,
            [RECEIPT_FIELDS.shipmentVerified]: false,
          },
        }]);
        receiptRecord = created;
      }
      const receipt = toReceipt(receiptRecord);
      if (receipt.sourceRevision !== input.batch.sourceRevision || receipt.payloadSha256 !== input.payloadSha256) {
        throw new SupplierShippingContractError('idempotency_conflict', 'Receipt belongs to a different payload.');
      }
      if (receipt.state === 'committed') return receipt;

      const plan = buildChinaShipmentWritePlan(
        supplierBatchToChinaShipmentInput(input, targets),
        date => `SF-${date.replace(/-/g, '')}-${input.batch.sourceBatchId.slice(-8)}`,
      );
      receiptRecord = await this.writeReceiptPhase(receiptRecord, input, 'applying_items', recordedAt);
      const itemWrites = plan.itemUpdates.map(update => ({ id: update.id, fields: update.fields as unknown as FieldSet }));
      for (let index = 0; index < itemWrites.length; index += 10) {
        await this.tables.orderItems.update(itemWrites.slice(index, index + 10));
      }
      for (const expected of plan.itemUpdates) {
        const actual = await this.tables.orderItems.find(expected.id);
        const fields = actual.fields;
        if (
          Number(fields['China Freight Piece Count']) !== expected.fields['China Freight Piece Count']
          || String(fields['China Freight Piece Weights KG'] || '') !== expected.fields['China Freight Piece Weights KG']
          || Number(fields['China Freight Weight Input KG']) !== expected.fields['China Freight Weight Input KG']
        ) {
          throw new SupplierShippingRetryableError('item_verification_failed', 'Order Item write verification failed.');
        }
      }
      receiptRecord = await this.writeReceiptPhase(receiptRecord, input, 'items_verified', recordedAt, {
        [RECEIPT_FIELDS.itemsVerified]: true,
      });

      let shipment = await this.sourceShipment(input.batch.sourceBatchId);
      if (!shipment) {
        const shipmentFields: FieldSet = {
          ...(plan.shipmentFields as unknown as FieldSet),
          [SHIPMENT_SOURCE_FIELDS.batch]: input.batch.sourceBatchId,
          [SHIPMENT_SOURCE_FIELDS.revision]: input.batch.sourceRevision,
          [SHIPMENT_SOURCE_FIELDS.hash]: input.payloadSha256,
          [SHIPMENT_SOURCE_FIELDS.version]: input.batch.sourceVersion,
        };
        receiptRecord = await this.writeReceiptPhase(receiptRecord, input, 'creating_shipment', recordedAt);
        [shipment] = await this.tables.chinaShipments.create([{ fields: shipmentFields }]);
      }
      this.verifyShipment(shipment, input, plan.shipmentFields['Order Items']);
      receiptRecord = await this.writeReceiptPhase(receiptRecord, input, 'shipment_verified', recordedAt, {
        [RECEIPT_FIELDS.shipment]: shipment.id,
        [RECEIPT_FIELDS.shipmentVerified]: true,
      });

      await this.afterVerifiedCommit(plan.shipmentFields['Order Items']);
      const prior = toReceipt(receiptRecord);
      const attempts = [...prior.attempts, attempt(input, 'committed', null, recordedAt)];
      receiptRecord = await this.writeReceiptPhase(receiptRecord, input, 'committed', recordedAt, {
        [RECEIPT_FIELDS.state]: 'committed',
        [RECEIPT_FIELDS.attempts]: stableSupplierShippingJson(attempts),
        [RECEIPT_FIELDS.lastFailure]: '',
        [RECEIPT_FIELDS.committedAt]: recordedAt,
      });
      return toReceipt(receiptRecord);
    } catch (error) {
      if (error instanceof SupplierShippingContractError || error instanceof SupplierShippingRetryableError) throw error;
      throw new SupplierShippingRetryableError('airtable_write_failed', 'Airtable write or verification failed.');
    }
  }
}

export const SUPPLIER_SHIPPING_RECEIPT_FIELD_NAMES = RECEIPT_FIELDS;
export const SUPPLIER_SHIPPING_SHIPMENT_FIELD_NAMES = SHIPMENT_SOURCE_FIELDS;
