import crypto from 'crypto';
import type { ChinaShipmentInput } from './china-shipment-input';

export const SUPPLIER_SHIPPING_CONTRACT = 'lks.supplier-shipping.v1' as const;

export const supplierShippingItemNoLookupKeys = (value: unknown): string[] => {
  const compact = String(value || '').normalize('NFKC').trim().toUpperCase().replace(/\s+/gu, '');
  if (!compact) return [];
  const keys = [compact];
  if (/^[A-Z]{3}\d{4}$/.test(compact)) keys.push(`${compact}-A`);
  if (/^[A-Z]{3}\d{4}[A-Z]$/.test(compact)) {
    keys.push(`${compact.slice(0, -1)}-${compact.slice(-1)}`);
  }
  return [...new Set(keys)];
};

type JsonObject = Record<string, unknown>;

export type SupplierParcelChange = {
  sequence: number;
  sourceParcelId: string;
  beforeWeightKg: string | null;
  afterWeightKg: string | null;
  voided: boolean;
  reason: string;
  changedAt: string;
};

export type SupplierShippingItem = {
  sourceItemId: string;
  orderItemRecordId: string;
  activeParcels: Array<{
    sourceParcelId: string;
    weightKg: string;
  }>;
  parcelChanges: SupplierParcelChange[];
};

export type SupplierShippingBatch = {
  contract: typeof SUPPLIER_SHIPPING_CONTRACT;
  sourceSystem: 'LKS_Supplier_Portal';
  sourceVersion: string;
  sourceBatchId: string;
  sourceRevision: number;
  previousPayloadSha256: string | null;
  correctionReason: string | null;
  createdAt: string;
  shipment: {
    shipmentNo: string | null;
    shipmentDate: string;
    sfFreightRmb: string;
    sfActualWeightKg: string | null;
    sfChargeableWeightKg: string | null;
  };
  items: SupplierShippingItem[];
};

export type SupplierShippingAllocationItem = {
  sourceItemId: string;
  orderItemRecordId: string;
  pieceCount: number;
  pieceWeightsKg: string[];
  totalWeightKg: string;
};

export type ValidatedSupplierShippingBatch = {
  batch: SupplierShippingBatch;
  payloadSha256: string;
  totalPieceCount: number;
  totalItemWeightKg: string;
  allocationItems: SupplierShippingAllocationItem[];
};

export type SupplierShippingTarget = {
  sourceItemId: string;
  orderItemRecordId: string;
  status: 'matched' | 'missing' | 'ambiguous';
  linkedChinaShipmentIds: string[];
  linkedChinaShipmentSourceBatchIds?: Array<string | null>;
};

export type SupplierShippingAttempt = {
  attemptId: string;
  sourceRevision: number;
  payloadSha256: string;
  state: 'retryable_failure' | 'committed';
  code: string | null;
  recordedAt: string;
};

export type SupplierShippingReceipt = {
  sourceBatchId: string;
  sourceRevision: number;
  payloadSha256: string;
  state: 'retryable_failure' | 'committed';
  originalPayload: SupplierShippingBatch;
  attempts: SupplierShippingAttempt[];
  shipmentRecordId: string | null;
};

export type SupplierShippingOutcome = {
  status: 'committed' | 'already_committed' | 'retryable_failure' | 'rejected';
  code: string;
  sourceBatchId: string;
  sourceRevision: number;
  payloadSha256: string;
  shipmentRecordId?: string;
  retrySafe: boolean;
};

export interface SupplierShippingAdapter {
  getReceipt(sourceBatchId: string): Promise<SupplierShippingReceipt | null>;
  findShipmentByNumber(shipmentNo: string): Promise<{ shipmentRecordId: string; sourceBatchId: string | null } | null>;
  resolveTargets(items: SupplierShippingItem[]): Promise<SupplierShippingTarget[]>;
  recordRetryableFailure(
    input: ValidatedSupplierShippingBatch,
    code: string,
    recordedAt: string,
  ): Promise<SupplierShippingReceipt>;
  commitAtomically(
    input: ValidatedSupplierShippingBatch,
    targets: SupplierShippingTarget[],
    recordedAt: string,
  ): Promise<SupplierShippingReceipt>;
}

