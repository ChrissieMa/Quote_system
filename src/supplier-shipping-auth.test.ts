import assert from 'node:assert/strict';
import test from 'node:test';
import { signSupplierShippingRequest, verifySupplierShippingRequest } from './supplier-shipping-auth';

const body = { sourceBatchId: 'SPCN-SYNTHETIC-AUTH', items: [{ id: 'synthetic', weight: '1.250' }] };
const timestamp = '2026-11-21T16:00:00.000Z';
const request = { method: 'POST', path: '/api/integrations/supplier-shipping/v1/batches', timestamp, body };
const syntheticSecret = 'synthetic-test-value-not-a-production-credential';

test('valid signature covers method, path, timestamp and canonical body hash', () => {
  const signature = signSupplierShippingRequest(syntheticSecret, request);
  assert.deepEqual(verifySupplierShippingRequest(syntheticSecret, { ...request, signature }, Date.parse(timestamp)), {
    ok: true,
    code: 'verified',
  });
});

test('changed body, stale timestamp and missing configuration fail closed', () => {
  const signature = signSupplierShippingRequest(syntheticSecret, request);
  assert.equal(verifySupplierShippingRequest(syntheticSecret, {
    ...request,
    body: { ...body, sourceBatchId: 'SPCN-CHANGED' },
    signature,
  }, Date.parse(timestamp)).code, 'invalid_signature');
  assert.equal(verifySupplierShippingRequest(syntheticSecret, {
    ...request,
    signature,
  }, Date.parse(timestamp) + 301_000).code, 'expired');
  assert.equal(verifySupplierShippingRequest('', { ...request, signature }, Date.parse(timestamp)).code, 'not_configured');
});
