import assert from 'node:assert/strict';
import test from 'node:test';
import {
  lookupQuoteRecords,
  validateQuoteLookupQuery,
  type StoredQuoteRecord,
} from './quote-lookup';

const records: StoredQuoteRecord[] = [
  {
    id: 'rec-1',
    fields: {
      'Quote Number': 'QT-2026-001',
      'Quote Date': '2026-07-01',
      Status: 'Draft',
      'Customer Name': 'Example Customer',
      'Customer Phone': '+852 6123 4567',
      'Converted Order No': 'ORD-2026-010',
      'Quote Items JSON': JSON.stringify([
        {
          itemType: 'Display box 展示盒',
          interL: '30',
          interD: '20',
          interH: '25',
          qty: 2,
          freight: 100,
          hongKongDelivery: 200,
          profit: 500,
        },
        {
          itemType: 'Display Case 疊高展示櫃',
          interL: '40',
          interD: '30',
          interH: '50',
          qty: 1,
          freight: 300,
          deliveryCostReserve: 400,
          profit: 800,
        },
      ]),
      Total: 4321,
    },
  },
  {
    id: 'rec-2',
    fields: {
      'Quote Number': 'QT-2026-002',
      'Quote Date': '2026-07-02',
      Status: 'Ready to Convert',
      'Contact Name': 'Example Customer Two',
      Phone: '61234567',
      'Quote Items JSON': 'not valid JSON',
      Total: 1000,
    },
  },
];

test('requires exactly one bounded lookup field', () => {
  assert.deepEqual(validateQuoteLookupQuery({ quoteNo: 'QT-2026-001' }), { quoteNo: 'QT-2026-001' });
  assert.throws(() => validateQuoteLookupQuery({}), /exactly one/);
  assert.throws(() => validateQuoteLookupQuery({ quoteNo: 'A', phone: '61234567' }), /exactly one/);
  assert.throws(() => validateQuoteLookupQuery({ quoteNo: 'A', extra: 'B' }), /exactly one/);
  assert.throws(() => validateQuoteLookupQuery({ phone: '123' }), /four digits/);
});

test('exact Quote No returns stored quoted values without calculating actual profit', () => {
  const result = lookupQuoteRecords(records, { quoteNo: 'qt-2026-001' }) as any;
  assert.equal(result.result, 'quote');
  assert.equal(result.readOnly, true);
  assert.equal(result.quote.items[0].quotedChinaFreightHkd, 100);
  assert.equal(result.quote.items[0].quotedLocalDeliveryHkd, 200);
  assert.equal(result.quote.items[1].quotedLocalDeliveryHkd, 400);
  assert.equal(result.quote.items[1].quotedProfitHkd, 800);
  assert.equal(result.quote.quotedProfitTotalHkd, 1300);
  assert.equal(result.quote.finalTotalHkd, 4321);
  assert.match(result.quote.profitBasis, /Quoted Profit/);
  assert.match(result.quote.profitBasis, /Actual Profit/);
  assert.equal(result.quote.dataCompleteness.complete, true);
});

test('phone and customer searches return candidates for explicit selection even when one matches', () => {
  const phoneResult = lookupQuoteRecords(records, { phone: '852 6123 4567' }) as any;
  assert.equal(phoneResult.result, 'multiple_matches');
  assert.equal(phoneResult.quote, undefined);
  assert.equal(phoneResult.matches.length, 2);

  const customerResult = lookupQuoteRecords(records, { customer: 'Customer Two' }) as any;
  assert.equal(customerResult.result, 'selection_required');
  assert.equal(customerResult.quote, undefined);
  assert.deepEqual(customerResult.matches.map((match: any) => match.quoteNo), ['QT-2026-002']);
});

test('Order No returns a candidate and never guesses the quote', () => {
  const result = lookupQuoteRecords(records, { orderNo: 'ord-2026-010' }) as any;
  assert.equal(result.result, 'selection_required');
  assert.equal(result.quote, undefined);
  assert.equal(result.matches[0].quoteNo, 'QT-2026-001');
});

test('missing historic item fields are reported, not silently converted to zero', () => {
  const result = lookupQuoteRecords(records, { quoteNo: 'QT-2026-002' }) as any;
  assert.equal(result.result, 'quote');
  assert.equal(result.quote.items.length, 0);
  assert.equal(result.quote.quotedProfitTotalHkd, null);
  assert.equal(result.quote.dataCompleteness.complete, false);
  assert.deepEqual(result.quote.dataCompleteness.missing, ['Items']);
});

test('unknown Quote No has a read-only not-found response', () => {
  const result = lookupQuoteRecords(records, { quoteNo: 'QT-NOT-FOUND' }) as any;
  assert.deepEqual(result.matches, []);
  assert.equal(result.result, 'not_found');
  assert.equal(result.readOnly, true);
});