export const supplierBatchToChinaShipmentInput = (
  input: ValidatedSupplierShippingBatch,
  targets: SupplierShippingTarget[],
): ChinaShipmentInput => {
  const targetsByKey = new Map(targets.map(target => [
    `${target.sourceItemId}:${target.orderItemRecordId}`,
    target,
  ]));
  return {
    shipmentNo: input.batch.shipment.shipmentNo,
    shipmentDate: input.batch.shipment.shipmentDate,
    sfFreightRmb: input.batch.shipment.sfFreightRmb,
    sfActualWeightKg: input.batch.shipment.sfActualWeightKg,
    sfChargeableWeightKg: input.batch.shipment.sfChargeableWeightKg,
    items: input.allocationItems.map(item => {
      const target = targetsByKey.get(`${item.sourceItemId}:${item.orderItemRecordId}`);
      if (!target || target.status !== 'matched') {
        throw new SupplierShippingContractError('unmapped_order_item', 'Order Item mapping is incomplete.');
      }
      const sameBatchRecovery = target.linkedChinaShipmentIds.length > 0
        && target.linkedChinaShipmentSourceBatchIds?.length === target.linkedChinaShipmentIds.length
        && target.linkedChinaShipmentSourceBatchIds.every(sourceBatchId => sourceBatchId === input.batch.sourceBatchId);
      return {
        orderItemRecordId: item.orderItemRecordId,
        itemLabel: item.orderItemRecordId,
        linkedChinaShipmentIds: sameBatchRecovery ? [] : [...target.linkedChinaShipmentIds],
        pieceWeightsKg: [...item.pieceWeightsKg],
      };
    }),
  };
};

export class SupplierShippingContractError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SupplierShippingContractError';
  }
}

export class SupplierShippingRetryableError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SupplierShippingRetryableError';
  }
}

export const stableSupplierShippingJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableSupplierShippingJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as JsonObject)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSupplierShippingJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

export const supplierShippingJsonSha256 = (value: unknown): string =>
  crypto.createHash('sha256').update(stableSupplierShippingJson(value)).digest('hex');

const fail = (code: string, message: string): never => {
  throw new SupplierShippingContractError(code, message);
};

const objectWithKeys = (value: unknown, keys: string[], label: string): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail('invalid_contract', `${label} must be an object.`);
  }
  const object = value as JsonObject;
  const extras = Object.keys(object).filter(key => !keys.includes(key));
  if (extras.length) return fail('unexpected_field', `${label} contains unsupported fields.`);
  return object;
};

const requiredText = (value: unknown, label: string, max: number, pattern?: RegExp): string => {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max) {
    return fail('invalid_contract', `${label} is invalid.`);
  }
  if (/\p{Cc}/u.test(value) || (pattern && !pattern.test(value))) {
    return fail('invalid_contract', `${label} is invalid.`);
  }
  return value;
};

const optionalText = (value: unknown, label: string, max: number): string | null => {
  if (value === null) return null;
  return requiredText(value, label, max);
};

const isoTimestamp = (value: unknown, label: string): string => {
  const text = requiredText(value, label, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    return fail('invalid_contract', `${label} must include a timezone.`);
  }
  if (!Number.isFinite(Date.parse(text))) return fail('invalid_contract', `${label} is invalid.`);
  return text;
};

const isoDate = (value: unknown, label: string): string => {
  const text = requiredText(value, label, 10, /^\d{4}-\d{2}-\d{2}$/);
  const [year, month, day] = text.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) return fail('invalid_contract', `${label} is invalid.`);
  return text;
};

type DecimalValue = { raw: string; units: bigint };

const decimalUnits = (value: string, places: number): bigint => {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * (10n ** BigInt(places)) + BigInt(fraction.padEnd(places, '0'));
};

const decimal = (
  value: unknown,
  label: string,
  places: number,
  options: { zero?: boolean; maximum: string },
): DecimalValue => {
  if (typeof value !== 'string' || !new RegExp(`^(?:0|[1-9]\\d*)(?:\\.\\d{1,${places}})?$`).test(value)) {
    return fail('invalid_contract', `${label} has invalid precision.`);
  }
  const units = decimalUnits(value, places);
  const maximum = decimalUnits(options.maximum, places);
  if ((!options.zero && units === 0n) || units > maximum) {
    return fail('invalid_contract', `${label} is outside the accepted range.`);
  }
  return { raw: value, units };
};

const fixedUnits = (units: bigint, places: number): string => {
  const divisor = 10n ** BigInt(places);
  const whole = units / divisor;
  const fraction = String(units % divisor).padStart(places, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
};

const integer = (value: unknown, label: string, minimum: number, maximum: number): number => {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    return fail('invalid_contract', `${label} is invalid.`);
  }
  return Number(value);
};

