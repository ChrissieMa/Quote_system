import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  ACCESSORY_DISPLAY_LABELS,
  accessoryOrderItemName,
  accessoryStorageName,
  buildPilotPreview,
  calculatePilotItem,
  formatDimensionValue,
  formatDimensionWithUnit,
  idempotencyPublicToken,
  issueConfirmationId,
  PILOT_CONFIRMATION_TEXT,
  RGB_LIGHT_WARNING,
  resolveAuthoritativeOffer,
  resolveDisplayCaseLevelHeights,
  verifyConfirmationId,
} from './quote-pilot';
import { estimateQuoteFreight, freightUnderquoteGap } from './freight-estimator';

const displayBoxItem = (
  accessories: Record<string, number>,
  innerDimensions = { length: 27, depth: 27, height: 36 },
) => calculatePilotItem({
  itemType: 'Display box 展示盒',
  innerDimensions,
  quantity: 1,
  accessories,
  chinaFreight: 0,
  hongKongDelivery: 0,
  profit: 0,
});

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

test('舊三圈燈保留 internal keys 並只改客人顯示名稱', () => {
  assert.deepEqual(ACCESSORY_DISPLAY_LABELS, {
    '獨立燈板 - 上燈': '三圈燈｜獨立上燈板',
    '獨立燈板 - 下燈': '三圈燈｜獨立下燈板',
    '獨立燈板 - 上下燈': '三圈燈｜獨立上下燈板',
    '上下燈': '三圈上下燈',
  });
  const item = displayBoxItem({ '獨立燈板 - 上燈': 1 });
  assert.deepEqual(item.accessoryQty, { '獨立燈板 - 上燈': 1 });
  assert.deepEqual(item.accessories, ['三圈燈｜獨立上燈板 x1']);
  assert.equal(accessoryStorageName('三圈燈｜獨立上燈板'), '獨立燈板 - 上燈');
  assert.equal(accessoryOrderItemName('三圈燈｜獨立上燈板 x2'), '獨立燈板 - 上燈');
  assert.equal(accessoryOrderItemName('彩燈｜上下燈 x2'), '彩燈｜上下燈');
  assert.equal(item.accessoriesAmountHkd, 144.12);
});

test('普通 Display Box 非一體磁吸保留舊尺寸規則', () => {
  const item = displayBoxItem({ '獨立燈板 - 上燈': 1 });
  assert.deepEqual(
    { l: item.outerL, d: item.outerD, h: item.outerH },
    { l: '29', d: '29', h: '39.5' },
  );
});

test('一體磁吸結構尺寸按無燈、單燈、上下燈及背燈組合計算', () => {
  const cases: Array<[Record<string, number>, [string, string, string]]> = [
    [{ '一體磁吸結構': 1 }, ['28', '28', '37']],
    [{ '一體磁吸結構': 1, '獨立燈板 - 上燈': 1 }, ['28', '28', '38.3']],
    [{ '一體磁吸結構': 1, '獨立燈板 - 下燈': 1 }, ['28', '28', '38.3']],
    [{ '一體磁吸結構': 1, '獨立燈板 - 上下燈': 1 }, ['28', '28', '40.6']],
    [{ '一體磁吸結構': 1, '獨立燈板 - 上燈': 1, '獨立燈板 - 下燈': 1 }, ['28', '28', '40.6']],
    [{ '一體磁吸結構': 1, '彩燈｜上下燈': 1 }, ['28', '28', '40.6']],
    [{ '一體磁吸結構': 1, '背燈': 1 }, ['28', '29.8', '37']],
    [{ '一體磁吸結構': 1, '獨立燈板 - 上燈': 1, '背燈': 1 }, ['28', '29.8', '38.3']],
    [{ '一體磁吸結構': 1, '獨立燈板 - 上下燈': 1, '背燈': 1 }, ['28', '29.8', '40.6']],
  ];
  for (const [accessories, expected] of cases) {
    const item = displayBoxItem(accessories);
    assert.deepEqual([item.outerL, item.outerD, item.outerH], expected);
  }
});

test('彩燈客人加價按 accessory quantity，不按米數', () => {
  const topOne = displayBoxItem({ '彩燈｜獨立上燈板': 1 });
  const topTwo = displayBoxItem({ '彩燈｜獨立上燈板': 2 });
  const independentBothTwo = displayBoxItem({ '彩燈｜獨立上下燈板': 2 });
  const standardBothOne = displayBoxItem({ '彩燈｜上下燈': 1 });
  assert.equal(topOne.rgbCustomerSurchargeHkd, 100);
  assert.equal(topTwo.rgbCustomerSurchargeHkd, 200);
  assert.equal(independentBothTwo.rgbCustomerSurchargeHkd, 200);
  assert.equal(standardBothOne.rgbCustomerSurchargeHkd, 100);
});

