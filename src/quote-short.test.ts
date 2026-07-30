import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseShortQuoteText,
  resolveOfferPreset,
  resolveSourceAlias,
} from './quote-short';

const productionSources = [
  'Website', 'WhatsApp Direct', 'Meta Ads', 'Facebook Organic', 'Instagram Organic',
  'Google Search', 'Google Organic', 'Referral', 'Returning Customer', 'Other',
];
const productionDiscountReasons = ['ToyTV 專屬優惠', '首次落單優惠', '回購優惠', '新客戶優惠'];

test('parses the Phase 2C.2B one-line Display Box example with defaults and aliases', () => {
  const parsed = parseShortQuoteText(
    '92503576 盒 76x23x40 1個 趟門+上燈+背圖 內運150 港運260 利800 FB 盒-300',
  );
  assert.equal(parsed.kind, 'ready');
  if (parsed.kind !== 'ready') return;
  assert.equal(parsed.phone, '92503576');
  assert.equal(parsed.itemType, 'Display box 展示盒');
  assert.deepEqual(parsed.innerDimensions, { length: 76, depth: 23, height: 40 });
  assert.equal(parsed.quantity, 1);
  assert.deepEqual(parsed.accessories, {
    '趟門': 1,
    '獨立燈板 - 上燈': 1,
    '背板圖片': 1,
  });
  assert.equal(parsed.chinaFreight, 150);
  assert.equal(parsed.hongKongDelivery, 260);
  assert.equal(parsed.profit, 800);
  assert.equal(parsed.validUntilDays, 7);
  assert.equal(resolveSourceAlias(parsed.sourceAlias, productionSources).value, 'Facebook Organic');
  assert.deepEqual(resolveOfferPreset(parsed, productionDiscountReasons), {
    offer: { kind: 'fixed', amountHkd: 300, reason: '新客戶優惠' },
    label: '盒-300',
  });
});

test('parses the labelled multiline WhatsApp format without re-asking supplied fields', () => {
  const parsed = parseShortQuoteText(`Blue，幫我預覽報價：

顯示語言：中
查詢來源：website - 3D
客戶名稱：Mr/Miss
客戶電話：64611812
產品：展示盒
內尺寸：67*24*45
外尺寸：
數量：1
配件：上燈 背鏡 白色刻字
內地運費：150
香港運費：240
利潤：800
優惠：首次落單優惠
Discount Type：指定金額扣減 -$300
Discount Reason：
Valid Until：默認7天`);

  assert.equal(parsed.kind, 'ready');
  if (parsed.kind !== 'ready') return;
  assert.equal(parsed.phone, '64611812');
  assert.equal(parsed.itemType, 'Display box 展示盒');
  assert.deepEqual(parsed.innerDimensions, { length: 67, depth: 24, height: 45 });
  assert.equal(parsed.quantity, 1);
  assert.deepEqual(parsed.accessories, {
    '獨立燈板 - 上燈': 1,
    '背板鏡面': 1,
    '前板白色刻字': 1,
  });
  assert.equal(parsed.chinaFreight, 150);
  assert.equal(parsed.hongKongDelivery, 240);
  assert.equal(parsed.profit, 800);
  assert.equal(parsed.validUntilDays, 7);
  assert.equal(resolveSourceAlias(parsed.sourceAlias, productionSources).value, 'Website');
  assert.deepEqual(resolveOfferPreset(parsed, productionDiscountReasons), {
    offer: { kind: 'fixed', amountHkd: 300, reason: '新客戶優惠' },
    label: '盒-300',
  });
});

test('quantity defaults to one and Google asks one bounded clarification', () => {
  const parsed = parseShortQuoteText(
    '92503576 盒 76x23x40 趟門 內運150 港運260 利800 Google 無優惠',
  );
  assert.equal(parsed.kind, 'ready');
  if (parsed.kind !== 'ready') return;
  assert.equal(parsed.quantity, 1);
  const source = resolveSourceAlias(parsed.sourceAlias, productionSources);
  assert.equal(source.clarification?.code, 'source-ambiguous');
  assert.deepEqual(source.clarification?.options, ['Google Search', 'Google Organic']);
});

test('conflicting offers fail before preview and are never stacked', () => {
  const parsed = parseShortQuoteText(
    '92503576 盒 76x23x40 內運150 港運260 利800 FB 盒-300 無優惠',
  );
  assert.equal(parsed.kind, 'clarification');
  if (parsed.kind !== 'clarification') return;
  assert.equal(parsed.code, 'offer-conflict');
  assert.match(parsed.message, /優惠不可疊加/);
});

test('legacy and incomplete custom offers ask one bounded clarification', () => {
  const legacy = parseShortQuoteText(
    '92503576 盒 76x23x40 內運150 港運260 利800 FB 舊報價保留',
  );
  assert.equal(legacy.kind, 'ready');
  if (legacy.kind === 'ready') {
    assert.equal(resolveOfferPreset(legacy, productionDiscountReasons).clarification?.code, 'legacy-offer-reference-required');
  }

  const custom = parseShortQuoteText(
    '92503576 盒 76x23x40 內運150 港運260 利800 FB 自訂',
  );
  assert.equal(custom.kind, 'ready');
  if (custom.kind === 'ready') {
    assert.equal(resolveOfferPreset(custom, productionDiscountReasons).clarification?.code, 'custom-offer-details-required');
  }
});
