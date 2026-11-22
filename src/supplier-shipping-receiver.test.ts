import assert from 'node:assert/strict';
import crypto from 'crypto';
import test from 'node:test';
import { buildChinaShipmentWritePlan, type ChinaShipmentWritePlan } from './china-shipment-input';
import {
  SupplierShippingContractError,
  SupplierShippingReceiver,
  SupplierShippingRetryableError,
  type SupplierShippingAdapter,
  type SupplierShippingAttempt,
  type SupplierShippingBatch,
  type SupplierShippingItem,
  type SupplierShippingReceipt,
  type SupplierShippingTarget,
  type ValidatedSupplierShippingBatch,
  supplierBatchToChinaShipmentInput,
  supplierShippingItemNoLookupKeys,
  validateSupplierShippingBatch,
} from './supplier-shipping-receiver';

const ITEM_A = 'recAAAAAAAAAAAAAA';
const ITEM_B = 'recBBBBBBBBBBBBBB';

test('supplier item lookup keeps exact keys and safely adds the single-item A fallback', () => {
  assert.deepEqual(supplierShippingItemNoLookupKeys(' OCT 2601 '), ['OCT2601', 'OCT2601-A']);
  assert.deepEqual(supplierShippingItemNoLookupKeys('oct2601a'), ['OCT2601A', 'OCT2601-A']);
  assert.deepEqual(supplierShippingItemNoLookupKeys('OCT2601-B'), ['OCT2601-B']);
  assert.deepEqual(supplierShippingItemNoLookupKeys(''), []);
});

test('legacy short opaque Supplier item IDs remain valid but unsafe characters stay rejected', () => {
  const shortId = fixture();
  shortId.items[0].sourceItemId = 'legacy1';
  assert.doesNotThrow(() => validateSupplierShippingBatch(shortId));
  shortId.items[0].sourceItemId = 'bad id';
  assert.throws(() => validateSupplierShippingBatch(shortId), /sourceItemId/);
});

const fixture = (): SupplierShippingBatch => ({
  contract: 'lks.supplier-shipping.v1',
  sourceSystem: 'LKS_Supplier_Portal',
  sourceVersion: 'SP-TRIAL-20261121.30',
  sourceBatchId: 'SPCN-ABCDEF1234567890',
  sourceRevision: 1,
  previousPayloadSha256: null,
  correctionReason: null,
  createdAt: '2026-11-21T12:00:00+08:00',
  shipment: {
    shipmentNo: 'SYN-SF-RECEIVER-001',
    shipmentDate: '2026-11-21',
    sfFreightRmb: '200.00',
    sfActualWeightKg: '99.500',
    sfChargeableWeightKg: '100.000',
  },
  items: [
    {
      sourceItemId: 'supplier_item_a',
      orderItemRecordId: ITEM_A,
      activeParcels: [
        { sourceParcelId: 'parcel_a1', weightKg: '1.500' },
      ],
      parcelChanges: [],
    },
    {
      sourceItemId: 'supplier_item_b',
      orderItemRecordId: ITEM_B,
      activeParcels: [
        { sourceParcelId: 'parcel_b1', weightKg: '2.125' },
        { sourceParcelId: 'parcel_b2', weightKg: '3.250' },
      ],
      parcelChanges: [{
        sequence: 1,
        sourceParcelId: 'parcel_b1',
        beforeWeightKg: '2.100',
        afterWeightKg: '2.125',
        voided: false,
        reason: 'Synthetic scale correction',
        changedAt: '2026-11-21T11:58:00+08:00',
      }],
    },
  ],
});

class MemoryAdapter implements SupplierShippingAdapter {
  readonly targets = new Map<string, SupplierShippingTarget>();
  readonly receipts = new Map<string, SupplierShippingReceipt>();
  readonly shipmentRecords = new Map<string, ValidatedSupplierShippingBatch>();
  readonly itemWrites = new Map<string, { pieceCount: number; weights: string[]; total: string }>();
  lastWritePlan: ChinaShipmentWritePlan | null = null;
  commitCount = 0;
  failNextCommit = false;
  private queue: Promise<void> = Promise.resolve();

