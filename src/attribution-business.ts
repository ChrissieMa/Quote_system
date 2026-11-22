import { LocalAttributionStore } from './attribution-store';

export const selectedAttributionCode = (input: unknown): string | null => {
  if (typeof input !== 'string' || input.length > 200) return null;
  const found = [...input.matchAll(/LKS-[A-Za-z0-9_-]*/g)].map(match => match[0]);
  const unique = [...new Set(found)];
  return unique.length === 1 && /^LKS-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{16}$/.test(unique[0]) ? unique[0] : null;
};

export type AttributionBusinessHooks = {
  inquiry(code: unknown, inquiryId: string): AttributionBindingResult;
  quote(code: unknown, inquiryId: string, quoteId: string): AttributionBindingResult;
  order(quoteId: string, orderId: string): void;
};

export type AttributionBindingResult = { outcome: 'matched' | 'unknown'; reason: string | null };
const unknownReason = (code: unknown): string => {
  if (typeof code !== 'string' || !code.trim()) return 'missing';
  const found = [...new Set([...code.matchAll(/LKS-[A-Za-z0-9_-]*/g)].map(match => match[0]))];
  return found.length > 1 ? 'ambiguous' : 'malformed';
};

export const createAttributionBusinessHooks = (
  store: LocalAttributionStore,
  now: () => number,
  reportError: (message: string) => void,
  requestProjection?: () => void,
): AttributionBusinessHooks => {
  const project = (): void => {
    try { requestProjection?.(); }
    catch { reportError('Attribution projection unavailable; retry is required.'); }
  };
  return {
    inquiry(code, inquiryId) {
      try {
        const selected = selectedAttributionCode(code);
        if (!selected) return { outcome: 'unknown', reason: unknownReason(code) };
        const snapshot = store.bindInquiry(selected, inquiryId, now());
        if (snapshot) project();
        return snapshot ? { outcome: 'matched', reason: null } : { outcome: 'unknown', reason: 'not_found' };
      } catch {
        reportError('Attribution inquiry binding unavailable.');
        return { outcome: 'unknown', reason: 'service_unavailable' };
      }
    },
    quote(code, inquiryId, quoteId) {
      try {
        const selected = selectedAttributionCode(code);
        const result = store.pinQuote(selected, inquiryId, quoteId, now(), unknownReason(code));
        project();
        return result.snapshot ? { outcome: 'matched', reason: null } : { outcome: 'unknown', reason: result.reason };
      } catch {
        reportError('Attribution quote binding unavailable.');
        return { outcome: 'unknown', reason: 'service_unavailable' };
      }
    },
    order(quoteId, orderId) {
      try { store.pinOrder(quoteId, orderId); project(); }
      catch { reportError('Attribution order binding unavailable.'); }
    },
  };
};
