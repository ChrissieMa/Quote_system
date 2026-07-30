import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPilotPreview,
  idempotencyPublicToken,
  issueConfirmationId,
  PILOT_CONFIRMATION_TEXT,
  verifyConfirmationId,
} from './quote-pilot';

const baselineInput = {
  customer: 'DRY RUN CUSTOMER',
  phone: '00000000',
  items: [{
    itemType: 'Display box 展示盒' as const,
    forWhat: 'Dry run only',
    innerDimensions: { length: 30, depth: 20, height: 25 },
    quantity: 2,
    accessories: { '獨立燈板 - 上燈': 1, '前板白色刻字': 1 },
    chinaFreight: 100,
    hongKongDelivery: 200,
    profit: 500,
  }],
  offer: { kind: 'fixed' as const, amountHkd: 100, reason: 'Approved dry-run discount' },
};

test('v4.6 pricing preview calculates outer dimensions, costs and final total', () => {
  const preview = buildPilotPreview(baselineInput);
  assert.deepEqual(
    { l: preview.items[0].outerL, d: preview.items[0].outerD, h: preview.items[0].outerH },
    { l: '32.0', d: '22.0', h: '28.5' },
  );
  assert.equal(preview.items[0].qty, 2);
  assert.equal(preview.items[0].profit, 500);
  assert.equal(preview.subtotal, preview.items[0].amount);
  assert.equal(preview.discountValueHkd, 100);
  assert.equal(preview.finalTotal, Math.ceil(preview.subtotal - 100));
});

test('a signed confirmation locks the exact preview and creates a stable idempotency token', () => {
  const secret = 'test-secret-that-never-reaches-production';
  const now = 1_750_000_000_000;
  const confirmationId = issueConfirmationId(baselineInput, secret, now, 'fixed-nonce');
  const verified = verifyConfirmationId(confirmationId, secret, now + 1_000);
  assert.deepEqual(verified.preview, buildPilotPreview(baselineInput));
  assert.equal(idempotencyPublicToken(confirmationId, secret), idempotencyPublicToken(confirmationId, secret));
  assert.equal(PILOT_CONFIRMATION_TEXT, '確認開報價');
});

test('tampering, expiry and offer stacking fail closed', () => {
  const secret = 'test-secret-that-never-reaches-production';
  const now = 1_750_000_000_000;
  const confirmationId = issueConfirmationId(baselineInput, secret, now, 'fixed-nonce');
  assert.throws(() => verifyConfirmationId(`${confirmationId}x`, secret, now), /Invalid confirmation ID/);
  assert.throws(() => verifyConfirmationId(confirmationId, secret, now + (2 * 60 * 60 * 1000) + 1), /expired/);
  assert.throws(() => buildPilotPreview({
    ...baselineInput,
    offer: { kind: 'percentage', multiplier: 1.2, reason: 'invalid' },
  }), /between 0 and 1/);
});

test('Display Case keeps the v4.6 manual outer-dimension rule', () => {
  assert.throws(() => buildPilotPreview({
    ...baselineInput,
    items: [{
      ...baselineInput.items[0],
      itemType: 'Display Case 疊高展示櫃',
      levels: 3,
    }],
  }), /requires outerDimensions/);
});
