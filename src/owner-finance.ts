export type OwnerFinanceFields = Record<string, unknown>;

export type OwnerFinanceRecord = {
  id: string;
  fields: OwnerFinanceFields;
};

export type OwnerFinanceSummary = {
  monthOrders: OwnerFinanceRecord[];
  confirmedOrders: OwnerFinanceRecord[];
  receivableOrders: OwnerFinanceRecord[];
  cancelledOrders: OwnerFinanceRecord[];
  allocatedMarketing: OwnerFinanceRecord[];
  unallocatedMarketing: OwnerFinanceRecord[];
  operatingExpenses: OwnerFinanceRecord[];
  capitalItems: OwnerFinanceRecord[];
  revenue: number;
  issuedInvoiceTotal: number;
  outstandingRevenue: number;
  supplier: number;
  china: number;
  deliveryPayable: number;
  deliveryPaid: number;
  reissue: number;
  pendingCostOrders: number;
  adOrders: number;
  orderCosts: number;
  orderGrossProfit: number;
  cashOrderCosts: number;
  cashOrderGrossProfit: number;
  marketingSpend: number;
  unallocatedMarketingSpend: number;
  businessExpenses: number;
  capitalItemsTotal: number;
  netProfit: number;
  cashNetProfit: number;
  margin: number;
  provisional: boolean;
};

export type OwnerOrderCostBreakdown = {
  orderNo: string;
  sourceQuoteRef: string;
  itemCount: number;
  received: number;
  quotedProfit: number;
  quoteDiscount: number;
  quotedChinaFreight: number;
  quotedLocalDelivery: number;
  actualSupplier: number;
  actualChinaFreight: number;
  driverPayable: number;
  driverPaid: number;
  reissue: number;
  cashProfit: number | null;
  provisionalActualProfit: number | null;
  quotedReserveProfit: number | null;
  supplierEntered: boolean;
  chinaFreightEntered: boolean;
  final: boolean;
  warnings: string[];
};

export type OwnerOrderCostCoverage = {
  orderCount: number;
  supplierEntered: number;
  supplierPending: number;
  chinaFreightEntered: number;
  chinaFreightPending: number;
};

type SummaryOptions = {
  month: string;
  orders: readonly OwnerFinanceRecord[];
  marketing: readonly OwnerFinanceRecord[];
  expenses: readonly OwnerFinanceRecord[];
  getOrderMonth: (fields: OwnerFinanceFields) => string | null;
  getDriverPayable: (fields: OwnerFinanceFields) => number;
  getDriverPaid?: (record: OwnerFinanceRecord) => number;
  getOutstandingFinanceStatus: (fields: OwnerFinanceFields) => string | null;
};

const VALID_MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;

export const MACBOOK_INSTALLMENT_EXPENSE_NAME = 'Apple MacBook Pro — monthly instalment';
export const MACBOOK_INSTALLMENT_START_MONTH = '2026-08';
export const MACBOOK_INSTALLMENT_COUNT = 24;

const monthIndex = (month: string): number | null => {
  if (!VALID_MONTH.test(month)) return null;
  const [year, monthNumber] = month.split('-').map(Number);
  return (year * 12) + monthNumber - 1;
};

export const getMacbookInstallmentNumber = (month: string): number | null => {
  const current = monthIndex(month);
  const start = monthIndex(MACBOOK_INSTALLMENT_START_MONTH);
  if (current === null || start === null) return null;
  const installment = current - start + 1;
  return installment >= 1 && installment <= MACBOOK_INSTALLMENT_COUNT ? installment : null;
};

const numberField = (fields: OwnerFinanceFields, name: string): number => {
  const value = Number(fields[name] || 0);
  return Number.isFinite(value) ? value : 0;
};

const firstPositiveField = (fields: OwnerFinanceFields, names: readonly string[]): number => {
  for (const name of names) {
    const value = numberField(fields, name);
    if (value > 0) return value;
  }
  return 0;
};

const sumItemField = (items: readonly OwnerFinanceRecord[], names: readonly string[]): number =>
  items.reduce((sum, item) => sum + firstPositiveField(item.fields, names), 0);

const normalizedOrderStatus = (fields: OwnerFinanceFields): string =>
  String(fields['Status'] || '').trim().toLowerCase();

export const isCancelledOrder = (fields: OwnerFinanceFields): boolean =>
  /^(?:cancelled|canceled|void|refunded|取消|已取消|作廢)$/.test(normalizedOrderStatus(fields));

