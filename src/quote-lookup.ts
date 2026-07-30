export type QuoteLookupQuery =
  | { quoteNo: string }
  | { orderNo: string }
  | { phone: string }
  | { customer: string };

export type StoredQuoteRecord = {
  id: string;
  fields: Record<string, unknown>;
};

type LookupItem = {
  product: string;
  innerDimensionsCm: {
    length: string | null;
    depth: string | null;
    height: string | null;
  };
  quantity: number | null;
  quotedChinaFreightHkd: number | null;
  quotedLocalDeliveryHkd: number | null;
  quotedProfitHkd: number | null;
};

const PROFIT_BASIS =
  '報價時填寫的利潤／Quoted Profit；不是按實際成本重新計算的實際利潤／Actual Profit。';

const text = (value: unknown): string => String(value ?? '').trim();

const normalizedPhone = (value: unknown): string => {
  let digits = text(value).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('852')) digits = digits.slice(3);
  return digits;
};

const numberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || text(value) === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const dimensionOrNull = (value: unknown): string | null => {
  const result = text(value);
  return result === '' ? null : result;
};

const parseStoredItems = (raw: unknown): unknown[] => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'object') {
    const items = (raw as Record<string, unknown>).items;
    return Array.isArray(items) ? items : [];
  }
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.items)) return parsed.items;
    return [];
  } catch {
    return [];
  }
};

const mapStoredItem = (raw: unknown): LookupItem => {
  const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return {
    product: text(item.itemType) || '未記錄',
    innerDimensionsCm: {
      length: dimensionOrNull(item.interL),
      depth: dimensionOrNull(item.interD),
      height: dimensionOrNull(item.interH),
    },
    quantity: numberOrNull(item.qty),
    quotedChinaFreightHkd: numberOrNull(item.freight),
    quotedLocalDeliveryHkd: numberOrNull(
      item.hongKongDelivery ?? item.deliveryCostReserve ?? item.localDelivery,
    ),
    quotedProfitHkd: numberOrNull(item.profit),
  };
};

const quoteNo = (record: StoredQuoteRecord): string => text(record.fields['Quote Number']);
const orderNo = (record: StoredQuoteRecord): string => text(record.fields['Converted Order No']);
const customerName = (record: StoredQuoteRecord): string =>
  text(record.fields['Customer Name']) || text(record.fields['Contact Name']) || '未記錄';

const candidate = (record: StoredQuoteRecord) => ({
  quoteNo: quoteNo(record),
  quoteDate: text(record.fields['Quote Date']) || null,
  status: text(record.fields.Status) || null,
  customer: customerName(record),
  convertedOrderNo: orderNo(record) || null,
});

export const validateQuoteLookupQuery = (raw: unknown): QuoteLookupQuery => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Lookup requires one search field.');
  }
  const input = raw as Record<string, unknown>;
  const allowed = ['quoteNo', 'orderNo', 'phone', 'customer'] as const;
  const supplied = allowed.filter(key => text(input[key]) !== '');
  const unknown = Object.keys(input).filter(key => !allowed.includes(key as typeof allowed[number]));
  if (unknown.length > 0 || supplied.length !== 1) {
    throw new Error('Supply exactly one of quoteNo, orderNo, phone, or customer.');
  }
  const key = supplied[0];
  const value = text(input[key]);
  const maxLength = key === 'customer' ? 120 : 64;
  if (value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Lookup value is invalid.');
  }
  if (key === 'phone' && normalizedPhone(value).length < 4) {
    throw new Error('Phone lookup requires at least four digits.');
  }
  return { [key]: value } as QuoteLookupQuery;
};

const matchesQuery = (record: StoredQuoteRecord, query: QuoteLookupQuery): boolean => {
  if ('quoteNo' in query) {
    return quoteNo(record).toLocaleUpperCase() === query.quoteNo.toLocaleUpperCase();
  }
  if ('orderNo' in query) {
    return orderNo(record).toLocaleUpperCase() === query.orderNo.toLocaleUpperCase();
  }
  if ('phone' in query) {
    const wanted = normalizedPhone(query.phone);
    return [record.fields['Customer Phone'], record.fields.Phone]
      .some(value => normalizedPhone(value) === wanted);
  }
  return customerName(record).toLocaleLowerCase().includes(query.customer.toLocaleLowerCase());
};

const sortedMatches = (records: StoredQuoteRecord[]): StoredQuoteRecord[] =>
  [...records].sort((left, right) => {
    const byDate = text(right.fields['Quote Date']).localeCompare(text(left.fields['Quote Date']));
    return byDate || quoteNo(right).localeCompare(quoteNo(left));
  });

const detail = (record: StoredQuoteRecord) => {
  const rawItems = record.fields['Quote Items JSON'];
  const parsedItems = parseStoredItems(rawItems);
  const items = parsedItems.map(mapStoredItem);
  const missing: string[] = [];
  if (items.length === 0) missing.push('Items');
  items.forEach((item, index) => {
    if (item.quotedChinaFreightHkd === null) missing.push(`Item ${index + 1} Quoted China Freight`);
    if (item.quotedLocalDeliveryHkd === null) missing.push(`Item ${index + 1} Quoted Local Delivery`);
    if (item.quotedProfitHkd === null) missing.push(`Item ${index + 1} Quoted Profit`);
  });
  const finalTotal = numberOrNull(record.fields.Total);
  if (finalTotal === null) missing.push('Final Total');
  const profits = items.map(item => item.quotedProfitHkd);
  const quotedProfitTotalHkd = profits.length > 0 && profits.every(value => value !== null)
    ? (profits as number[]).reduce((sum, value) => sum + value, 0)
    : null;

  return {
    quoteNo: quoteNo(record),
    quoteDate: text(record.fields['Quote Date']) || null,
    status: text(record.fields.Status) || null,
    customer: customerName(record),
    items,
    quotedProfitTotalHkd,
    profitBasis: PROFIT_BASIS,
    finalTotalHkd: finalTotal,
    dataCompleteness: missing.length === 0
      ? { complete: true, missing: [] }
      : { complete: false, missing },
  };
};

export const lookupQuoteRecords = (
  records: StoredQuoteRecord[],
  rawQuery: unknown,
): Record<string, unknown> => {
  const query = validateQuoteLookupQuery(rawQuery);
  const matches = sortedMatches(records.filter(record => matchesQuery(record, query)));
  if (matches.length === 0) {
    return {
      result: 'not_found',
      readOnly: true,
      profitBasis: PROFIT_BASIS,
      matches: [],
    };
  }

  if (!('quoteNo' in query) || matches.length !== 1) {
    return {
      result: matches.length > 1 ? 'multiple_matches' : 'selection_required',
      readOnly: true,
      instruction: '請由 Chrissie 選擇準確 Quote No，再用 Quote No 查詢；不可自行猜測。',
      matches: matches.map(candidate),
    };
  }

  return {
    result: 'quote',
    readOnly: true,
    quote: detail(matches[0]),
  };
};
