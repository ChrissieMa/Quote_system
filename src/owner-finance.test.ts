import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendDriverPaymentLog,
  calculateOwnerFinanceSummary,
  calculateOwnerOrderCostBreakdown,
  getOrderAmountReceived,
  getOrderOutstandingAmount,
  getMacbookInstallmentNumber,
  getDriverSettlement,
  parseDriverPaymentAmountCents,
  planDriverPayment,
  planOrderPayment,
  paymentLogHasRequest,
  resolveMarketingFinanceMonth,
  summarizeOwnerOrderCostCoverage,
  validateDriverPaymentRequestId,
  validateOrderPaymentRequestId,
} from './owner-finance';

const record = (id: string, fields: Record<string, unknown>) => ({ id, fields });

const baseOptions = {
  month: '2026-08',
  getOrderMonth: () => '2026-08',
  getDriverPayable: (fields: Record<string, unknown>) => Number(fields.driverPayable || 0),
  getOutstandingFinanceStatus: () => '⏳ 尚欠成本',
};

test('capital equipment and allocation-pending marketing are excluded from August P&L', () => {
  const summary = calculateOwnerFinanceSummary({
    ...baseOptions,
    orders: [
      record('order', {
        'Final Amount': 29900.663774,
        'Amount Received HKD': 29900.663774,
        'Supplier Cost Used HKD': 7000,
        'China Freight Used HKD': 2500,
        'Actual Reissue Cost HKD': 552.42,
        driverPayable: 486,
      }),
      ...Array.from({ length: 5 }, (_, index) => record(`pending-${index + 2}`, {})),
    ],
    marketing: [
      record('allocation-pending', {
        'Spend Amount HKD': 1213.14,
        'Spend Date': '2026-08-15',
        'Month': 'Pre-2026-07 — allocation pending',
        'Payment Status': 'Paid',
      }),
      record('allocated', {
        'Spend Amount HKD': 461.88,
        'Spend Date': '2026-08-16',
        'Month': '2026-08',
        'Payment Status': 'Paid',
      }),
    ],
    expenses: [
      record('capital-equipment', {
        'Month': '2026-08',
        'Category': 'Computer / Capital Equipment',
        'Amount HKD': 27374,
      }),
      record('operating', { 'Month': '2026-08', 'Category': 'Software', 'Amount HKD': 4443.17 }),
      record('instalment', {
        'Month': '2026-08',
        'Category': 'Computer / Monthly Instalment',
        'Amount HKD': 1236.39,
      }),
    ],
  });

  assert.equal(resolveMarketingFinanceMonth({ Month: 'Pre-2026-07 — allocation pending', 'Spend Date': '2026-08-15' }), null);
  assert.equal(summary.marketingSpend, 461.88);
  assert.equal(summary.unallocatedMarketingSpend, 1213.14);
  assert.equal(summary.businessExpenses, 5679.56);
  assert.equal(summary.capitalItemsTotal, 27374);
  assert.ok(Math.abs(summary.orderGrossProfit - 19362.243774) < 1e-9);
  assert.ok(Math.abs(summary.netProfit - 13220.803774) < 1e-9);
  assert.equal(summary.pendingCostOrders, 6);
  assert.equal(summary.provisional, true);
});

test('MacBook instalment schedule starts in August 2026 and stops after 24 unique months', () => {
  assert.equal(getMacbookInstallmentNumber('2026-07'), null);
  assert.equal(getMacbookInstallmentNumber('2026-08'), 1);
  assert.equal(getMacbookInstallmentNumber('2028-07'), 24);
  assert.equal(getMacbookInstallmentNumber('2028-08'), null);
});

test('valid Marketing Month wins and blank Month falls back to Spend Date', () => {
  assert.equal(resolveMarketingFinanceMonth({ Month: '2026-07', 'Spend Date': '2026-08-15' }), '2026-07');
  assert.equal(resolveMarketingFinanceMonth({ Month: '', 'Spend Date': '2026-08-15' }), '2026-08');
});

