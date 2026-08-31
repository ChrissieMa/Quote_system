import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendDriverPaymentLog,
  calculateOwnerFinanceSummary,
  getMacbookInstallmentNumber,
  getDriverSettlement,
  parseDriverPaymentAmountCents,
  planDriverPayment,
  paymentLogHasRequest,
  resolveMarketingFinanceMonth,
  validateDriverPaymentRequestId,
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
    payableCents: 48600, paidCents: 0, outstandingCents: 48600, status: '未付款',
  });
  assert.deepEqual(getDriverSettlement(486, 200), {
    payableCents: 48600, paidCents: 20000, outstandingCents: 28600, status: '部分付款',
  });
  assert.deepEqual(getDriverSettlement(486, 486), {
    payableCents: 48600, paidCents: 48600, outstandingCents: 0, status: '已付清',
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
  assert.equal(full.status, '已付清');
  assert.throws(() => planDriverPayment({
    payable: 486, paid: 200, log: partial.log, requestId: secondId, amountCents: 28601,
    paidAt: '2026-08-31T11:00:00.000Z',
  }), /overpay/);
});

test('official Google activity is allocated to cost month, never later payment month', () => {
  const may = resolveMarketingFinanceMonth({ Month: '2026-05', 'Spend Date': '2026-05-31', 'Spend Amount HKD': 959.48 });
  const june = resolveMarketingFinanceMonth({ Month: '2026-06', 'Spend Date': '2026-08-15', 'Spend Amount HKD': 1213.14 });
  const july = resolveMarketingFinanceMonth({ Month: '2026-07', 'Spend Date': '2026-07-31', 'Spend Amount HKD': 445.43 });
  assert.deepEqual([may, june, july], ['2026-05', '2026-06', '2026-07']);
});

test('seven August orders use Driver Payable and sum to the provisional monthly gross profit', () => {
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
    orders: augustOrders.map(order => record(order.no, {
      'Internal 1 Order No': order.no,
      'Final Amount': order.final,
      'Supplier Cost Used HKD': order.supplier,
      'China Freight Used HKD': order.china,
      driverPayable: order.driver,
    })),
    marketing: [],
    expenses: [],
  });
  const actualProfits = augustOrders.map(order =>
    order.final - order.supplier - order.china - order.driver,
  );
  actualProfits.forEach((profit, index) => {
    assert.ok(Math.abs(profit - augustOrders[index].profit) < 1e-9, augustOrders[index].no);
  });
  assert.ok(Math.abs(summary.orderGrossProfit - 19362.243774) < 1e-9);
});
