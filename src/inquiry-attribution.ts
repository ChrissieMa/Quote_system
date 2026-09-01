export type InquiryAttributionCandidate = {
  id: string;
  inquiryDate: string;
  createdTime?: string;
  lastActivityDate?: string;
  phone: string;
  customerIds: string[];
  status?: string;
  orderIds?: string[];
};

export type InquiryCycleOptions = {
  asOfDate: string;
  inactivityDays?: number;
  preferredInquiryId?: string;
};

export const DEFAULT_INQUIRY_CYCLE_INACTIVITY_DAYS = 30;

export const INQUIRY_PRODUCT_INTEREST_OPTIONS = [
  'Display Box',
  'Display Case',
  'Ready Stock',
  'Reissue',
  'Other',
] as const;

export type InquiryProductInterest = typeof INQUIRY_PRODUCT_INTEREST_OPTIONS[number];

const QUOTE_ITEM_TYPE_TO_PRODUCT_INTEREST: Record<string, InquiryProductInterest> = {
  'Display box 展示盒': 'Display Box',
  'Display Box': 'Display Box',
  'Display Case 疊高展示櫃': 'Display Case',
  'Display Case': 'Display Case',
  'Ready Stock': 'Ready Stock',
  'Reissue': 'Reissue',
  '階梯': 'Other',
  'Other': 'Other',
};

/**
 * Airtable's Product Interest is a locked single-select. Quote item labels are
 * bilingual UI values, so never pass them through or ask Airtable to create a
 * new option. Unknown/future product labels fail safely into the existing
 * non-identifying Other bucket.
 */
export const mapQuoteItemTypeToInquiryProductInterest = (
  value: unknown,
): InquiryProductInterest => QUOTE_ITEM_TYPE_TO_PRODUCT_INTEREST[String(value ?? '').trim()] || 'Other';

const normalizedDate = (value: string): string => {
  const trimmed = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(trimmed) ? trimmed.slice(0, 10) : '';
};

const dateValue = (value: string): number => {
  const normalized = normalizedDate(value);
  return normalized ? Date.parse(`${normalized}T00:00:00Z`) : Number.NaN;
};

export const resolveInquiryCycleInactivityDays = (value: unknown): number => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 3650
    ? parsed
    : DEFAULT_INQUIRY_CYCLE_INACTIVITY_DAYS;
};

const CLOSED_INQUIRY_STATUSES = new Set([
  'converted',
  'completed',
  'closed',
  'won',
  'successful',
  'order confirmed',
  '已成交',
  '已完成',
  '訂單確認',
]);

export const isInquiryCycleClosed = (candidate: InquiryAttributionCandidate): boolean => {
  const status = String(candidate.status || '').trim().toLowerCase();
  return Boolean(candidate.orderIds?.length) || CLOSED_INQUIRY_STATUSES.has(status);
};

export const isInquiryCycleActive = (
  candidate: InquiryAttributionCandidate,
  asOfDate: string,
  inactivityDays: number,
): boolean => {
  if (isInquiryCycleClosed(candidate)) return false;
  const activityAt = dateValue(candidate.lastActivityDate || candidate.inquiryDate);
  const currentAt = dateValue(asOfDate);
  if (!Number.isFinite(activityAt) || !Number.isFinite(currentAt)) return false;
  const elapsedDays = Math.floor((currentAt - activityAt) / 86_400_000);
  return elapsedDays >= 0 && elapsedDays <= inactivityDays;
};

const identityMatches = (
  candidates: InquiryAttributionCandidate[],
  normalizedPhone: string,
  customerId: string,
): InquiryAttributionCandidate[] => {
  if (customerId) {
    const linkedCustomerMatches = candidates.filter(candidate => candidate.customerIds.includes(customerId));
    if (linkedCustomerMatches.length) return linkedCustomerMatches;
    return candidates.filter(candidate => (
      candidate.customerIds.length === 0
      && Boolean(normalizedPhone)
      && candidate.phone === normalizedPhone
    ));
  }
  return candidates.filter(candidate => Boolean(normalizedPhone) && candidate.phone === normalizedPhone);
};

export const selectCanonicalInquiry = (
  candidates: InquiryAttributionCandidate[],
  normalizedPhone: string,
  customerId = '',
  options: InquiryCycleOptions,
): InquiryAttributionCandidate | null => {
  const inactivityDays = resolveInquiryCycleInactivityDays(options.inactivityDays);
  const matching = identityMatches(candidates, normalizedPhone, customerId)
    .filter(candidate => isInquiryCycleActive(candidate, options.asOfDate, inactivityDays));

  const preferred = matching.find(candidate => candidate.id === options.preferredInquiryId);
  if (preferred) return preferred;

  matching.sort((left, right) => {
    const leftDate = normalizedDate(left.inquiryDate) || '9999-12-31';
    const rightDate = normalizedDate(right.inquiryDate) || '9999-12-31';
    const dateOrder = leftDate.localeCompare(rightDate);
    const createdOrder = String(left.createdTime || '').localeCompare(String(right.createdTime || ''));
    return dateOrder || createdOrder || left.id.localeCompare(right.id);
  });
  return matching[0] || null;
};

export const firstTouchValue = (activeCycleValue: unknown, currentCycleValue: unknown): string =>
  String(activeCycleValue ?? '').trim() || String(currentCycleValue ?? '').trim();

export const linkedRecordIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (typeof item === 'string' && item.trim()) return [item.trim()];
    if (item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string') {
      return [String((item as { id: string }).id)];
    }
    return [];
  });
};

export const appendLinkedRecordId = (value: unknown, recordId: string): string[] =>
  Array.from(new Set([...linkedRecordIds(value), recordId].filter(Boolean)));