export const hasOrderPaymentEvidence = (fields: OwnerFinanceFields): boolean => {
  const attachments = fields['Payment Evidence'];
  const hasAttachment = Array.isArray(attachments) && attachments.length > 0;
  const receiptNumber = String(fields['Receipt Number'] || fields['Receipt No'] || '').trim();
  return hasAttachment || Boolean(receiptNumber);
};

export const getOrderAmountReceived = (fields: OwnerFinanceFields): number => {
  if (isCancelledOrder(fields) || ['unpaid', '未付款'].includes(normalizedOrderStatus(fields))) return 0;

  const explicit = fields['Amount Received HKD'];
  if (explicit !== undefined && explicit !== null && String(explicit).trim() !== '') {
    const amount = Number(explicit);
    return Number.isFinite(amount) && amount > 0 ? amount : 0;
  }

  // Safe legacy bridge: historic fully-paid Orders can use Final Amount only
  // when all three independent payment signals exist. An Invoice or a generic
  // attachment alone is never payment evidence.
  const paid = ['paid', '已付款'].includes(normalizedOrderStatus(fields));
  const payDate = String(fields['Pay Date'] || '').trim();
  return paid && payDate && hasOrderPaymentEvidence(fields)
    ? numberField(fields, 'Final Amount')
    : 0;
};

export const getOrderOutstandingAmount = (fields: OwnerFinanceFields): number => {
  if (isCancelledOrder(fields)) return 0;
  return Math.max(
    0,
    toHkdCents(numberField(fields, 'Final Amount')) - toHkdCents(getOrderAmountReceived(fields)),
  ) / 100;
};

export const calculateOwnerOrderCostBreakdown = (input: {
  order: OwnerFinanceRecord;
  items: readonly OwnerFinanceRecord[];
  driverPayable: number;
  driverPaid?: number;
  outstandingFinanceStatus?: string | null;
}): OwnerOrderCostBreakdown => {
  const fields = input.order.fields;
  const quotedProfit = sumItemField(input.items, ['Quoted Profit HKD'])
    || firstPositiveField(fields, ['Quoted Profit Total HKD']);
  const quotedChinaFreight = sumItemField(input.items, ['Quoted China Freight HKD'])
    || firstPositiveField(fields, ['Quoted China Freight Total HKD']);
  const quotedLocalDelivery = sumItemField(input.items, ['Quoted Local Delivery HKD'])
    || firstPositiveField(fields, ['Quoted Local Delivery Total HKD']);
  const actualSupplier = firstPositiveField(fields, [
    'Supplier Cost Used HKD', 'Actual Supplier Cost HKD', 'Cost',
  ]) || sumItemField(input.items, ['Supplier Cost HKD']);
  const actualChinaFreight = firstPositiveField(fields, [
    'China Freight Used HKD', 'Actual China Freight HKD', 'China Freight Cost HKD',
  ]) || sumItemField(input.items, ['China Freight Cost HKD', 'Actual China Freight HKD']);
  const reissue = numberField(fields, 'Actual Reissue Cost HKD');
  const received = getOrderAmountReceived(fields);
  const supplierEntered = actualSupplier > 0;
  const chinaFreightEntered = actualChinaFreight > 0;
  const outstandingFinanceStatus = String(input.outstandingFinanceStatus || '').trim();
  const driverPaid = Math.max(0, Number(input.driverPaid || 0));
  const warnings: string[] = [];
  if (!supplierEntered) warnings.push('未有小糖成本');
  if (!chinaFreightEntered) warnings.push('未有實際中國運費，暫計盈利只係上限');
  if (input.driverPayable > driverPaid) warnings.push('香港運費未全數實付，應付部分唔扣現金淨利');
  if (outstandingFinanceStatus) warnings.push(outstandingFinanceStatus);
  if (received <= 0) warnings.push('未收款，唔計入收入、毛利或淨利');

  const provisionalActualProfit = received > 0
    ? received - actualSupplier - actualChinaFreight - input.driverPayable - reissue
    : null;
  const cashProfit = received > 0
    ? received - actualSupplier - actualChinaFreight - driverPaid - reissue
    : null;
  const quotedReserveProfit = provisionalActualProfit !== null
    && !chinaFreightEntered
    && quotedChinaFreight > 0
    ? provisionalActualProfit - quotedChinaFreight
    : null;

  return {
    orderNo: String(fields['Internal 1 Order No'] || fields['Internal Order No'] || input.order.id),
    sourceQuoteRef: String(fields['Source Quote Ref'] || ''),
    itemCount: input.items.length,
    received,
    quotedProfit,
    quoteDiscount: numberField(fields, 'Discount Value HKD')
      || numberField(fields, 'Discount Amount HKD'),
    quotedChinaFreight,
    quotedLocalDelivery,
    actualSupplier,
    actualChinaFreight,
    driverPayable: input.driverPayable,
    driverPaid,
    reissue,
    cashProfit,
    provisionalActualProfit,
    quotedReserveProfit,
    supplierEntered,
    chinaFreightEntered,
    final: received > 0
      && supplierEntered
      && chinaFreightEntered
      && driverPaid >= input.driverPayable
      && !outstandingFinanceStatus,
    warnings: Array.from(new Set(warnings)),
  };
};