  constructor() {
    for (const [sourceItemId, recordId] of [['supplier_item_a', ITEM_A], ['supplier_item_b', ITEM_B]]) {
      this.targets.set(recordId, {
        sourceItemId,
        orderItemRecordId: recordId,
        status: 'matched',
        linkedChinaShipmentIds: [],
      });
    }
  }

  async getReceipt(sourceBatchId: string) {
    return structuredClone(this.receipts.get(sourceBatchId) || null);
  }

  async findShipmentByNumber(shipmentNo: string) {
    for (const [shipmentRecordId, input] of this.shipmentRecords) {
      if (input.batch.shipment.shipmentNo?.toLowerCase() === shipmentNo.toLowerCase()) {
        return { shipmentRecordId, sourceBatchId: input.batch.sourceBatchId };
      }
    }
    return null;
  }

  async resolveTargets(items: SupplierShippingItem[]) {
    return items.flatMap(item => {
      const target = this.targets.get(item.orderItemRecordId);
      return target ? [structuredClone(target)] : [{
        sourceItemId: item.sourceItemId,
        orderItemRecordId: item.orderItemRecordId,
        status: 'missing' as const,
        linkedChinaShipmentIds: [],
      }];
    });
  }

  async recordRetryableFailure(input: ValidatedSupplierShippingBatch, code: string, recordedAt: string) {
    const previous = this.receipts.get(input.batch.sourceBatchId);
    if (previous?.state === 'committed') return structuredClone(previous);
    const receipt: SupplierShippingReceipt = {
      sourceBatchId: input.batch.sourceBatchId,
      sourceRevision: input.batch.sourceRevision,
      payloadSha256: input.payloadSha256,
      state: 'retryable_failure',
      originalPayload: structuredClone(input.batch),
      attempts: [
        ...(previous?.attempts || []),
        this.attempt(input, 'retryable_failure', code, recordedAt),
      ],
      shipmentRecordId: null,
    };
    this.receipts.set(input.batch.sourceBatchId, receipt);
    return structuredClone(receipt);
  }

  async commitAtomically(
    input: ValidatedSupplierShippingBatch,
    targets: SupplierShippingTarget[],
    recordedAt: string,
  ) {
    return this.serial(async () => {
      const previous = this.receipts.get(input.batch.sourceBatchId);
      if (previous?.state === 'committed') {
        if (previous.payloadSha256 !== input.payloadSha256 || previous.sourceRevision !== input.batch.sourceRevision) {
          throw new Error('durable receipt compare-and-set conflict');
        }
        return structuredClone(previous);
      }
      const itemSnapshot = new Map(this.itemWrites);
      const shipmentSnapshot = new Map(this.shipmentRecords);
      try {
        if (input.batch.shipment.shipmentNo && await this.findShipmentByNumber(input.batch.shipment.shipmentNo)) {
          throw new SupplierShippingContractError('shipment_no_already_exists', 'Synthetic duplicate shipment number.');
        }
        const plan = buildChinaShipmentWritePlan(
          supplierBatchToChinaShipmentInput(input, targets),
          date => `SF-${date.replace(/-/g, '')}-SYNTHETIC`,
        );
        for (const update of plan.itemUpdates) {
          this.itemWrites.set(update.id, {
            pieceCount: update.fields['China Freight Piece Count'],
            weights: update.fields['China Freight Piece Weights KG'].split('\n'),
            total: String(update.fields['China Freight Weight Input KG']),
          });
        }
        if (this.failNextCommit) {
          this.failNextCommit = false;
          throw new SupplierShippingRetryableError('simulated_provider_failure', 'Synthetic provider failure.');
        }
        const shipmentRecordId = `recShipment${String(this.commitCount + 1).padStart(8, '0')}`;
        this.shipmentRecords.set(shipmentRecordId, structuredClone(input));
        this.lastWritePlan = structuredClone(plan);
        this.commitCount += 1;
        const receipt: SupplierShippingReceipt = {
          sourceBatchId: input.batch.sourceBatchId,
          sourceRevision: input.batch.sourceRevision,
          payloadSha256: input.payloadSha256,
          state: 'committed',
          originalPayload: structuredClone(input.batch),
          attempts: [
            ...(previous?.attempts || []),
            this.attempt(input, 'committed', null, recordedAt),
          ],
          shipmentRecordId,
        };
        this.receipts.set(input.batch.sourceBatchId, receipt);
        return structuredClone(receipt);
      } catch (error) {
        this.itemWrites.clear();
        for (const [key, value] of itemSnapshot) this.itemWrites.set(key, value);
        this.shipmentRecords.clear();
        for (const [key, value] of shipmentSnapshot) this.shipmentRecords.set(key, value);
        throw error;
      }
    });
  }

