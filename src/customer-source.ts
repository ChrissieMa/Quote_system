export const CUSTOMER_SOURCE_VALUES = [
  '朋友介紹',
  'Facebook',
  'IG',
  '網站搜尋 Google',
  'YouTube',
] as const;

export type CustomerSourceValue = typeof CUSTOMER_SOURCE_VALUES[number];

const CUSTOMER_SOURCE_ALIASES: Record<string, CustomerSourceValue> = {
  '朋友介紹': '朋友介紹',
  Facebook: 'Facebook',
  IG: 'IG',
  Instagram: 'IG',
  '網站搜尋 Google': '網站搜尋 Google',
  '網頁搜尋': '網站搜尋 Google',
  'Google／網頁搜尋': '網站搜尋 Google',
  YouTube: 'YouTube',
};

export const normalizeCustomerSource = (value: unknown): CustomerSourceValue | null =>
  CUSTOMER_SOURCE_ALIASES[String(value || '').trim()] || null;

export const customerSourceLabel = (value: unknown, isEnglish = false): string => {
  const normalized = normalizeCustomerSource(value);
  if (!normalized) return '';
  const labels: Record<CustomerSourceValue, { zh: string; en: string }> = {
    '朋友介紹': { zh: '朋友介紹', en: 'Referral' },
    Facebook: { zh: 'Facebook', en: 'Facebook' },
    IG: { zh: 'Instagram', en: 'Instagram' },
    '網站搜尋 Google': { zh: '網頁搜尋', en: 'Web Search' },
    YouTube: { zh: 'YouTube', en: 'YouTube' },
  };
  return isEnglish ? labels[normalized].en : labels[normalized].zh;
};