export const summarizeOwnerOrderCostCoverage = (
  breakdowns: readonly OwnerOrderCostBreakdown[],
): OwnerOrderCostCoverage => {
  const supplierEntered = breakdowns.filter(item => item.supplierEntered).length;
  const chinaFreightEntered = breakdowns.filter(item => item.chinaFreightEntered).length;
  return {
    orderCount: breakdowns.length,
    supplierEntered,
    supplierPending: breakdowns.length - supplierEntered,
    chinaFreightEntered,
    chinaFreightPending: breakdowns.length - chinaFreightEntered,
  };
};

const isCountablePayment = (fields: OwnerFinanceFields): boolean => {
  const status = String(fields['Payment Status'] || 'Paid').trim().toLowerCase();
  return !['pending', 'refunded', 'cancelled'].includes(status);
};

export const resolveMarketingFinanceMonth = (fields: OwnerFinanceFields): string | null => {
  const explicitMonth = String(fields['Month'] || '').trim();
  if (explicitMonth) return VALID_MONTH.test(explicitMonth) ? explicitMonth : null;
  const spendDate = String(fields['Spend Date'] || '').trim();
  const fallbackMonth = spendDate.slice(0, 7);
  return VALID_MONTH.test(fallbackMonth) ? fallbackMonth : null;
};

export const isMarketingAllocationPending = (fields: OwnerFinanceFields): boolean => {
  const explicitMonth = String(fields['Month'] || '').trim();
  return Boolean(explicitMonth) && !VALID_MONTH.test(explicitMonth);
};

export const resolveBusinessExpenseMonth = (fields: OwnerFinanceFields): string | null => {
  const explicitMonth = String(fields['Month'] || '').trim();
  if (explicitMonth) return VALID_MONTH.test(explicitMonth) ? explicitMonth : null;
  const expenseDate = String(fields['Expense Date'] || '').trim();
  const fallbackMonth = expenseDate.slice(0, 7);
  return VALID_MONTH.test(fallbackMonth) ? fallbackMonth : null;
};

export const isCapitalBusinessExpense = (fields: OwnerFinanceFields): boolean => {
  const category = String(fields['Category'] || '').trim().toLowerCase();
  return /(?:^|[\s/|_-])(capital equipment|capital asset|fixed asset|資本項目|資本設備)(?:$|[\s/|_-])/.test(category);
};

