import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AirtableQuotationImageMetadataWriter,
  InProcessQuoteItemsLock,
} from './airtable-quotation-image-metadata';
import type { QuotationImageMetadata } from './quotation-image';

const ITEM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ITEM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const KEY_A = `sha256:${'1'.repeat(64)}`;
const KEY_B = `sha256:${'2'.repeat(64)}`;

const pending = (itemId: string, key: string) => ({
  item_id: itemId,
  itemType: 'Display box 展示盒',
  amount: itemId === ITEM_A ? 1200 : 2300,
  description: itemId === ITEM_A ? 'Original A' : 'Original B',
  quotation_image: {
    contract: 'quotation-image-v1', state: 'pending', idempotency_key: key,
    asset_key: `quotation-images/${key.slice(7)}.png`, attempts: 0, updated_at: '2026-08-24T00:00:00.000Z',
  },
});

const ready = (key: string): QuotationImageMetadata => ({
  contract: 'quotation-image-v1', state: 'ready', idempotency_key: key,
  asset_key: `quotation-images/${key.slice(7)}.png`, attempts: 1, updated_at: '2026-08-24T00:01:00.000Z',
});

test('metadata writer serializes concurrent item updates and changes no quote content except quotation_image', async () => {
  const fields: Record<string, unknown> = {
    'Quote Items JSON': JSON.stringify([pending(ITEM_A, KEY_A), pending(ITEM_B, KEY_B)]),
    Total: 3500,
    Notes: 'Original notes',
    'Terms and Conditions': 'Original terms',
  };
  const table = {
    async find(id: string) { return { id, fields: { ...fields } }; },
    async update(records: Array<{ id: string; fields: Record<string, unknown> }>) {
      await new Promise(resolve => setTimeout(resolve, 2));
      Object.assign(fields, records[0].fields);
    },
  };
  const writer = new AirtableQuotationImageMetadataWriter(table);
  await Promise.all([
    writer.update({ quoteRecordId: 'rec-quote', itemId: ITEM_A, metadata: ready(KEY_A) }),
    writer.update({ quoteRecordId: 'rec-quote', itemId: ITEM_B, metadata: ready(KEY_B) }),
  ]);
  const items = JSON.parse(String(fields['Quote Items JSON']));
  assert.equal(items[0].quotation_image.state, 'ready');
  assert.equal(items[1].quotation_image.state, 'ready');
  assert.equal(items[0].amount, 1200);
  assert.equal(items[1].amount, 2300);
  assert.equal(items[0].description, 'Original A');
  assert.equal(items[1].description, 'Original B');
  assert.equal(fields.Total, 3500);
  assert.equal(fields.Notes, 'Original notes');
  assert.equal(fields['Terms and Conditions'], 'Original terms');
});

test('metadata writer rejects an idempotency mismatch without writing', async () => {
  let writes = 0;
  const table = {
    async find(id: string) { return { id, fields: { 'Quote Items JSON': JSON.stringify([pending(ITEM_A, KEY_A)]) } }; },
    async update() { writes += 1; },
  };
  const writer = new AirtableQuotationImageMetadataWriter(table);
  await assert.rejects(writer.update({ quoteRecordId: 'rec-quote', itemId: ITEM_A, metadata: ready(KEY_B) }));
  assert.equal(writes, 0);
});

test('shared Quote Items lock preserves both image metadata and conversion identity', async () => {
  const fields: Record<string, unknown> = {
    'Quote Items JSON': JSON.stringify([pending(ITEM_A, KEY_A)]),
  };
  const table = {
    async find(id: string) { return { id, fields: { ...fields } }; },
    async update(records: Array<{ id: string; fields: Record<string, unknown> }>) {
      await new Promise(resolve => setTimeout(resolve, 2));
      Object.assign(fields, records[0].fields);
    },
  };
  const lock = new InProcessQuoteItemsLock();
  const writer = new AirtableQuotationImageMetadataWriter(table, lock);
  await Promise.all([
    writer.update({ quoteRecordId: 'rec-quote', itemId: ITEM_A, metadata: ready(KEY_A) }),
    lock.run('rec-quote', async () => {
      const record = await table.find('rec-quote');
      const items = JSON.parse(String(record.fields['Quote Items JSON']));
      items[0] = {
        ...items[0],
        order_item_identity: { item_id: ITEM_A, record_id: 'rec-order-item' },
      };
      await table.update([{ id: 'rec-quote', fields: { 'Quote Items JSON': JSON.stringify(items) } }]);
    }),
  ]);
  const [item] = JSON.parse(String(fields['Quote Items JSON']));
  assert.equal(item.quotation_image.state, 'ready');
  assert.deepEqual(item.order_item_identity, { item_id: ITEM_A, record_id: 'rec-order-item' });
  assert.equal(item.amount, 1200);
  assert.equal(item.description, 'Original A');
});