test('driver settlement supports unpaid, partial and full without changing P&L cost', () => {
  assert.deepEqual(getDriverSettlement(486, 0), {
    payableCents: 48600, paidCents: 0, outstandingCents: 48600,
    overpaidCents: 0, differenceCents: -48600, status: '未付款',
  });
  assert.deepEqual(getDriverSettlement(486, 200), {
    payableCents: 48600, paidCents: 20000, outstandingCents: 28600,
    overpaidCents: 0, differenceCents: -28600, status: '部分付款',
  });
  assert.deepEqual(getDriverSettlement(486, 486), {
    payableCents: 48600, paidCents: 48600, outstandingCents: 0,
    overpaidCents: 0, differenceCents: 0, status: '已付款',
  });
  assert.deepEqual(getDriverSettlement(486, 490), {
    payableCents: 48600, paidCents: 49000, outstandingCents: 0,
    overpaidCents: 400, differenceCents: 400, status: '超付',
  });
});

test('payment request log makes duplicate submissions a no-op key', () => {
  const first = appendDriverPaymentLog('', 'pay_0123456789abcdef', '2026-08-31T10:00:00.000Z', 20000);
  assert.equal(paymentLogHasRequest(first, 'pay_0123456789abcdef'), true);
  assert.equal(paymentLogHasRequest(first, 'pay_fedcba9876543210'), false);
  assert.equal(appendDriverPaymentLog(first, 'pay_fedcba9876543210', '2026-08-31T11:00:00.000Z', 28600).split('\n').length, 2);
});

test('driver payment input rejects zero, exponent, excess decimals and malformed request IDs', () => {
  assert.equal(parseDriverPaymentAmountCents('486'), 48600);
  assert.equal(parseDriverPaymentAmountCents('200.50'), 20050);
  assert.throws(() => parseDriverPaymentAmountCents('0'), /amount-invalid/);
  assert.throws(() => parseDriverPaymentAmountCents('1e2'), /amount-invalid/);
  assert.throws(() => parseDriverPaymentAmountCents('1.001'), /amount-invalid/);
  assert.equal(validateDriverPaymentRequestId('pay_0123456789abcdef0123456789abcdef'), 'pay_0123456789abcdef0123456789abcdef');
  assert.throws(() => validateDriverPaymentRequestId('payment-one'), /request-id-invalid/);
});