const nullableSha256 = (value: unknown): string | null => {
  if (value === null) return null;
  return requiredText(value, 'previousPayloadSha256', 64, /^[a-f0-9]{64}$/);
};

export const validateSupplierShippingBatch = (raw: unknown): ValidatedSupplierShippingBatch => {
  const top = objectWithKeys(raw, [
    'contract', 'sourceSystem', 'sourceVersion', 'sourceBatchId', 'sourceRevision',
    'previousPayloadSha256', 'correctionReason', 'createdAt', 'shipment', 'items',
  ], 'payload');
  if (top.contract !== SUPPLIER_SHIPPING_CONTRACT || top.sourceSystem !== 'LKS_Supplier_Portal') {
    return fail('unsupported_contract', 'Supplier shipping contract is unsupported.');
  }
  const sourceVersion = requiredText(top.sourceVersion, 'sourceVersion', 80, /^SP-[A-Z0-9.-]+$/);
  const sourceBatchId = requiredText(top.sourceBatchId, 'sourceBatchId', 96, /^SPCN-[A-Z0-9-]{8,80}$/);
  const sourceRevision = integer(top.sourceRevision, 'sourceRevision', 1, 1_000_000);
  const previousPayloadSha256 = nullableSha256(top.previousPayloadSha256);
  const correctionReason = optionalText(top.correctionReason, 'correctionReason', 300);
  if (sourceRevision === 1 && (previousPayloadSha256 !== null || correctionReason !== null)) {
    return fail('invalid_correction_chain', 'The first revision cannot supersede another payload.');
  }
  if (sourceRevision > 1 && (!previousPayloadSha256 || !correctionReason)) {
    return fail('invalid_correction_chain', 'A later revision requires the prior digest and a correction reason.');
  }

  const shipmentRaw = objectWithKeys(top.shipment, [
    'shipmentNo', 'shipmentDate', 'sfFreightRmb', 'sfActualWeightKg', 'sfChargeableWeightKg',
  ], 'shipment');
  const shipmentNo = optionalText(shipmentRaw.shipmentNo, 'shipmentNo', 80);
  const shipmentDate = isoDate(shipmentRaw.shipmentDate, 'shipmentDate');
  const sfFreightRmb = decimal(shipmentRaw.sfFreightRmb, 'sfFreightRmb', 2, { maximum: '10000000.00' }).raw;
  const optionalWeight = (value: unknown, label: string): string | null => value === null
    ? null
    : decimal(value, label, 3, { zero: true, maximum: '1000000.000' }).raw;
  const sfActualWeightKg = optionalWeight(shipmentRaw.sfActualWeightKg, 'sfActualWeightKg');
  const sfChargeableWeightKg = optionalWeight(shipmentRaw.sfChargeableWeightKg, 'sfChargeableWeightKg');

  if (!Array.isArray(top.items) || !top.items.length || top.items.length > 100) {
    return fail('invalid_contract', 'items must contain between 1 and 100 entries.');
  }
  const sourceItemIds = new Set<string>();
  const recordIds = new Set<string>();
  const parcelIds = new Set<string>();
  let totalPieceCount = 0;
  let totalWeightUnits = 0n;
  const allocationItems: SupplierShippingAllocationItem[] = [];

  const items = top.items.map((itemRaw, itemIndex): SupplierShippingItem => {
    const item = objectWithKeys(itemRaw, [
      'sourceItemId', 'orderItemRecordId', 'activeParcels', 'parcelChanges',
    ], `items[${itemIndex}]`);
    const sourceItemId = requiredText(item.sourceItemId, 'sourceItemId', 80, /^[A-Za-z0-9_-]{8,80}$/);
    const orderItemRecordId = requiredText(item.orderItemRecordId, 'orderItemRecordId', 35, /^rec[A-Za-z0-9]{14,32}$/);
    if (sourceItemIds.has(sourceItemId) || recordIds.has(orderItemRecordId)) {
      return fail('duplicate_item', 'Each source item and Order Item record ID must be unique in the batch.');
    }
    sourceItemIds.add(sourceItemId);
    recordIds.add(orderItemRecordId);
    if (!Array.isArray(item.activeParcels) || !item.activeParcels.length || item.activeParcels.length > 100) {
      return fail('incomplete_batch', 'Every item must have between 1 and 100 active parcel weights.');
    }
    let itemWeightUnits = 0n;
    const activeParcels = item.activeParcels.map((parcelRaw, parcelIndex) => {
      const parcel = objectWithKeys(parcelRaw, ['sourceParcelId', 'weightKg'], `activeParcels[${parcelIndex}]`);
      const sourceParcelId = requiredText(parcel.sourceParcelId, 'sourceParcelId', 80, /^[A-Za-z0-9_-]{8,80}$/);
      if (parcelIds.has(sourceParcelId)) {
        return fail('combined_or_duplicate_parcel', 'A parcel ID can belong to only one Order Item.');
      }
      parcelIds.add(sourceParcelId);
      const weight = decimal(parcel.weightKg, 'weightKg', 3, { maximum: '10000.000' });
      itemWeightUnits += weight.units;
      return { sourceParcelId, weightKg: weight.raw };
    });

    if (!Array.isArray(item.parcelChanges) || item.parcelChanges.length > 200) {
      return fail('invalid_contract', 'parcelChanges must be an array of at most 200 entries.');
    }
    const changeSequences = new Set<number>();
    const parcelChanges = item.parcelChanges.map((changeRaw, changeIndex): SupplierParcelChange => {
      const change = objectWithKeys(changeRaw, [
        'sequence', 'sourceParcelId', 'beforeWeightKg', 'afterWeightKg', 'voided', 'reason', 'changedAt',
      ], `parcelChanges[${changeIndex}]`);
      const sequence = integer(change.sequence, 'parcel change sequence', 1, 1_000_000);
      if (changeSequences.has(sequence)) return fail('invalid_contract', 'Parcel change sequence must be unique per item.');
      changeSequences.add(sequence);
      const sourceParcelId = requiredText(change.sourceParcelId, 'sourceParcelId', 80, /^[A-Za-z0-9_-]{8,80}$/);
      const beforeWeightKg = change.beforeWeightKg === null
        ? null
        : decimal(change.beforeWeightKg, 'beforeWeightKg', 3, { maximum: '10000.000' }).raw;
      const afterWeightKg = change.afterWeightKg === null
        ? null
        : decimal(change.afterWeightKg, 'afterWeightKg', 3, { maximum: '10000.000' }).raw;
      if (beforeWeightKg === null && afterWeightKg === null) {
        return fail('invalid_contract', 'A parcel change must preserve a before or after weight.');
      }
      if (typeof change.voided !== 'boolean') return fail('invalid_contract', 'Parcel change voided flag is invalid.');
      return {
        sequence,
        sourceParcelId,
        beforeWeightKg,
        afterWeightKg,
        voided: change.voided,
        reason: requiredText(change.reason, 'parcel change reason', 300),
        changedAt: isoTimestamp(change.changedAt, 'parcel change timestamp'),
      };
    }).sort((left, right) => left.sequence - right.sequence);

    totalPieceCount += activeParcels.length;
    totalWeightUnits += itemWeightUnits;
    allocationItems.push({
      sourceItemId,
      orderItemRecordId,
      pieceCount: activeParcels.length,
      pieceWeightsKg: activeParcels.map(parcel => parcel.weightKg),
      totalWeightKg: fixedUnits(itemWeightUnits, 3),
    });
    return { sourceItemId, orderItemRecordId, activeParcels, parcelChanges };
  });

  const batch: SupplierShippingBatch = {
    contract: SUPPLIER_SHIPPING_CONTRACT,
    sourceSystem: 'LKS_Supplier_Portal',
    sourceVersion,
    sourceBatchId,
    sourceRevision,
    previousPayloadSha256,
    correctionReason,
    createdAt: isoTimestamp(top.createdAt, 'createdAt'),
    shipment: {
      shipmentNo,
      shipmentDate,
      sfFreightRmb,
      sfActualWeightKg,
      sfChargeableWeightKg,
    },
    items,
  };
  return {
    batch,
    payloadSha256: supplierShippingJsonSha256(batch),
    totalPieceCount,
    totalItemWeightKg: fixedUnits(totalWeightUnits, 3),
    allocationItems,
  };
};

