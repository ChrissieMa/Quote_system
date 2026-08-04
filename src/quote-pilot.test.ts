import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPilotPreview,
  calculatePilotItem,
  formatDimensionValue,
  formatDimensionWithUnit,
  idempotencyPublicToken,
  issueConfirmationId,
  PILOT_CONFIRMATION_TEXT,
  resolveAuthoritativeOffer,
  resolveDisplayCaseLevelHeights,
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
    { l: '32', d: '22', h: '28.5' },
  );
  assert.equal(preview.items[0].qty, 2);
  assert.equal(preview.items[0].profit, 500);
  assert.equal(preview.subtotal, preview.items[0].amount);
  assert.equal(preview.discountValueHkd, 100);
  assert.equal(preview.finalTotal, Math.ceil(preview.subtotal - 100));
});

test('dimension display removes trailing zeroes but preserves real decimals', () => {
  assert.equal(formatDimensionValue('35.0'), '35');
  assert.equal(formatDimensionValue(35), '35');
  assert.equal(formatDimensionValue('35.50'), '35.5');
  assert.equal(formatDimensionValue('35.25'), '35.25');
  assert.equal(formatDimensionValue('-'), '-');
});

test('dimension display adds cm after actual values only', () => {
  assert.equal(formatDimensionWithUnit('35.0'), '35 cm');
  assert.equal(formatDimensionWithUnit('35.50'), '35.5 cm');
  assert.equal(formatDimensionWithUnit('35 cm'), '35 cm');
  assert.equal(formatDimensionWithUnit('-'), '-');
  assert.equal(formatDimensionWithUnit(''), '');
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

test('Display Case prices non-uniform inner heights layer by layer while keeping one item', () => {
  const calculated = calculatePilotItem({
    itemType: 'Display Case 疊高展示櫃',
    innerDimensions: { length: 55, depth: 30 },
    outerDimensions: { length: 57, depth: 32, height: 140 },
    quantity: 1,
    levels: 3,
    levelHeights: '第1層：50 cm｜第2層：50 cm｜第3層：40 cm',
    accessories: { '獨立燈板 - 上下燈': 1 },
    chinaFreight: 120,
    hongKongDelivery: 300,
    profit: 1000,
  });
  const displayBoxRmb = (l: number, d: number, h: number) => {
    const fiveSideArea = (l * d) + ((l * h + d * h) * 2);
    return (fiveSideArea * 0.025) + (l * d * 0.013) + (l * d * 0.013) + 20;
  };
  const expectedBaseHkd = Math.round(
    ((displayBoxRmb(55, 30, 50) * 2 + displayBoxRmb(55, 30, 40)) / 0.85) * 100,
  ) / 100;

  assert.equal(calculated.noOfLevels, 3);
  assert.equal(calculated.interH, '50');
  assert.equal(calculated.levelHeights, '第1層：50 cm｜第2層：50 cm｜第3層：40 cm');
  assert.equal(calculated.baseProductAmountHkd, expectedBaseHkd);
  assert.equal(
    Math.round((calculated.amount - calculated.unitProductAndAccessoriesHkd) * 100) / 100,
    1420,
  );
});

test('same-height Display Case remains equivalent to the existing Levels multiplication', () => {
  const common = {
    itemType: 'Display Case 疊高展示櫃' as const,
    innerDimensions: { length: 55, depth: 30, height: 50 },
    outerDimensions: { length: 57, depth: 32, height: 156 },
    quantity: 1,
    levels: 3,
    chinaFreight: 0,
    hongKongDelivery: 0,
    profit: 0,
  };
  const fallback = calculatePilotItem({ ...common, levelHeights: '' });
  const explicit = calculatePilotItem({ ...common, levelHeights: '50, 50, 50' });
  const levelHeightsOnly = calculatePilotItem({
    ...common,
    innerDimensions: { length: 55, depth: 30 },
    levelHeights: '50, 50, 50',
  });
  assert.equal(explicit.baseProductAmountHkd, fallback.baseProductAmountHkd);
  assert.equal(explicit.amount, fallback.amount);
  assert.equal(levelHeightsOnly.amount, fallback.amount);
});

test('Display Case accessories keep their entered quantities and are not multiplied by Levels', () => {
  const accessories = { '獨立燈板 - 上燈': 1, '前板彩色刻字': 1 };
  const box = calculatePilotItem({
    itemType: 'Display box 展示盒',
    innerDimensions: { length: 55, depth: 30, height: 50 },
    quantity: 1,
    accessories,
    chinaFreight: 0,
    hongKongDelivery: 0,
    profit: 0,
  });
  const displayCase = calculatePilotItem({
    itemType: 'Display Case 疊高展示櫃',
    innerDimensions: { length: 55, depth: 30, height: 50 },
    outerDimensions: { length: 57, depth: 32, height: 140 },
    quantity: 1,
    levels: 3,
    levelHeights: '50, 50, 40',
    accessories,
    chinaFreight: 0,
    hongKongDelivery: 0,
    profit: 0,
  });
  assert.equal(displayCase.accessoriesAmountHkd, box.accessoriesAmountHkd);
});

test('Display Case rejects an incomplete per-level height list', () => {
  assert.deepEqual(resolveDisplayCaseLevelHeights('', 3, 50), [50, 50, 50]);
  assert.throws(() => resolveDisplayCaseLevelHeights('', 3), /exactly 3 positive heights/);
  assert.throws(() => resolveDisplayCaseLevelHeights('50, 40', 3, 50), /exactly 3 positive heights/);
});

test('Display box still requires Inter H', () => {
  assert.throws(() => calculatePilotItem({
    itemType: 'Display box 展示盒',
    innerDimensions: { length: 55, depth: 30 },
    quantity: 1,
    chinaFreight: 0,
    hongKongDelivery: 0,
    profit: 0,
  }), /Inner height/);
});

test('階梯 uses entered Outer L D H and the confirmed 3MM formula without Level Heights or Accessories', () => {
  const calculated = calculatePilotItem({
    itemType: '階梯',
    innerDimensions: {},
    outerDimensions: { length: 30, depth: 20, height: 15 },
    quantity: 2,
    levels: 3,
    chinaFreight: 100,
    hongKongDelivery: 200,
    profit: 500,
  });
  const area = (30 * 20) + ((30 * 15 + 20 * 15) * 2);
  const expectedRmb = (area * 0.025) + (30 * 20 * 0.01) + (30 * 20 * 0.01);
  const expectedProductTotal = Math.round(((expectedRmb / 0.85) * 2) * 100) / 100;

  assert.deepEqual(
    { l: calculated.outerL, d: calculated.outerD, h: calculated.outerH },
    { l: '30', d: '20', h: '15' },
  );
  assert.deepEqual(
    { l: calculated.interL, d: calculated.interD, h: calculated.interH },
    { l: '', d: '', h: '' },
  );
  assert.equal(calculated.noOfLevels, 3);
  assert.equal(calculated.levelHeights, '');
  assert.deepEqual(calculated.accessories, []);
  assert.equal(calculated.baseProductAmountHkd, Math.round((expectedRmb / 0.85) * 100) / 100);
  assert.equal(calculated.productAndAccessoriesTotalHkd, expectedProductTotal);
  assert.equal(calculated.amount, Math.round((expectedProductTotal + 100 + 200 + 500) * 100) / 100);
});

test('階梯 rejects Accessories and requires manual outer dimensions plus Levels', () => {
  const common = {
    itemType: '階梯' as const,
    innerDimensions: {},
    outerDimensions: { length: 30, depth: 20, height: 15 },
    quantity: 1,
    levels: 3,
    chinaFreight: 0,
    hongKongDelivery: 0,
    profit: 0,
  };
  assert.throws(() => calculatePilotItem({ ...common, accessories: { '趟門': 1 } }), /不使用 Accessories/);
  assert.throws(() => calculatePilotItem({ ...common, outerDimensions: undefined }), /requires outerDimensions/);
  assert.throws(() => calculatePilotItem({ ...common, levels: undefined }), /Levels/);
});

test('Create Quote preserves an explicit discount even when a Promotion is also selected', () => {
  assert.deepEqual(resolveAuthoritativeOffer({
    promotionType: '首次落單優惠',
    discountType: '指定金額扣減',
    discountAmountHkd: 500,
    discountReason: '首次落單優惠',
  }), {
    kind: 'fixed',
    amountHkd: 500,
    reason: '首次落單優惠',
  });
});

test('retired promotion choices no longer resolve as current presets', () => {
  assert.deepEqual(resolveAuthoritativeOffer({ promotionType: 'ToyTV 專屬優惠' }), { kind: 'none' });
  assert.deepEqual(resolveAuthoritativeOffer({ promotionType: '現貨優惠' }), { kind: 'none' });
  assert.deepEqual(resolveAuthoritativeOffer({ promotionType: '新客戶免運費' }), { kind: 'none' });
});

test('first-order preset defaults to $300 for boxes and $500 when the quote contains a Display Case', () => {
  const box = buildPilotPreview({
    ...baselineInput,
    offer: { kind: 'promotion', promotionType: '首次落單優惠' },
  });
  assert.equal(box.discountAmountHkd, 300);
  assert.equal(box.discountValueHkd, 300);
  assert.equal(box.promotionType, '首次落單優惠');

  const displayCase = buildPilotPreview({
    ...baselineInput,
    items: [{
      ...baselineInput.items[0],
      itemType: 'Display Case 疊高展示櫃',
      levels: 3,
      outerDimensions: { length: 32, depth: 22, height: 78 },
    }],
    offer: { kind: 'promotion', promotionType: '首次落單優惠' },
  });
  assert.equal(displayCase.discountAmountHkd, 500);
  assert.equal(displayCase.discountValueHkd, 500);
  assert.equal(displayCase.promotionType, '首次落單優惠');
});

test('Phase 2C.2B preview exposes pricing components and estimated net profit without double-deducting delivery', () => {
  const preview = buildPilotPreview({
    customer: 'Mr/Miss',
    phone: '92503576',
    customerMatch: 'fallback',
    quoteSourceChannel: 'Facebook Organic',
    validUntil: '2026-08-06',
    offerPresetLabel: '盒-300',
    entryMode: 'short',
    items: [{
      itemType: 'Display box 展示盒',
      innerDimensions: { length: 76, depth: 23, height: 40 },
      quantity: 1,
      accessories: {
        '趟門': 1,
        '獨立燈板 - 上燈': 1,
        '背板圖片': 1,
      },
      chinaFreight: 150,
      hongKongDelivery: 260,
      profit: 800,
    }],
    offer: { kind: 'fixed', amountHkd: 300, reason: '首次落單優惠' },
  });
  assert.deepEqual(
    { l: preview.items[0].outerL, d: preview.items[0].outerD, h: preview.items[0].outerH },
    { l: '78', d: '25', h: '43.5' },
  );
  assert.equal(preview.items[0].baseProductAmountHkd, 361.35);
  assert.equal(preview.items[0].accessoriesAmountHkd, 446.49);
  assert.equal(preview.items[0].productAndAccessoriesTotalHkd, 807.84);
  assert.equal(preview.subtotal, 2017.84);
  assert.equal(preview.discountValueHkd, 300);
  assert.equal(preview.finalTotal, 1718);
  assert.equal(preview.quotedProfitTotal, 800);
  assert.equal(preview.estimatedDriverPayableHkd, 234);
  assert.equal(preview.estimatedCompanyDeliveryRetentionHkd, 26);
  assert.equal(preview.estimatedNetProfitHkd, 526);
  assert.equal(preview.review.duplicateDeductions, false);
  assert.equal(preview.review.localDeliveryDeductedAsOffer, false);
});