export const calculateOwnerFinanceSummary = (options: SummaryOptions): OwnerFinanceSummary => {
  const monthOrders = options.orders.filter(record => options.getOrderMonth(record.fields) === options.month);
  const confirmedOrders = monthOrders.filter(record => getOrderAmountReceived(record.fields) > 0);
  const receivableOrders = monthOrders.filter(record => getOrderOutstandingAmount(record.fields) > 0);
  const cancelledOrders = monthOrders.filter(record => isCancelledOrder(record.fields));
  const allocatedMarketing = options.marketing.filter(record =>
    isCountablePayment(record.fields) && resolveMarketingFinanceMonth(record.fields) === options.month,
  );
  const unallocatedMarketing = options.marketing.filter(record => {
    if (!isCountablePayment(record.fields) || !isMarketingAllocationPending(record.fields)) return false;
    return String(record.fields['Spend Date'] || '').startsWith(options.month);
  });
  const monthExpenses = options.expenses.filter(record => resolveBusinessExpenseMonth(record.fields) === options.month);
  const capitalItems = monthExpenses.filter(record => isCapitalBusinessExpense(record.fields));
  const operatingExpenses = monthExpenses.filter(record => !isCapitalBusinessExpense(record.fields));

  const orderTotals = confirmedOrders.reduce((sum, record) => {
    const fields = record.fields;
    sum.revenue += getOrderAmountReceived(fields);
    sum.supplier += numberField(fields, 'Supplier Cost Used HKD')
      || numberField(fields, 'Actual Supplier Cost HKD')
      || numberField(fields, 'Cost');
    sum.china += numberField(fields, 'China Freight Used HKD')
      || numberField(fields, 'Actual China Freight HKD')
      || numberField(fields, 'China Freight Cost HKD');
    sum.deliveryPayable += options.getDriverPayable(fields);
    sum.deliveryPaid += Math.max(0, Number(options.getDriverPaid?.(record) || 0));
    sum.reissue += numberField(fields, 'Actual Reissue Cost HKD');
    if (fields['Is Ad Attributed Order'] || String(fields['Campaign / Source Detail'] || '').trim()) sum.adOrders += 1;
    return sum;
  }, {
    revenue: 0,
    supplier: 0,
    china: 0,
    deliveryPayable: 0,
    deliveryPaid: 0,
    reissue: 0,
    pendingCostOrders: 0,
    adOrders: 0,
  });
  orderTotals.pendingCostOrders = monthOrders
    .filter(record => !isCancelledOrder(record.fields))
    .filter(record => Boolean(options.getOutstandingFinanceStatus(record.fields)))
    .length;

  const issuedInvoiceTotal = monthOrders
    .filter(record => !isCancelledOrder(record.fields))
    .reduce((sum, record) => sum + numberField(record.fields, 'Final Amount'), 0);
  const outstandingRevenue = receivableOrders
    .reduce((sum, record) => sum + getOrderOutstandingAmount(record.fields), 0);

  const marketingSpend = allocatedMarketing.reduce(
    (sum, record) => sum + numberField(record.fields, 'Spend Amount HKD'), 0,
  );
  const unallocatedMarketingSpend = unallocatedMarketing.reduce(
    (sum, record) => sum + numberField(record.fields, 'Spend Amount HKD'), 0,
  );
  const businessExpenses = operatingExpenses.reduce(
    (sum, record) => sum + numberField(record.fields, 'Amount HKD'), 0,
  );
  const capitalItemsTotal = capitalItems.reduce(
    (sum, record) => sum + numberField(record.fields, 'Amount HKD'), 0,
  );
  const orderCosts = orderTotals.supplier + orderTotals.china + orderTotals.deliveryPayable + orderTotals.reissue;
  const orderGrossProfit = orderTotals.revenue - orderCosts;
  // Owner cash rule: amounts entered in the actual supplier / China fields are
  // payments. Driver payable remains a separate accrual and only the recorded
  // driver-paid amount affects the cash result.
  const cashOrderCosts = orderTotals.supplier + orderTotals.china + orderTotals.deliveryPaid + orderTotals.reissue;
  const cashOrderGrossProfit = orderTotals.revenue - cashOrderCosts;
  const netProfit = orderGrossProfit - marketingSpend - businessExpenses;
  const cashNetProfit = cashOrderGrossProfit - marketingSpend - businessExpenses;

  return {
    monthOrders,
    confirmedOrders,
    receivableOrders,
    cancelledOrders,
    allocatedMarketing,
    unallocatedMarketing,
    operatingExpenses,
    capitalItems,
    ...orderTotals,
    issuedInvoiceTotal,
    outstandingRevenue,
    orderCosts,
    orderGrossProfit,
    cashOrderCosts,
    cashOrderGrossProfit,
    marketingSpend,
    unallocatedMarketingSpend,
    businessExpenses,
    capitalItemsTotal,
    netProfit,
    cashNetProfit,
    margin: orderTotals.revenue > 0 ? (cashNetProfit / orderTotals.revenue) * 100 : 0,
    provisional: orderTotals.pendingCostOrders > 0,
  };
};

export type DriverSettlement = {
  payableCents: number;
  paidCents: number;
  outstandingCents: number;
  overpaidCents: number;
  differenceCents: number;
  status: '未付款' | '部分付款' | '已付款' | '超付';
};

export const toHkdCents = (value: unknown): number => {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100);
};

export const getDriverSettlement = (payable: unknown, paid: unknown): DriverSettlement => {
  const payableCents = Math.max(0, toHkdCents(payable));
  const paidCents = Math.max(0, toHkdCents(paid));
  const outstandingCents = Math.max(0, payableCents - paidCents);
  const overpaidCents = Math.max(0, paidCents - payableCents);
  const differenceCents = paidCents - payableCents;
  const status = paidCents <= 0
    ? '未付款'
    : paidCents < payableCents
      ? '部分付款'
      : paidCents === payableCents
        ? '已付款'
        : '超付';
  return { payableCents, paidCents, outstandingCents, overpaidCents, differenceCents, status };
};

export const paymentLogHasRequest = (log: unknown, requestId: string): boolean =>
  String(log || '').split(/\r?\n/).some(line => line.split('|')[1] === requestId);

