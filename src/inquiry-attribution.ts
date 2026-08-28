export type InquiryAttributionCandidate = {
  id: string;
  inquiryDate: string;
  phone: string;
  customerIds: string[];
};

const normalizedDate = (value: string): string => {
  const trimmed = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(trimmed) ? trimmed.slice(0, 10) : '9999-12-31';
};

export const selectCanonicalInquiry = (
  candidates: InquiryAttributionCandidate[],
  normalizedPhone: string,
  customerId = '',
): InquiryAttributionCandidate | null => {
  const matching = candidates.filter(candidate => {
    if (customerId && candidate.customerIds.includes(customerId)) return true;
    return Boolean(normalizedPhone) && candidate.phone === normalizedPhone;
  });
  matching.sort((left, right) => {
    const dateOrder = normalizedDate(left.inquiryDate).localeCompare(normalizedDate(right.inquiryDate));
    return dateOrder || left.id.localeCompare(right.id);
  });
  return matching[0] || null;
};

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
