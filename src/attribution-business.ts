import { AttributionSnapshot, LocalAttributionStore } from './attribution-store';

export type AttributionBusinessAdapter = {
  attachInquiry(inquiryId: string, snapshot: AttributionSnapshot): true;
  pinQuote(quoteId: string, inquiryId: string, snapshot: AttributionSnapshot | null, reason: string | null): true;
  copyQuoteToOrder(quoteId: string, orderId: string): true;
};

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
  adapter: AttributionBusinessAdapter,
  now: () => number,
  reportError: (message: string) => void,
): AttributionBusinessHooks => {
  return {
    inquiry(code, inquiryId) {
      try {
        const selected = selectedAttributionCode(code);
        if (!selected) return { outcome: 'unknown', reason: unknownReason(code) };
        const snapshot = store.bindWith(selected, now(), value => {
          if (adapter.attachInquiry(inquiryId, value) !== true) throw new Error('Invalid synchronous projection.');
        });
        return snapshot ? { outcome: 'matched', reason: null } : { outcome: 'unknown', reason: 'not_found' };
      } catch {
        reportError('Attribution inquiry binding unavailable.');
        return { outcome: 'unknown', reason: 'service_unavailable' };
      }
    },
    quote(code, inquiryId, quoteId) {
      try {
        const selected = selectedAttributionCode(code);
        const snapshot = selected
          ? store.bindWith(selected, now(), value => {
            if (adapter.pinQuote(quoteId, inquiryId, value, null) !== true) throw new Error('Invalid synchronous projection.');
          })
          : null;
        const reason = snapshot ? null : selected ? 'not_found' : unknownReason(code);
        if (!snapshot && adapter.pinQuote(quoteId, inquiryId, null, reason) !== true) throw new Error('Invalid synchronous projection.');
        return snapshot ? { outcome: 'matched', reason: null } : { outcome: 'unknown', reason };
      } catch {
        reportError('Attribution quote binding unavailable.');
        return { outcome: 'unknown', reason: 'service_unavailable' };
      }
    },
    order(quoteId, orderId) {
      try {
        if (adapter.copyQuoteToOrder(quoteId, orderId) !== true) throw new Error('Invalid synchronous projection.');
      }
      catch { reportError('Attribution order binding unavailable.'); }
    },
  };
};