test('25x25 彩燈米數、供應商追加成本及原燈成本累加正確', () => {
  const dimensions = { length: 25, depth: 25, height: 30 };
  const legacyTop = displayBoxItem({ '獨立燈板 - 上燈': 1 }, dimensions);
  const rgbTop = displayBoxItem({ '彩燈｜獨立上燈板': 1 }, dimensions);
  const rgbBoth = displayBoxItem({ '彩燈｜獨立上下燈板': 1 }, dimensions);
  assert.equal(rgbTop.rgbLightMetres, 1);
  assert.equal(rgbTop.rgbSupplierSurchargeRmb, 10);
  assert.equal(rgbBoth.rgbLightMetres, 2);
  assert.equal(rgbBoth.rgbSupplierSurchargeRmb, 20);
  assert.equal(rgbTop.accessoriesAmountHkd, 245.12);
  assert.ok(rgbTop.accessoriesAmountHkd > legacyTop.accessoriesAmountHkd + 100);
});

test('彩燈單組燈帶超過 5m 只顯示 internal warning，不阻擋報價', () => {
  const item = displayBoxItem(
    { '彩燈｜獨立上燈板': 1 },
    { length: 200, depth: 60, height: 40 },
  );
  assert.equal(item.rgbLightMetres, 5.2);
  assert.deepEqual(item.internalWarnings, [RGB_LIGHT_WARNING]);
  assert.ok(item.amount > 0);
});

test('Create Quote 畫面顯示新命名並保留舊三圈燈 internal key', () => {
  const source = readFileSync(__dirname + '/index.ts', 'utf8');
  assert.match(source, /> 一體磁吸結構<\/label>/);
  assert.match(source, /三圈燈｜獨立上燈板<\/label><input[^>]+data-name="獨立燈板 - 上燈"/);
  assert.match(source, /data-name="彩燈｜獨立上下燈板"/);
  assert.match(source, /購買任何展示盒或展示櫃，附送趟門或一體磁吸結構/);
});

test('27x27x36 展示盒即時計出保守重量、中國運費及香港運費建議', () => {
  const estimate = estimateQuoteFreight({
    itemType: 'Display box 展示盒',
    lengthCm: 27,
    depthCm: 27,
    heightCm: 36,
    quantity: 1,
    packageUnits: 1,
  });
  assert.equal(estimate.available, true);
  assert.equal(estimate.confidence, 'medium');
  assert.equal(estimate.estimatedWeightMinKg, 4.1);
  assert.equal(estimate.estimatedWeightMaxKg, 6.6);
  assert.equal(estimate.recommendedChinaFreightHkd, 80);
  assert.equal(estimate.recommendedHkDeliveryHkd, 120);
});

test('燈板增加包裝單位時會提高保守重量及運費建議', () => {
  const plain = estimateQuoteFreight({
    itemType: 'Display box 展示盒',
    lengthCm: 27,
    depthCm: 27,
    heightCm: 36,
    quantity: 1,
    packageUnits: 1,
  });
  const withLightBoard = estimateQuoteFreight({
    itemType: 'Display box 展示盒',
    lengthCm: 27,
    depthCm: 27,
    heightCm: 36,
    quantity: 1,
    packageUnits: 1.5,
  });
  assert.ok(Number(withLightBoard.estimatedWeightMaxKg) > Number(plain.estimatedWeightMaxKg));
  assert.ok(Number(withLightBoard.recommendedChinaFreightHkd) > Number(plain.recommendedChinaFreightHkd));
  assert.ok(Number(withLightBoard.recommendedHkDeliveryHkd) > Number(plain.recommendedHkDeliveryHkd));
});

test('疊高展示櫃按每層高度計算並標示保守提示', () => {
  const estimate = estimateQuoteFreight({
    itemType: 'Display Case 疊高展示櫃',
    lengthCm: 55,
    depthCm: 30,
    levelHeightsCm: [50, 50, 40],
    quantity: 1,
    packageUnits: 3,
  });
  assert.equal(estimate.available, true);
  assert.equal(estimate.confidence, 'caution');
  assert.ok(Number(estimate.estimatedWeightMaxKg) > Number(estimate.estimatedWeightMinKg));
  assert.match(estimate.note, /保守上限/);
});

test('階梯或尺寸未完整時不會扮作精準估價', () => {
  const stair = estimateQuoteFreight({
    itemType: '階梯',
    lengthCm: 30,
    depthCm: 20,
    heightCm: 10,
  });
  const incomplete = estimateQuoteFreight({
    itemType: 'Display box 展示盒',
    lengthCm: 30,
    depthCm: 20,
  });
  assert.equal(stair.available, false);
  assert.equal(incomplete.available, false);
  assert.match(stair.note, /人手確認/);
  assert.match(incomplete.note, /完整尺寸/);
});

test('輸入低過建議價先顯示收少提示', () => {
  assert.equal(freightUnderquoteGap(100, 140), 40);
  assert.equal(freightUnderquoteGap(140, 140), 0);
  assert.equal(freightUnderquoteGap('', 140), 0);
});

test('Create Quote 運費輸入格下面包含即時計算及低價警告位置', () => {
  const source = readFileSync(__dirname + '/index.ts', 'utf8');
  assert.match(source, /class="f-freight-estimate freight-estimate-hint"/);
  assert.match(source, /class="f-hk-delivery-estimate freight-estimate-hint"/);
  assert.match(source, /function updateFreightEstimate\(row\)/);
  assert.match(source, /⚠️ 低過建議/);
  assert.match(source, /rows\.forEach\(function\(row\)[\s\S]+updateFreightEstimate\(row\)/);
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