  private attempt(
    input: ValidatedSupplierShippingBatch,
    state: SupplierShippingAttempt['state'],
    code: string | null,
    recordedAt: string,
  ): SupplierShippingAttempt {
    return {
      attemptId: crypto.randomUUID(),
      sourceRevision: input.batch.sourceRevision,
      payloadSha256: input.payloadSha256,
      state,
      code,
      recordedAt,
    };
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release: (() => void) | undefined;
    this.queue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

const fixedClock = () => '2026-11-21T12:30:00.000Z';

test('validates exact record IDs, preserves original precision and derives allocation only from active parcels', () => {
  const result = validateSupplierShippingBatch(fixture());
  assert.equal(result.totalPieceCount, 3);
  assert.equal(result.totalItemWeightKg, '6.875');
  assert.deepEqual(result.allocationItems.map(item => ({
    id: item.orderItemRecordId,
    pieces: item.pieceCount,
    weights: item.pieceWeightsKg,
    total: item.totalWeightKg,
  })), [
    { id: ITEM_A, pieces: 1, weights: ['1.500'], total: '1.5' },
    { id: ITEM_B, pieces: 2, weights: ['2.125', '3.250'], total: '5.375' },
  ]);
  assert.equal(result.batch.shipment.sfActualWeightKg, '99.500');
  assert.equal(result.batch.shipment.sfChargeableWeightKg, '100.000');
  assert.equal(result.batch.items[1].parcelChanges[0].beforeWeightKg, '2.100');
});

test('Supplier input and the existing owner cost-page input produce the identical Airtable write plan', () => {
  const validated = validateSupplierShippingBatch(fixture());
  const targets: SupplierShippingTarget[] = validated.batch.items.map(item => ({
    sourceItemId: item.sourceItemId,
    orderItemRecordId: item.orderItemRecordId,
    status: 'matched',
    linkedChinaShipmentIds: [],
  }));
  const fromSupplier = buildChinaShipmentWritePlan(
    supplierBatchToChinaShipmentInput(validated, targets),
    () => 'UNUSED',
  );
  const fromExistingPage = buildChinaShipmentWritePlan({
    shipmentNo: 'SYN-SF-RECEIVER-001',
    shipmentDate: '2026-11-21',
    sfFreightRmb: '200.00',
    sfActualWeightKg: '99.500',
    sfChargeableWeightKg: '100.000',
    items: [
      {
        orderItemRecordId: ITEM_A,
        itemLabel: 'SYN-A',
        linkedChinaShipmentIds: [],
        pieceWeightsKg: ['1.500'],
      },
      {
        orderItemRecordId: ITEM_B,
        itemLabel: 'SYN-B',
        linkedChinaShipmentIds: [],
        pieceWeightsKg: ['2.125', '3.250'],
      },
    ],
  }, () => 'UNUSED');

  assert.deepEqual(fromSupplier, fromExistingPage);
  assert.deepEqual(fromSupplier.itemUpdates, [
    {
      id: ITEM_A,
      fields: {
        'China Freight Piece Count': 1,
        'China Freight Piece Weights KG': '1.5',
        'China Freight Weight Input KG': 1.5,
      },
    },
    {
      id: ITEM_B,
      fields: {
        'China Freight Piece Count': 2,
        'China Freight Piece Weights KG': '2.125\n3.25',
        'China Freight Weight Input KG': 5.375,
      },
    },
  ]);
});

test('rejects unknown or PII-shaped fields and never accepts an order number in place of a record ID', () => {
  const withCustomer = { ...fixture(), customerName: 'Synthetic Person' };
  assert.throws(() => validateSupplierShippingBatch(withCustomer), (error: unknown) =>
    error instanceof SupplierShippingContractError && error.code === 'unexpected_field');
  const withoutRecordId = fixture();
  withoutRecordId.items[0].orderItemRecordId = 'SYN-ORDER-001';
  assert.throws(() => validateSupplierShippingBatch(withoutRecordId), (error: unknown) =>
    error instanceof SupplierShippingContractError && error.code === 'invalid_contract');
});

test('fails the whole batch before writes when one item is unmapped or ambiguous', async () => {
  for (const status of ['missing', 'ambiguous'] as const) {
    const adapter = new MemoryAdapter();
    adapter.targets.set(ITEM_B, { ...adapter.targets.get(ITEM_B)!, status });
    const result = await new SupplierShippingReceiver(adapter, fixedClock).receive(fixture());
    assert.equal(result.status, status === 'missing' ? 'retryable_failure' : 'rejected');
    assert.equal(result.code, status === 'missing' ? 'unmapped_order_item' : 'ambiguous_order_item');
    assert.equal(result.retrySafe, status === 'missing');
    assert.equal(adapter.itemWrites.size, 0);
    assert.equal(adapter.shipmentRecords.size, 0);
  }
});

test('exact retry creates one shipment and returns the durable receipt without reallocating freight', async () => {
  const adapter = new MemoryAdapter();
  const receiver = new SupplierShippingReceiver(adapter, fixedClock);
  const first = await receiver.receive(fixture());
  const replay = await receiver.receive(fixture());
  assert.equal(first.status, 'committed');
  assert.equal(replay.status, 'already_committed');
  assert.equal(replay.shipmentRecordId, first.shipmentRecordId);
  assert.equal(adapter.commitCount, 1);
  assert.equal(adapter.shipmentRecords.size, 1);
  assert.equal(adapter.itemWrites.get(ITEM_A)?.pieceCount, 1);
  assert.equal(adapter.itemWrites.get(ITEM_B)?.pieceCount, 2);
});

test('a simulated mid-commit failure rolls back every target write and exact retry succeeds once', async () => {
  const adapter = new MemoryAdapter();
  adapter.failNextCommit = true;
  const receiver = new SupplierShippingReceiver(adapter, fixedClock);
  const failed = await receiver.receive(fixture());
  assert.equal(failed.status, 'retryable_failure');
  assert.equal(failed.code, 'simulated_provider_failure');
  assert.equal(adapter.itemWrites.size, 0);
  assert.equal(adapter.shipmentRecords.size, 0);
  assert.equal(adapter.receipts.get(fixture().sourceBatchId)?.state, 'retryable_failure');

  const retried = await receiver.receive(fixture());
  assert.equal(retried.status, 'committed');
  assert.equal(adapter.commitCount, 1);
  assert.equal(adapter.receipts.get(fixture().sourceBatchId)?.attempts.length, 2);
});

test('a pre-commit corrected revision must chain to the failed payload digest', async () => {
  const adapter = new MemoryAdapter();
  adapter.targets.delete(ITEM_B);
  const receiver = new SupplierShippingReceiver(adapter, fixedClock);
  const failed = await receiver.receive(fixture());
  assert.equal(failed.status, 'retryable_failure');

  adapter.targets.set(ITEM_B, {
    sourceItemId: 'supplier_item_b',
    orderItemRecordId: ITEM_B,
    status: 'matched',
    linkedChinaShipmentIds: [],
  });
  const brokenChain = fixture();
  brokenChain.sourceRevision = 2;
  brokenChain.previousPayloadSha256 = '0'.repeat(64);
  brokenChain.correctionReason = 'Synthetic broken chain';
  const rejected = await receiver.receive(brokenChain);
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.code, 'invalid_correction_chain');

  const corrected = fixture();
  corrected.sourceRevision = 2;
  corrected.previousPayloadSha256 = failed.payloadSha256;
  corrected.correctionReason = 'Synthetic pre-commit parcel correction';
  corrected.items[0].activeParcels[0].weightKg = '1.600';
  const committed = await receiver.receive(corrected);
  assert.equal(committed.status, 'committed');
  assert.equal(adapter.itemWrites.get(ITEM_A)?.total, '1.6');
});

test('two receiver instances racing the same batch still commit once through durable compare-and-set', async () => {
  const adapter = new MemoryAdapter();
  const left = new SupplierShippingReceiver(adapter, fixedClock);
  const right = new SupplierShippingReceiver(adapter, fixedClock);
  const results = await Promise.all([left.receive(fixture()), right.receive(fixture())]);
  assert.deepEqual(new Set(results.map(result => result.status)), new Set(['committed']));
  assert.equal(adapter.commitCount, 1);
  assert.equal(results[0].shipmentRecordId, results[1].shipmentRecordId);
});

test('same idempotency revision with changed money or weight is rejected without overwriting committed data', async () => {
  const adapter = new MemoryAdapter();
  const receiver = new SupplierShippingReceiver(adapter, fixedClock);
  await receiver.receive(fixture());
  const changed = fixture();
  changed.shipment.sfFreightRmb = '201.00';
  const result = await receiver.receive(changed);
  assert.equal(result.status, 'rejected');
  assert.equal(result.code, 'committed_batch_correction_requires_review');
  assert.equal(adapter.commitCount, 1);
  assert.equal(adapter.receipts.get(changed.sourceBatchId)?.originalPayload.shipment.sfFreightRmb, '200.00');
});

test('the same non-empty SF number cannot create a second batch', async () => {
  const adapter = new MemoryAdapter();
  const receiver = new SupplierShippingReceiver(adapter, fixedClock);
  await receiver.receive(fixture());
  const second = fixture();
  second.sourceBatchId = 'SPCN-SECOND1234567890';
  const result = await receiver.receive(second);
  assert.equal(result.status, 'rejected');
  assert.equal(result.code, 'shipment_no_already_exists');
  assert.equal(adapter.commitCount, 1);
});

test('already-linked item and post-commit correction stop for explicit review', async () => {
  const linkedAdapter = new MemoryAdapter();
  linkedAdapter.targets.set(ITEM_A, {
    ...linkedAdapter.targets.get(ITEM_A)!,
    linkedChinaShipmentIds: ['recExistingShipment'],
  });
  const linked = await new SupplierShippingReceiver(linkedAdapter, fixedClock).receive(fixture());
  assert.equal(linked.status, 'rejected');
  assert.equal(linked.code, 'order_item_already_shipped');
  assert.equal(linkedAdapter.itemWrites.size, 0);

  const adapter = new MemoryAdapter();
  const receiver = new SupplierShippingReceiver(adapter, fixedClock);
  const committed = await receiver.receive(fixture());
  const correction = fixture();
  correction.sourceRevision = 2;
  correction.previousPayloadSha256 = committed.payloadSha256;
  correction.correctionReason = 'Synthetic correction after dispatch';
  correction.items[0].activeParcels[0].weightKg = '1.600';
  const stopped = await receiver.receive(correction);
  assert.equal(stopped.status, 'rejected');
  assert.equal(stopped.code, 'committed_batch_correction_requires_review');
  assert.equal(adapter.commitCount, 1);
});

test('combined packages, incomplete batches and excess precision fail before any adapter call', async () => {
  const duplicateParcel = fixture();
  duplicateParcel.items[1].activeParcels[0].sourceParcelId = duplicateParcel.items[0].activeParcels[0].sourceParcelId;
  assert.throws(() => validateSupplierShippingBatch(duplicateParcel), (error: unknown) =>
    error instanceof SupplierShippingContractError && error.code === 'combined_or_duplicate_parcel');

  const incomplete = fixture();
  incomplete.items[0].activeParcels = [];
  assert.throws(() => validateSupplierShippingBatch(incomplete), (error: unknown) =>
    error instanceof SupplierShippingContractError && error.code === 'incomplete_batch');

  const precision = fixture();
  precision.items[0].activeParcels[0].weightKg = '1.2345';
  assert.throws(() => validateSupplierShippingBatch(precision), (error: unknown) =>
    error instanceof SupplierShippingContractError && error.code === 'invalid_contract');
});

test('record-only SF totals never replace per-item weights and light packages are outside this contract', () => {
  const payload = fixture();
  payload.shipment.sfActualWeightKg = '999.000';
  payload.shipment.sfChargeableWeightKg = '1000.000';
  const result = validateSupplierShippingBatch(payload);
  assert.equal(result.totalItemWeightKg, '6.875');
  assert.equal(result.totalPieceCount, 3);
  assert.equal(Object.prototype.hasOwnProperty.call(result.batch.items[0], 'accessories'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result.batch.items[0], 'deliveryPackages'), false);
});