test('partial, full, duplicate and overpayment driver plans have one economic effect', () => {
  const firstId = 'pay_0123456789abcdef0123456789abcdef';
  const secondId = 'pay_fedcba9876543210fedcba9876543210';
  const partial = planDriverPayment({
    payable: 486, paid: 0, log: '', requestId: firstId, amountCents: 20000,
    paidAt: '2026-08-31T10:00:00.000Z',
  });
  assert.equal(partial.paidCents, 20000);
  assert.equal(partial.status, '部分付款');
  const duplicate = planDriverPayment({
    payable: 486, paid: 200, log: partial.log, requestId: firstId, amountCents: 20000,
    paidAt: '2026-08-31T10:00:01.000Z',
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.paidCents, 20000);
  assert.equal(duplicate.log, partial.log);
  const full = planDriverPayment({
    payable: 486, paid: 200, log: partial.log, requestId: secondId, amountCents: 28600,
    paidAt: '2026-08-31T11:00:00.000Z',
  });
  assert.equal(full.paidCents, 48600);
  assert.equal(full.status, '已付款');
  const overpaid = planDriverPayment({
    payable: 486, paid: 200, log: partial.log, requestId: secondId, amountCents: 29000,
    paidAt: '2026-08-31T11:00:00.000Z',
  });
  assert.equal(overpaid.paidCents, 49000);
  assert.equal(overpaid.differenceCents, 400);
  assert.equal(overpaid.status, '超付');
});

test('customer receipt plans support deposits, full settlement and duplicate protection', () => {
  const firstId = 'recv_0123456789abcdef0123456789abcdef';
  const secondId = 'recv_fedcba9876543210fedcba9876543210';
  assert.equal(validateOrderPaymentRequestId(firstId), firstId);
  assert.throws(() => validateOrderPaymentRequestId('pay_0123456789abcdef0123456789abcdef'), /request-id-invalid/);
  const deposit = planOrderPayment({
    total: 3000, received: 0, log: '', requestId: firstId, amountCents: 100000,
    paidAt: '2026-08-31T10:00:00.000Z',
  });
  assert.equal(deposit.receivedCents, 100000);
  assert.equal(deposit.outstandingCents, 200000);
  assert.equal(deposit.status, 'Partially Paid');
  const duplicate = planOrderPayment({
    total: 3000, received: 1000, log: deposit.log, requestId: firstId, amountCents: 100000,
    paidAt: '2026-08-31T10:00:01.000Z',
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.receivedCents, 100000);
  const full = planOrderPayment({
    total: 3000, received: 1000, log: deposit.log, requestId: secondId, amountCents: 200000,
    paidAt: '2026-08-31T11:00:00.000Z',
  });
  assert.equal(full.receivedCents, 300000);
  assert.equal(full.outstandingCents, 0);
  assert.equal(full.status, 'Paid');
  assert.throws(() => planOrderPayment({
    total: 3000, received: 1000, log: deposit.log, requestId: secondId, amountCents: 200001,
    paidAt: '2026-08-31T11:00:00.000Z',
  }), /exceeds-outstanding/);
});

test('official Google activity is allocated to cost month, never later payment month', () => {
  const may = resolveMarketingFinanceMonth({ Month: '2026-05', 'Spend Date': '2026-05-31', 'Spend Amount HKD': 959.48 });
  const june = resolveMarketingFinanceMonth({ Month: '2026-06', 'Spend Date': '2026-08-15', 'Spend Amount HKD': 1213.14 });
  const july = resolveMarketingFinanceMonth({ Month: '2026-07', 'Spend Date': '2026-07-31', 'Spend Amount HKD': 445.43 });
  assert.deepEqual([may, june, july], ['2026-05', '2026-06', '2026-07']);
});

test('August revenue and costs include six received Orders and exclude the unpaid Invoice', () => {
  const augustOrders = [
    { no: 'AUG2601', final: 13150.36, supplier: 5152, china: 0, driver: 1800, profit: 6198.36 },
    { no: 'AUG2602', final: 1645.8, supplier: 700, china: 135.42, driver: 216, profit: 594.38 },
    { no: 'AUG2603', final: 1299.959655, supplier: 516, china: 0, driver: 144, profit: 639.959655 },
    { no: 'AUG2604', final: 413.98689, supplier: 48, china: 0, driver: 90, profit: 275.98689 },
    { no: 'AUG2605', final: 1924.36, supplier: 0, china: 0, driver: 216, profit: 1708.36 },
    { no: 'AUG2606', final: 8873.177229, supplier: 0, china: 0, driver: 1260, profit: 7613.177229 },
    { no: 'AUG2607', final: 2593.02, supplier: 0, china: 0, driver: 261, profit: 2332.02 },
  ];
  const summary = calculateOwnerFinanceSummary({
    ...baseOptions,
    getOutstandingFinanceStatus: fields => fields['Internal 1 Order No'] === 'AUG2602'
      ? null
      : '⏳ 尚欠成本',
    orders: augustOrders.map(order => record(order.no, {
      'Internal 1 Order No': order.no,
      'Final Amount': order.final,
      'Amount Received HKD': order.no === 'AUG2606' ? 0 : order.final,
      'Status': order.no === 'AUG2606' ? 'Unpaid' : 'Paid',
      'Supplier Cost Used HKD': order.supplier,
      'China Freight Used HKD': order.china,
      driverPayable: order.driver,
    })),
    marketing: [],
    expenses: [],
  });
  assert.equal(summary.confirmedOrders.length, 6);
  assert.equal(summary.receivableOrders.length, 1);
  assert.equal(summary.pendingCostOrders, 6);
  assert.ok(Math.abs(summary.revenue - 21027.486545) < 1e-9);
  assert.equal(summary.outstandingRevenue, 8873.18);
  assert.ok(Math.abs(summary.deliveryPayable - 2727) < 1e-9);
  assert.ok(Math.abs(summary.orderCosts - 9278.42) < 1e-9);
  assert.ok(Math.abs(summary.orderGrossProfit - 11749.066545) < 1e-9);
});

test('AUG2601 breakdown keeps quoted reserves separate and marks missing China freight as provisional', () => {
  const order = record('aug2601', {
    'Internal 1 Order No': 'AUG2601',
    'Source Quote Ref': 'QT-2026-0178',
    'Status': 'Paid',
    'Amount Received HKD': 13150.36,
    'Final Amount': 13150.36,
    'Discount Value HKD': 500,
    'Actual Supplier Cost HKD': 5152,
  });
  const items = [619, 493, 535, 913, 619, 525, 535, 913].map((supplier, index) => record(`item-${index}`, {
    'Quoted Profit HKD': 500,
    'Quoted China Freight HKD': 150,
    'Quoted Local Delivery HKD': 250,
    'Supplier Cost HKD': supplier,
  }));
  const breakdown = calculateOwnerOrderCostBreakdown({
    order,
    items,
    driverPayable: 1800,
    outstandingFinanceStatus: '⏳ 未有中國運費',
  });

  assert.equal(breakdown.sourceQuoteRef, 'QT-2026-0178');
  assert.equal(breakdown.itemCount, 8);
  assert.equal(breakdown.quotedProfit, 4000);
  assert.equal(breakdown.quoteDiscount, 500);
  assert.equal(breakdown.quotedChinaFreight, 1200);
  assert.equal(breakdown.quotedLocalDelivery, 2000);
  assert.equal(breakdown.actualSupplier, 5152);
  assert.equal(breakdown.actualChinaFreight, 0);
  assert.equal(breakdown.driverPayable, 1800);
  assert.ok(Math.abs((breakdown.provisionalActualProfit || 0) - 6198.36) < 1e-9);
  assert.ok(Math.abs((breakdown.quotedReserveProfit || 0) - 4998.36) < 1e-9);
  assert.equal(breakdown.final, false);
  assert.equal(breakdown.chinaFreightEntered, false);
  assert.ok(breakdown.warnings.some(value => value.includes('只係上限')));
});

test('supplier coverage reports entered records separately from pending records', () => {
  const breakdowns = Array.from({ length: 7 }, (_, index) => calculateOwnerOrderCostBreakdown({
    order: record(`order-${index}`, {
      'Internal 1 Order No': `AUG260${index + 1}`,
      'Status': index === 5 ? 'Unpaid' : 'Paid',
      'Amount Received HKD': index === 5 ? 0 : 1000,
      'Actual Supplier Cost HKD': index < 4 ? 100 : undefined,
      'Actual China Freight HKD': index === 1 ? 50 : undefined,
    }),
    items: [],
    driverPayable: 0,
  }));
  assert.deepEqual(summarizeOwnerOrderCostCoverage(breakdowns), {
    orderCount: 7,
    supplierEntered: 4,
    supplierPending: 3,
    chinaFreightEntered: 1,
    chinaFreightPending: 6,
  });
});

test('only explicit actual receipts or fully evidenced legacy payments count as revenue', () => {
  assert.equal(getOrderAmountReceived({
    Status: 'Unpaid', 'Final Amount': 8873.177229,
  }), 0);
  assert.equal(getOrderOutstandingAmount({
    Status: 'Unpaid', 'Final Amount': 8873.177229,
  }), 8873.18);
  assert.equal(getOrderAmountReceived({
    Status: 'Paid', 'Final Amount': 3000, 'Amount Received HKD': 1000,
  }), 1000);
  assert.equal(getOrderOutstandingAmount({
    Status: 'Paid', 'Final Amount': 3000, 'Amount Received HKD': 1000,
  }), 2000);
  assert.equal(getOrderAmountReceived({
    Status: 'Paid', 'Final Amount': 3000, 'Pay Date': '2026-08-31', 'Receipt Number': 'RCPT-1',
  }), 3000);
  assert.equal(getOrderAmountReceived({
    Status: 'Paid', 'Final Amount': 3000, 'Pay Date': '2026-08-31', Attachments: [{ id: 'invoice' }],
  }), 0, 'generic invoice attachments are not payment evidence');
  assert.equal(getOrderAmountReceived({
    Status: 'Cancelled', 'Final Amount': 3000, 'Amount Received HKD': 3000,
  }), 0);
});
