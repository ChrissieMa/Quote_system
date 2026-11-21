import assert from 'node:assert/strict';
import test from 'node:test';
import type { FieldSet } from 'airtable';
import { AirtableSupplierShippingAdapter } from './supplier-shipping-airtable';
import {
  SupplierShippingReceiver,
  type SupplierShippingBatch,
} from './supplier-shipping-receiver';

type FakeRecord = { id: string; fields: FieldSet };

class FakeTable {
  readonly records = new Map<string, FakeRecord>();
  failShipmentCreateAfterWrite = false;
  private sequence = 0;

  constructor(private readonly prefix: string, records: FakeRecord[] = [], private readonly orderItems?: FakeTable) {
    for (const record of records) this.records.set(record.id, structuredClone(record));
  }

  async find(id: string): Promise<FakeRecord> {
    const record = this.records.get(id);
    if (!record) throw new Error('NOT_FOUND');
    return structuredClone(record);
  }

  select(options: Record<string, unknown> = {}) {
    return { firstPage: async (): Promise<FakeRecord[]> => {
      let records = [...this.records.values()];
      const formula = String(options.filterByFormula || '');
      const match = formula.match(/^\{([^}]+)\} = '((?:\\'|[^'])*)'$/);
      if (match) {
        const field = match[1];
        const expected = match[2].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
        records = records.filter(record => String(record.fields[field] || '') === expected);
      }
      const max = Number(options.maxRecords || records.length);
      return structuredClone(records.slice(0, max));
    } };
  }

  async create(rows: Array<{ fields: FieldSet }>): Promise<FakeRecord[]> {
    const created = rows.map(row => {
      const id = `${this.prefix}${String(++this.sequence).padStart(14, '0')}`;
      const record = { id, fields: structuredClone(row.fields) };
      this.records.set(id, record);
      const linkedIds = Array.isArray(row.fields['Order Items']) ? row.fields['Order Items'] as string[] : [];
      for (const orderItemId of linkedIds) {
        const item = this.orderItems?.records.get(orderItemId);
        if (item) item.fields['China Shipments'] = [
          ...(Array.isArray(item.fields['China Shipments']) ? item.fields['China Shipments'] as string[] : []),
          id,
        ];
      }
      return structuredClone(record);
    });
    if (this.failShipmentCreateAfterWrite) {
      this.failShipmentCreateAfterWrite = false;
      throw new Error('SYNTHETIC_RESPONSE_LOST');
    }
    return created;
  }

  async update(rows: Array<{ id: string; fields: FieldSet }>): Promise<FakeRecord[]> {
    return rows.map(row => {
      const record = this.records.get(row.id);
      if (!record) throw new Error('NOT_FOUND');
      record.fields = { ...record.fields, ...structuredClone(row.fields) };
      return structuredClone(record);
    });
  }
}

const ITEM_A = 'recAAAAAAAAAAAAAA';
const ITEM_B = 'recBBBBBBBBBBBBBB';

const payload = (): SupplierShippingBatch => ({
  contract: 'lks.supplier-shipping.v1',
  sourceSystem: 'LKS_Supplier_Portal',
  sourceVersion: 'SP-TRIAL-20261121.31',
  sourceBatchId: 'SPCN-SYNTHETIC-AIRTABLE-001',
  sourceRevision: 1,
  previousPayloadSha256: null,
  correctionReason: null,
  createdAt: '2026-11-21T23:50:00+08:00',
  shipment: {
    shipmentNo: 'SYN-SF-AIRTABLE-001',
    shipmentDate: '2026-11-21',
    sfFreightRmb: '632.00',
    sfActualWeightKg: '9.300',
    sfChargeableWeightKg: '10.000',
  },
  items: [
    {
      sourceItemId: 'supplier_order_a',
      orderItemRecordId: ITEM_A,
      activeParcels: [{ sourceParcelId: 'parcel_a_001', weightKg: '4.300' }],
      parcelChanges: [],
    },
    {
      sourceItemId: 'supplier_order_b',
      orderItemRecordId: ITEM_B,
      activeParcels: [
        { sourceParcelId: 'parcel_b_001', weightKg: '2.000' },
        { sourceParcelId: 'parcel_b_002', weightKg: '3.000' },
      ],
      parcelChanges: [],
    },
  ],
});

const fixture = () => {
  const orderItems = new FakeTable('recItem', [
    { id: ITEM_A, fields: { 'Item No': 'SYN-A', 'China Shipments': [] } },
    { id: ITEM_B, fields: { 'Item No': 'SYN-B', 'China Shipments': [] } },
  ]);
  const shipments = new FakeTable('recShipment', [], orderItems);
  const receipts = new FakeTable('recReceipt');
  const financeCalls: string[][] = [];
  const adapter = new AirtableSupplierShippingAdapter(
    { orderItems, chinaShipments: shipments, receipts },
    async ids => { financeCalls.push([...ids]); },
  );
  return { orderItems, shipments, receipts, financeCalls, adapter };
};

test('Production-shaped adapter writes the same Item fields and one China Shipment then replays safely', async () => {
  const f = fixture();
  const receiver = new SupplierShippingReceiver(f.adapter, () => '2026-11-21T16:00:00.000Z');
  const first = await receiver.receive(payload());
  const replay = await receiver.receive(payload());
  assert.equal(first.status, 'committed');
  assert.equal(replay.status, 'already_committed');
  assert.equal(f.shipments.records.size, 1);
  assert.equal(f.receipts.records.size, 1);
  assert.equal(f.orderItems.records.get(ITEM_A)?.fields['China Freight Piece Weights KG'], '4.3');
  assert.equal(f.orderItems.records.get(ITEM_B)?.fields['China Freight Piece Weights KG'], '2\n3');
  assert.equal(f.orderItems.records.get(ITEM_B)?.fields['China Freight Weight Input KG'], 5);
  assert.equal(f.financeCalls.length, 1);
});

test('lost Shipment create response recovers the same linked Shipment instead of creating or allocating twice', async () => {
  const f = fixture();
  f.shipments.failShipmentCreateAfterWrite = true;
  const receiver = new SupplierShippingReceiver(f.adapter, () => '2026-11-21T16:00:00.000Z');
  const failed = await receiver.receive(payload());
  assert.equal(failed.status, 'retryable_failure');
  assert.equal(f.shipments.records.size, 1);
  assert.equal(f.financeCalls.length, 0);

  const recovered = await receiver.receive(payload());
  assert.equal(recovered.status, 'committed');
  assert.equal(f.shipments.records.size, 1);
  assert.equal(f.financeCalls.length, 1);
  const itemA = f.orderItems.records.get(ITEM_A)!;
  assert.equal((itemA.fields['China Shipments'] as string[]).length, 1);
});
