export type AggregateRecord = {
  id: string;
  fields: Record<string, unknown>;
};

export type PurchaseCycleAggregateInput = {
  from: string;
  to: string;
  generatedAt?: Date | string;
  inquiries: readonly AggregateRecord[];
  quotes: readonly AggregateRecord[];
  orders: readonly AggregateRecord[];
};

export type PurchaseCycleAggregate = {
  schema_version: 'lks-purchase-cycle-aggregate-v1';
  from: string;
  to: string;
  timezone: 'Asia/Hong_Kong';
  generated_at_hkt: string;
  inquiries_new_cycle_captured: number;
  quoted_cycles: number | null;
  linked_quoted_cycles: number;
  won_cycles: number;
  unlinked_quotes: number;
  deduped_quotes: number;
  error_count: number;
  source_counts: Record<AttributionCategory, number>;
  measurement_state: 'connected' | 'incomplete_linkage';
  coverage_note: string;
  source_system: 'Quote/Delivery aggregate';
};

export type AttributionCategory = 'paid' | 'organic' | 'direct' | '3d' | 'other' | 'unknown';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const dateOnly = (value: unknown): string => {
  const raw = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : '';
};

const dateValue = (value: string): number => Date.parse(`${value}T00:00:00Z`);

export const validateAggregateDateRange = (from: unknown, to: unknown): { from: string; to: string } => {
  const normalizedFrom = String(from ?? '').trim();
  const normalizedTo = String(to ?? '').trim();
  if (!ISO_DATE.test(normalizedFrom) || !ISO_DATE.test(normalizedTo)) {
    throw new Error('invalid-date-range');
  }
  const start = dateValue(normalizedFrom);
  const end = dateValue(normalizedTo);
  const days = Math.floor((end - start) / 86_400_000);
  if (!Number.isFinite(start) || !Number.isFinite(end) || days < 0 || days > 366) {
    throw new Error('invalid-date-range');
  }
  return { from: normalizedFrom, to: normalizedTo };
};

const inRange = (value: unknown, from: string, to: string): boolean => {
  const normalized = dateOnly(value);
  return Boolean(normalized && normalized >= from && normalized <= to);
};

const linkedIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (typeof item === 'string' && item.trim()) return [item.trim()];
    if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
      return [String((item as { id: string }).id).trim()].filter(Boolean);
    }
    return [];
  });
};

const paidStatus = (value: unknown): boolean => {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'paid' || normalized === '已付款' || normalized === '已收款';
};

const SOURCE_CATEGORY_ALLOWLIST: Readonly<Record<Exclude<AttributionCategory, 'unknown'>, readonly string[]>> = {
  paid: ['paid', 'google ads', 'meta ads', 'google/cpc', 'cpc'],
  organic: ['organic', 'google organic', 'organic search', 'seo'],
  direct: ['direct', 'walk-in', 'walk in'],
  '3d': ['3d', 'configurator', '3d configurator'],
  other: ['other', '其他', 'referral', 'instagram', 'facebook'],
};

export const classifyTrustedInquirySource = (value: unknown): AttributionCategory => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return 'unknown';
  for (const [category, choices] of Object.entries(SOURCE_CATEGORY_ALLOWLIST)) {
    if (choices.includes(normalized)) return category as AttributionCategory;
  }
  return 'unknown';
};

const generatedAtHkt = (value: Date | string | undefined): string => {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (!Number.isFinite(date.getTime())) throw new Error('invalid-generated-at');
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${shifted.toISOString().slice(0, 19)}+08:00`;
};

export const buildPurchaseCycleAggregate = (
  input: PurchaseCycleAggregateInput,
): PurchaseCycleAggregate => {
  const { from, to } = validateAggregateDateRange(input.from, input.to);
  let errorCount = 0;

  const inquiriesInRange = input.inquiries.filter(record => {
    const raw = record.fields['Inquiry Date'];
    if (raw && !dateOnly(raw)) errorCount += 1;
    return inRange(raw, from, to);
  });
  const sourceCounts: Record<AttributionCategory, number> = {
    paid: 0,
    organic: 0,
    direct: 0,
    '3d': 0,
    other: 0,
    unknown: 0,
  };
  for (const inquiry of inquiriesInRange) {
    sourceCounts[classifyTrustedInquirySource(inquiry.fields['Channel'])] += 1;
  }

  const quotesInRange = input.quotes.filter(record => {
    const raw = record.fields['Quote Date'];
    if (raw && !dateOnly(raw)) errorCount += 1;
    return inRange(raw, from, to);
  });
  const linkedInquiryIds = new Set<string>();
  let unlinkedQuotes = 0;
  for (const quote of quotesInRange) {
    const ids = Array.from(new Set(linkedIds(quote.fields['Inquiry'])));
    if (!ids.length) unlinkedQuotes += 1;
    ids.forEach(id => linkedInquiryIds.add(id));
  }

  const wonCycles = input.orders.filter(record => {
    const raw = record.fields['Pay Date'];
    if (raw && !dateOnly(raw)) errorCount += 1;
    return paidStatus(record.fields['Status']) && inRange(raw, from, to);
  }).length;

  const linkedQuotedCycles = linkedInquiryIds.size;
  const dedupedQuotes = Math.max(0, quotesInRange.length - unlinkedQuotes - linkedQuotedCycles);
  const incomplete = unlinkedQuotes > 0;

  return {
    schema_version: 'lks-purchase-cycle-aggregate-v1',
    from,
    to,
    timezone: 'Asia/Hong_Kong',
    generated_at_hkt: generatedAtHkt(input.generatedAt),
    inquiries_new_cycle_captured: inquiriesInRange.length,
    quoted_cycles: incomplete ? null : linkedQuotedCycles,
    linked_quoted_cycles: linkedQuotedCycles,
    won_cycles: wonCycles,
    unlinked_quotes: unlinkedQuotes,
    deduped_quotes: dedupedQuotes,
    error_count: errorCount,
    source_counts: sourceCounts,
    measurement_state: incomplete ? 'incomplete_linkage' : 'connected',
    coverage_note: incomplete
      ? '同一Inquiry多份Quote已去重；存在未連Inquiry的Quote，因此quoted_cycles保持unknown，舊資料不作猜測配對。'
      : '同一Inquiry多份Quote只計一個週期；完成購買後的新Inquiry由capture流程另開週期。',
    source_system: 'Quote/Delivery aggregate',
  };
};
