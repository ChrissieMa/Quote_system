export type CustomerSearchResult = {
  source: 'customers' | 'legacy';
  id: string;
  display?: string;
  customerId?: string;
  name?: string;
  phone?: string;
  email?: string;
  address?: string;
  companyName?: string;
  alternatePhone?: string;
};

export type CustomerResolutionCandidate<T> = {
  source: 'legacy' | 'linked' | 'phone';
  record: T;
};

export const selectCustomerResolutionCandidate = <T>(
  legacyRecord: T | null,
  linkedRecord: T | null,
  phoneRecord: T | null,
): CustomerResolutionCandidate<T> | null => {
  if (legacyRecord) return { source: 'legacy', record: legacyRecord };
  if (linkedRecord) return { source: 'linked', record: linkedRecord };
  if (phoneRecord) return { source: 'phone', record: phoneRecord };
  return null;
};

export const normalizePhone = (value: unknown): string => {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('852')) digits = digits.slice(3);
  return digits;
};

export const extractCustomerId = (value: unknown): string => {
  const match = String(value ?? '').trim().toUpperCase().match(/(?:^|\b)L\s*0*(\d{1,4})(?:\b|$)/);
  return match ? `L${match[1].padStart(4, '0')}` : '';
};

export const selectCanonicalCustomerId = (
  legacyValue: unknown,
  existingValue: unknown,
  fallbackValue: unknown,
): string => extractCustomerId(legacyValue)
  || extractCustomerId(existingValue)
  || extractCustomerId(fallbackValue);

const hasValue = (value: unknown): boolean => String(value ?? '').trim().length > 0;

export const buildLegacyCustomerMergeFields = (
  existing: Record<string, unknown>,
  legacy: Record<string, unknown>,
): Record<string, unknown> => {
  const updates: Record<string, unknown> = {};
  const legacyCustomerId = extractCustomerId(legacy['Customer ID']);
  const existingCustomerId = extractCustomerId(existing['Customer ID']);

  if (legacyCustomerId && legacyCustomerId !== existingCustomerId) {
    updates['Customer ID'] = legacyCustomerId;
  }

  for (const field of [
    'Customer Name',
    'Phone',
    'Email',
    'Address',
    'Alternate Phone',
    'Company Name',
    'Legacy Notes',
  ]) {
    if (!hasValue(existing[field]) && hasValue(legacy[field])) {
      updates[field] = legacy[field];
    }
  }

  if (hasValue(legacy['Legacy Customer Ref'])) {
    updates['Legacy Customer Ref'] = legacy['Legacy Customer Ref'];
  }
  updates['Customer Status'] = 'Legacy Activated';
  return updates;
};

export const nonBlankCustomerUpdates = (
  fields: Record<string, unknown>,
): Record<string, unknown> => {
  const updates: Record<string, unknown> = {};
  for (const field of ['Customer Name', 'Phone', 'Email', 'Address']) {
    if (hasValue(fields[field])) updates[field] = fields[field];
  }
  return updates;
};

export const reconcileCustomerSearchResults = (
  officialResults: CustomerSearchResult[],
  legacyResults: CustomerSearchResult[],
): CustomerSearchResult[] => {
  const legacyPhones = new Set(
    legacyResults.map(result => normalizePhone(result.phone)).filter(Boolean),
  );
  const unmatchedOfficial = officialResults.filter(result => {
    const phone = normalizePhone(result.phone);
    return !phone || !legacyPhones.has(phone);
  });

  const reconciledLegacy = legacyResults.map(legacy => {
    const phone = normalizePhone(legacy.phone);
    const official = phone
      ? officialResults.find(result => normalizePhone(result.phone) === phone)
      : undefined;
    if (!official) return legacy;
    return {
      ...legacy,
      name: official.name || legacy.name,
      email: official.email || legacy.email,
      address: official.address || legacy.address,
      phone: official.phone || legacy.phone,
    };
  });

  return [...unmatchedOfficial, ...reconciledLegacy];
};