export const paymentLogRequestAmountCents = (log: unknown, requestId: string): number | null => {
  const line = String(log || '').split(/\r?\n/).find(entry => entry.split('|')[1] === requestId);
  if (!line) return null;
  return toHkdCents(line.split('|')[3]);
};

export const validateDriverPaymentRequestId = (value: unknown): string => {
  const requestId = String(value || '').trim();
  if (!/^pay_[a-f0-9]{32}$/.test(requestId)) throw new Error('driver-payment-request-id-invalid');
  return requestId;
};

export const parseDriverPaymentAmountCents = (value: unknown): number => {
  const text = String(value ?? '').trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text)) throw new Error('driver-payment-amount-invalid');
  const cents = Math.round(Number(text) * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error('driver-payment-amount-invalid');
  return cents;
};

export const appendDriverPaymentLog = (
  log: unknown,
  requestId: string,
  paidAt: string,
  amountCents: number,
): string => {
  const current = String(log || '').trim();
  const entry = `PAYMENT|${requestId}|${paidAt}|${(amountCents / 100).toFixed(2)}`;
  return current ? `${current}\n${entry}` : entry;
};

export const planDriverPayment = (input: {
  payable: unknown;
  paid: unknown;
  log: unknown;
  requestId: string;
  amountCents: number;
  paidAt: string;
}): {
  duplicate: boolean;
  paidCents: number;
  differenceCents: number;
  status: DriverSettlement['status'];
  log: string;
} => {
  if (paymentLogHasRequest(input.log, input.requestId)) {
    if (paymentLogRequestAmountCents(input.log, input.requestId) !== input.amountCents) {
      throw new Error('driver-payment-request-conflict');
    }
    const current = getDriverSettlement(input.payable, input.paid);
    return {
      duplicate: true,
      paidCents: current.paidCents,
      differenceCents: current.differenceCents,
      status: current.status,
      log: String(input.log || ''),
    };
  }
  const current = getDriverSettlement(input.payable, input.paid);
  if (current.paidCents > current.payableCents) throw new Error('driver-payment-existing-overpay');
  const paidCents = current.paidCents + input.amountCents;
  const next = getDriverSettlement(input.payable, paidCents / 100);
  return {
    duplicate: false,
    paidCents,
    differenceCents: next.differenceCents,
    status: next.status,
    log: appendDriverPaymentLog(input.log, input.requestId, input.paidAt, input.amountCents),
  };
};

export const validateOrderPaymentRequestId = (value: unknown): string => {
  const requestId = String(value || '').trim();
  if (!/^recv_[a-f0-9]{32}$/.test(requestId)) throw new Error('order-payment-request-id-invalid');
  return requestId;
};

const appendOrderPaymentLog = (
  log: unknown,
  requestId: string,
  paidAt: string,
  amountCents: number,
  receivedCents: number,
): string => {
  const current = String(log || '').trim();
  const entry = `RECEIVED|${requestId}|${paidAt}|${(amountCents / 100).toFixed(2)}|${(receivedCents / 100).toFixed(2)}`;
  return current ? `${current}\n${entry}` : entry;
};

export const planOrderPayment = (input: {
  total: unknown;
  received: unknown;
  log: unknown;
  requestId: string;
  amountCents: number;
  paidAt: string;
}): {
  duplicate: boolean;
  receivedCents: number;
  outstandingCents: number;
  status: 'Partially Paid' | 'Paid';
  log: string;
} => {
  const totalCents = Math.max(0, toHkdCents(input.total));
  const currentReceivedCents = Math.max(0, toHkdCents(input.received));
  if (totalCents <= 0 || currentReceivedCents > totalCents) throw new Error('order-payment-state-invalid');
  if (paymentLogHasRequest(input.log, input.requestId)) {
    if (paymentLogRequestAmountCents(input.log, input.requestId) !== input.amountCents) {
      throw new Error('order-payment-request-conflict');
    }
    return {
      duplicate: true,
      receivedCents: currentReceivedCents,
      outstandingCents: totalCents - currentReceivedCents,
      status: currentReceivedCents >= totalCents ? 'Paid' : 'Partially Paid',
      log: String(input.log || ''),
    };
  }
  const receivedCents = currentReceivedCents + input.amountCents;
  if (receivedCents > totalCents) throw new Error('order-payment-exceeds-outstanding');
  return {
    duplicate: false,
    receivedCents,
    outstandingCents: totalCents - receivedCents,
    status: receivedCents === totalCents ? 'Paid' : 'Partially Paid',
    log: appendOrderPaymentLog(input.log, input.requestId, input.paidAt, input.amountCents, receivedCents),
  };
};
