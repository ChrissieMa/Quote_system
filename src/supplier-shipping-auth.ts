import crypto from 'crypto';
import { supplierShippingJsonSha256 } from './supplier-shipping-receiver';

export type SupplierShippingSignatureInput = {
  method: string;
  path: string;
  timestamp: string;
  body: unknown;
};

const signedMessage = (input: SupplierShippingSignatureInput): string => [
  input.method.toUpperCase(),
  input.path,
  input.timestamp,
  supplierShippingJsonSha256(input.body),
].join('\n');

export const signSupplierShippingRequest = (
  secret: string,
  input: SupplierShippingSignatureInput,
): string => crypto.createHmac('sha256', secret).update(signedMessage(input)).digest('hex');

export type SupplierShippingSignatureVerification = {
  ok: boolean;
  code: 'verified' | 'not_configured' | 'invalid_timestamp' | 'expired' | 'invalid_signature';
};

export const verifySupplierShippingRequest = (
  secret: string,
  input: SupplierShippingSignatureInput & { signature: string },
  nowMs: number = Date.now(),
  toleranceMs: number = 5 * 60 * 1000,
): SupplierShippingSignatureVerification => {
  if (!secret) return { ok: false, code: 'not_configured' };
  const timestampMs = Date.parse(input.timestamp);
  if (!Number.isFinite(timestampMs)) return { ok: false, code: 'invalid_timestamp' };
  if (Math.abs(nowMs - timestampMs) > toleranceMs) return { ok: false, code: 'expired' };
  if (!/^[a-f0-9]{64}$/.test(input.signature)) return { ok: false, code: 'invalid_signature' };
  const expected = signSupplierShippingRequest(secret, input);
  const supplied = Buffer.from(input.signature, 'hex');
  const wanted = Buffer.from(expected, 'hex');
  return supplied.length === wanted.length && crypto.timingSafeEqual(supplied, wanted)
    ? { ok: true, code: 'verified' }
    : { ok: false, code: 'invalid_signature' };
};