class BatchLock {
  private readonly locks = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) || Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.locks.set(key, current);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release?.();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }
}

const outcome = (
  status: SupplierShippingOutcome['status'],
  code: string,
  input: ValidatedSupplierShippingBatch,
  retrySafe: boolean,
  shipmentRecordId?: string | null,
): SupplierShippingOutcome => ({
  status,
  code,
  sourceBatchId: input.batch.sourceBatchId,
  sourceRevision: input.batch.sourceRevision,
  payloadSha256: input.payloadSha256,
  ...(shipmentRecordId ? { shipmentRecordId } : {}),
  retrySafe,
});

export class SupplierShippingReceiver {
  private readonly lock = new BatchLock();

  constructor(
    private readonly adapter: SupplierShippingAdapter,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  async receive(raw: unknown): Promise<SupplierShippingOutcome> {
    const input = validateSupplierShippingBatch(raw);
    return this.lock.run(input.batch.sourceBatchId, async () => {
      const existing = await this.adapter.getReceipt(input.batch.sourceBatchId);
      if (existing?.state === 'committed') {
        if (existing.sourceRevision === input.batch.sourceRevision && existing.payloadSha256 === input.payloadSha256) {
          return outcome('already_committed', 'exact_replay', input, false, existing.shipmentRecordId);
        }
        return outcome('rejected', 'committed_batch_correction_requires_review', input, false);
      }
      if (existing) {
        if (input.batch.sourceRevision < existing.sourceRevision) {
          return outcome('rejected', 'stale_source_revision', input, false);
        }
        if (input.batch.sourceRevision === existing.sourceRevision && input.payloadSha256 !== existing.payloadSha256) {
          return outcome('rejected', 'idempotency_conflict', input, false);
        }
        if (input.batch.sourceRevision > existing.sourceRevision
          && input.batch.previousPayloadSha256 !== existing.payloadSha256) {
          return outcome('rejected', 'invalid_correction_chain', input, false);
        }
      }

      if (input.batch.shipment.shipmentNo) {
        const existingShipment = await this.adapter.findShipmentByNumber(input.batch.shipment.shipmentNo);
        if (existingShipment && existingShipment.sourceBatchId !== input.batch.sourceBatchId) {
          return outcome('rejected', 'shipment_no_already_exists', input, false);
        }
      }

      const targets = await this.adapter.resolveTargets(input.batch.items);
      const expectedTargets = new Set(input.batch.items.map(item => `${item.sourceItemId}:${item.orderItemRecordId}`));
      const actualTargets = new Set(targets.map(target => `${target.sourceItemId}:${target.orderItemRecordId}`));
      if (
        targets.length !== input.batch.items.length
        || actualTargets.size !== expectedTargets.size
        || [...expectedTargets].some(target => !actualTargets.has(target))
      ) {
        const receipt = await this.adapter.recordRetryableFailure(input, 'incomplete_target_lookup', this.clock());
        if (receipt.state === 'committed' && receipt.payloadSha256 === input.payloadSha256) {
          return outcome('already_committed', 'exact_replay', input, false, receipt.shipmentRecordId);
        }
        return outcome('retryable_failure', 'incomplete_target_lookup', input, true);
      }
      if (targets.some(target => target.status === 'missing')) {
        const receipt = await this.adapter.recordRetryableFailure(input, 'unmapped_order_item', this.clock());
        if (receipt.state === 'committed' && receipt.payloadSha256 === input.payloadSha256) {
          return outcome('already_committed', 'exact_replay', input, false, receipt.shipmentRecordId);
        }
        return outcome('retryable_failure', 'unmapped_order_item', input, true);
      }
      if (targets.some(target => target.status === 'ambiguous')) {
        return outcome('rejected', 'ambiguous_order_item', input, false);
      }
      if (targets.some(target => target.linkedChinaShipmentIds.length > 0 && !(
        target.linkedChinaShipmentSourceBatchIds?.length === target.linkedChinaShipmentIds.length
        && target.linkedChinaShipmentSourceBatchIds.every(sourceBatchId => sourceBatchId === input.batch.sourceBatchId)
      ))) {
        return outcome('rejected', 'order_item_already_shipped', input, false);
      }

      try {
        const receipt = await this.adapter.commitAtomically(input, targets, this.clock());
        return outcome('committed', 'committed', input, false, receipt.shipmentRecordId);
      } catch (error) {
        if (error instanceof SupplierShippingContractError) {
          return outcome('rejected', error.code, input, false);
        }
        if (!(error instanceof SupplierShippingRetryableError)) throw error;
        const receipt = await this.adapter.recordRetryableFailure(input, error.code, this.clock());
        if (receipt.state === 'committed' && receipt.payloadSha256 === input.payloadSha256) {
          return outcome('already_committed', 'exact_replay', input, false, receipt.shipmentRecordId);
        }
        return outcome('retryable_failure', error.code, input, true);
      }
    });
  }
}
