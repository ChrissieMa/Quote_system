import crypto from 'crypto';

export const PILOT_CONFIRMATION_TEXT = '確認開報價';
export const SHORT_QUOTE_CONFIRMATION_TEXT = '確認開單';
export const PILOT_CONFIRMATION_TEXTS = [
  PILOT_CONFIRMATION_TEXT,
  SHORT_QUOTE_CONFIRMATION_TEXT,
] as const;
export const PILOT_CONFIRMATION_TTL_MS = 2 * 60 * 60 * 1000;
export const DRIVER_SHARE_RATE = 0.90;

export const PILOT_ITEM_TYPES = [
  'Display box 展示盒',
  'Display Case 疊高展示櫃',
] as const;

export const PILOT_ACCESSORIES = [
  '樓梯', '趟門', '磁石門', '黑底板', '透明底板',
  '獨立燈板 - 上燈', '獨立燈板 - 下燈', '獨立燈板 - 上下燈', '上下燈', '背燈',
  '前板白色刻字', '前板彩色刻字',
  '左板圖片', '右板圖片', '底板圖片', '頂板圖片', '背板圖片',
  '左板鏡面', '右板鏡面', '底板鏡面', '頂板鏡面', '背板鏡面',
] as const;

const SINGLE_ACCESSORIES = new Set(['樓梯', '趟門', '磁石門', '黑底板', '透明底板']);
const ALLOWED_ACCESSORIES = new Set<string>(PILOT_ACCESSORIES);
const RMB_DIVISOR = 0.85;

export type PilotDimensions = { length: number; depth: number; height: number };

export type PilotItemInput = {
  itemType: typeof PILOT_ITEM_TYPES[number];
  forWhat?: string;
  innerDimensions: PilotDimensions;
  outerDimensions?: PilotDimensions;
  quantity: number;
  levels?: number;
  levelHeights?: string;
  accessories?: Record<string, number>;
  description?: string;
  chinaFreight: number;
  hongKongDelivery: number;
  profit: number;
};

export type PilotOffer =
  | { kind: 'none' }
  | { kind: 'promotion'; promotionType: 'ToyTV 專屬優惠' | '首次落單優惠' | '新客戶免運費' | '現貨優惠' }
  | { kind: 'percentage'; multiplier: number; reason: string }
  | { kind: 'fixed'; amountHkd: number; reason: string };

export const resolveAuthoritativeOffer = (rawBody: any): PilotOffer => {
  const discountType = String(rawBody?.discountType || '').trim();
  // Promotion and Discount are separate Airtable concepts. If Create Quote
  // supplies an explicit discount, keep it instead of replacing it with the
  // promotion preset during the authoritative calculation pass.
  if (discountType === '百分比折扣') {
    return {
      kind: 'percentage',
      multiplier: Number(rawBody?.discountMultiplier),
      reason: String(rawBody?.discountReason || '').trim(),
    };
  }
  if (discountType === '指定金額扣減') {
    return {
      kind: 'fixed',
      amountHkd: Number(rawBody?.discountAmountHkd || 0),
      reason: String(rawBody?.discountReason || '').trim(),
    };
  }

  const promotionType = String(rawBody?.promotionType || '').trim();
  const supportedPromotions = new Set(['ToyTV 專屬優惠', '首次落單優惠', '新客戶免運費', '現貨優惠']);
  if (supportedPromotions.has(promotionType)) {
    return {
      kind: 'promotion',
      promotionType: promotionType as Extract<PilotOffer, { kind: 'promotion' }>['promotionType'],
    };
  }
  return { kind: 'none' };
};

export type PilotQuoteInput = {
  customer: string;
  phone: string;
  items: PilotItemInput[];
  offer?: PilotOffer;
  deliveryOfferReason?: string;
  contactMethod?: 'WhatsApp' | 'IG' | 'Facebook' | '網頁搜尋';
  quoteSourceChannel?: string;
  validUntil?: string;
  customerMatch?: 'existing' | 'fallback' | 'supplied';
  offerPresetLabel?: string;
  entryMode?: 'detailed' | 'short';
};

export type CalculatedPilotItem = {
  itemType: string;
  forWhat: string;
  interL: string;
  interD: string;
  interH: string;
  outerL: string;
  outerD: string;
  outerH: string;
  noOfLevels: number | null;
  levelHeights: string;
  accessories: string[];
  accessoryQty: Record<string, number>;
  description: string;
  qty: number;
  freight: number;
  hongKongDelivery: number;
  deliveryCostReserve: number;
  profit: number;
  estimatedPackageUnits: number;
  localDeliveryOverride: true;
  localDeliveryNotes: string;
  baseProductAmountHkd: number;
  accessoriesAmountHkd: number;
  unitProductAndAccessoriesHkd: number;
  productAndAccessoriesTotalHkd: number;
  amount: number;
};

export type PilotPreview = {
  customer: string;
  phone: string;
  items: CalculatedPilotItem[];
  subtotal: number;
  promotionType: string;
  discountType: string;
  discountMultiplier: number | null;
  discountAmountHkd: number;
  discountReason: string;
  discountValueHkd: number;
  discountDisplayText: string;
  deliveryChargeMode: '已包本地送貨';
  deliveryOfferReason: string;
  deliveryDisplayText: string;
  quoteSourceChannel: string;
  validUntil: string;
  customerMatch: 'existing' | 'fallback' | 'supplied';
  offerPresetLabel: string;
  quotedProfitTotal: number;
  quotedLocalDeliveryTotal: number;
  estimatedDriverPayableHkd: number;
  estimatedCompanyDeliveryRetentionHkd: number;
  estimatedNetProfitHkd: number;
  estimatedNetProfitFormula: string;
  review: {
    missingFields: string[];
    duplicateDeductions: boolean;
    localDeliveryDeductedAsOffer: boolean;
    obviousUnderquoteRisk: boolean;
    warnings: string[];
    summary: string;
  };
  finalTotal: number;
};

const finitePositive = (value: unknown, label: string): number => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be greater than 0.`);
  return number;
};

const finiteNonNegative = (value: unknown, label: string): number => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be 0 or greater.`);
  return number;
};

const positiveInteger = (value: unknown, label: string): number => {
  const number = finitePositive(value, label);
  if (!Number.isInteger(number)) throw new Error(`${label} must be a whole number.`);
  return number;
};

const money = (value: number): number => Math.round(value * 100) / 100;

const calcDisplayBoxRmb = (l: number, d: number, h: number): number => {
  const fiveSideArea = (l * d) + ((l * h + d * h) * 2);
  return (fiveSideArea * 0.025) + (l * d * 0.013) + (l * d * 0.013) + 20;
};

const calcLightBoardRmb = (l: number, d: number): number =>
  ((l * d + d * 2 + l * 2) * 2 * 0.023) + l + d;

const calcBackLightRmb = (l: number, h: number): number =>
  ((l * h + h * 2 + l * 2) * 2 * 0.02) + l + h;

const calcBackPanelRmb = (l: number, h: number): number => l * h * 0.025;
const calcLdPanelRmb = (l: number, d: number): number => l * d * 0.025;

const normalizeAccessories = (raw: Record<string, number> | undefined): Record<string, number> => {
  const normalized: Record<string, number> = {};
  for (const [name, rawQty] of Object.entries(raw || {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (!ALLOWED_ACCESSORIES.has(name)) throw new Error(`Unsupported accessory: ${name}`);
    const qty = positiveInteger(rawQty, `Accessory quantity for ${name}`);
    if (SINGLE_ACCESSORIES.has(name) && qty !== 1) {
      throw new Error(`${name} is a single-selection accessory and its quantity must be 1.`);
    }
    normalized[name] = qty;
  }
  return normalized;
};

const calculateOuterDimensions = (
  itemType: string,
  inner: PilotDimensions,
  supplied: PilotDimensions | undefined,
  accessories: Record<string, number>,
): PilotDimensions => {
  if (itemType.includes('Display Case')) {
    if (!supplied) throw new Error('Display Case requires outerDimensions because v4.6 keeps those dimensions manual.');
    return {
      length: finitePositive(supplied.length, 'Outer length'),
      depth: finitePositive(supplied.depth, 'Outer depth'),
      height: finitePositive(supplied.height, 'Outer height'),
    };
  }

  const hasTopStandard = (accessories['上下燈'] || 0) > 0;
  const hasTopIndependentSingle =
    (accessories['獨立燈板 - 上燈'] || 0) > 0 || (accessories['獨立燈板 - 下燈'] || 0) > 0;
  const hasTopIndependentDouble = (accessories['獨立燈板 - 上下燈'] || 0) > 0;
  const hasBack = (accessories['背燈'] || 0) > 0;
  const heightIncrease = hasTopIndependentDouble ? 6 : hasTopStandard ? 5 : hasTopIndependentSingle ? 3.5 : 1;
  return {
    length: inner.length + 2,
    depth: inner.depth + (hasBack ? 3.5 : 2),
    height: inner.height + heightIncrease,
  };
};

export const calculatePilotItem = (input: PilotItemInput): CalculatedPilotItem => {
  if (!PILOT_ITEM_TYPES.includes(input.itemType)) throw new Error(`Unsupported item type: ${input.itemType}`);
  const inner = {
    length: finitePositive(input.innerDimensions?.length, 'Inner length'),
    depth: finitePositive(input.innerDimensions?.depth, 'Inner depth'),
    height: finitePositive(input.innerDimensions?.height, 'Inner height'),
  };
  const quantity = positiveInteger(input.quantity, 'Quantity');
  const isDisplayCase = input.itemType.includes('Display Case');
  const levels = isDisplayCase ? positiveInteger(input.levels, 'Levels') : Math.max(1, Number(input.levels) || 1);
  const accessories = normalizeAccessories(input.accessories);
  const outer = calculateOuterDimensions(input.itemType, inner, input.outerDimensions, accessories);
  const chinaFreight = finiteNonNegative(input.chinaFreight, 'China freight');
  const hongKongDelivery = finiteNonNegative(input.hongKongDelivery, 'Hong Kong delivery');
  const profit = finiteNonNegative(input.profit, 'Profit');

  const baseRmb = calcDisplayBoxRmb(inner.length, inner.depth, inner.height);
  const sizeRmb = isDisplayCase ? baseRmb * levels : baseRmb;
  let accessoryRmb = 0;
  let hkdAddons = 0;
  const lightBoardCount =
    (accessories['獨立燈板 - 上燈'] || 0) +
    (accessories['獨立燈板 - 下燈'] || 0) +
    ((accessories['獨立燈板 - 上下燈'] || 0) * 2) +
    ((accessories['上下燈'] || 0) * 2);
  if (lightBoardCount > 0) accessoryRmb += calcLightBoardRmb(inner.length, inner.depth) * lightBoardCount;
  const backLightCount = accessories['背燈'] || 0;
  if (backLightCount > 0) accessoryRmb += calcBackLightRmb(inner.length, inner.height) * backLightCount;
  const backImageCount = accessories['背板圖片'] || 0;
  if (backImageCount > 0) {
    accessoryRmb += calcBackPanelRmb(inner.length, inner.height) * backImageCount;
    hkdAddons += 100 * backImageCount;
  }
  for (const name of ['左板圖片', '右板圖片', '底板圖片', '頂板圖片']) {
    const count = accessories[name] || 0;
    if (count > 0) {
      accessoryRmb += calcLdPanelRmb(inner.length, inner.depth) * count;
      hkdAddons += 100 * count;
    }
  }
  for (const name of ['左板鏡面', '右板鏡面', '底板鏡面', '頂板鏡面']) {
    const count = accessories[name] || 0;
    if (count > 0) accessoryRmb += calcLdPanelRmb(inner.length, inner.depth) * count;
  }
  const backMirrorCount = accessories['背板鏡面'] || 0;
  if (backMirrorCount > 0) accessoryRmb += calcBackPanelRmb(inner.length, inner.height) * backMirrorCount;
  hkdAddons += (accessories['前板白色刻字'] || 0) * 70;
  hkdAddons += (accessories['前板彩色刻字'] || 0) * 90;
  if (lightBoardCount > 0 || backLightCount > 0) accessoryRmb += 30;

  const baseProductAmountHkd = money(sizeRmb / RMB_DIVISOR);
  const accessoriesAmountHkd = money((accessoryRmb / RMB_DIVISOR) + hkdAddons);
  const unitProductAmount = ((sizeRmb + accessoryRmb) / RMB_DIVISOR) + hkdAddons;
  const productAndAccessoriesTotalHkd = money(unitProductAmount * quantity);
  const amount = (unitProductAmount * quantity) + chinaFreight + hongKongDelivery + profit;
  const lightBoardPieces = lightBoardCount + backLightCount;
  const packageUnits = ((isDisplayCase ? levels : 1) + (lightBoardPieces * 0.5)) * quantity;
  const accessoriesList = [
    ...Object.entries(accessories).filter(([name]) => SINGLE_ACCESSORIES.has(name)).map(([name]) => name),
    ...Object.entries(accessories).filter(([name]) => !SINGLE_ACCESSORIES.has(name)).map(([name, qty]) => `${name} x${qty}`),
  ];

  return {
    itemType: input.itemType,
    forWhat: String(input.forWhat || ''),
    interL: String(inner.length),
    interD: String(inner.depth),
    interH: String(inner.height),
    outerL: outer.length.toFixed(1),
    outerD: outer.depth.toFixed(1),
    outerH: outer.height.toFixed(1),
    noOfLevels: isDisplayCase ? levels : null,
    levelHeights: String(input.levelHeights || ''),
    accessories: accessoriesList,
    accessoryQty: accessories,
    description: String(input.description || ''),
    qty: quantity,
    freight: chinaFreight,
    hongKongDelivery,
    deliveryCostReserve: hongKongDelivery,
    profit,
    estimatedPackageUnits: packageUnits,
    localDeliveryOverride: true,
    localDeliveryNotes: '香港運費由報價時人手輸入估算總數；客人版只顯示預計範圍',
    baseProductAmountHkd,
    accessoriesAmountHkd,
    unitProductAndAccessoriesHkd: money(unitProductAmount),
    productAndAccessoriesTotalHkd,
    amount: money(amount),
  };
};

export const buildPilotPreview = (input: PilotQuoteInput): PilotPreview => {
  const customer = String(input.customer || '').trim();
  const phone = String(input.phone || '').trim();
  if (!customer) throw new Error('Customer is required.');
  if (!phone) throw new Error('Customer phone is required.');
  if (!Array.isArray(input.items) || input.items.length === 0) throw new Error('At least one item is required.');
  if (input.items.length > 10) throw new Error('A maximum of 10 items is allowed.');
  const items = input.items.map(calculatePilotItem);
  const subtotal = money(items.reduce((sum, item) => sum + item.amount, 0));
  const offer = input.offer || { kind: 'none' as const };
  let promotionType = '';
  let discountType = '無折扣';
  let discountMultiplier: number | null = null;
  let discountAmountHkd = 0;
  let discountReason = '';
  let deliveryOfferReason = String(input.deliveryOfferReason || '').trim();

  if (offer.kind === 'promotion') {
    promotionType = offer.promotionType;
    if (offer.promotionType === 'ToyTV 專屬優惠') {
      discountType = '指定金額扣減';
      discountAmountHkd = 200;
      discountReason = 'ToyTV 專屬優惠';
      deliveryOfferReason = 'ToyTV 專屬優惠免運費';
    } else if (offer.promotionType === '首次落單優惠') {
      discountType = '指定金額扣減';
      discountAmountHkd = items.some(item => item.itemType.includes('Display Case')) ? 500 : 300;
      discountReason = '新客戶優惠';
      deliveryOfferReason = '首次落單優惠';
    } else if (offer.promotionType === '新客戶免運費') {
      // Historical option kept for old records: delivery offer only, no cash discount.
      discountReason = '新客戶優惠';
      deliveryOfferReason = '首次落單優惠';
    }
  } else if (offer.kind === 'percentage') {
    discountMultiplier = Number(offer.multiplier);
    if (!Number.isFinite(discountMultiplier) || discountMultiplier < 0 || discountMultiplier > 1) {
      throw new Error('Discount multiplier must be between 0 and 1.');
    }
    discountReason = String(offer.reason || '').trim();
    if (!discountReason) throw new Error('Discount reason is required.');
    discountType = '百分比折扣';
  } else if (offer.kind === 'fixed') {
    discountAmountHkd = finiteNonNegative(offer.amountHkd, 'Discount amount');
    discountReason = String(offer.reason || '').trim();
    if (!discountReason) throw new Error('Discount reason is required.');
    discountType = '指定金額扣減';
  }

  let discountValueHkd = 0;
  if (discountType === '百分比折扣') {
    discountValueHkd = Math.max(0, subtotal * (1 - (discountMultiplier ?? 1)));
  } else if (discountType === '指定金額扣減') {
    discountValueHkd = Math.max(0, Math.min(discountAmountHkd, subtotal));
  }
  discountValueHkd = money(discountValueHkd);
  const finalTotal = Math.max(0, Math.ceil(subtotal - discountValueHkd));
  const discountDisplayText = discountValueHkd <= 0 ? '' :
    discountType === '百分比折扣' && discountMultiplier !== null
      ? `${discountReason}：${Math.round(discountMultiplier * 100) / 10}折優惠`
      : `${discountReason}：全單減 HKD $${Math.ceil(discountAmountHkd)}`;
  const deliveryDisplayText = deliveryOfferReason ? `已包本地送貨｜${deliveryOfferReason}` : '已包本地送貨';
  const quotedProfitTotal = money(items.reduce((sum, item) => sum + item.profit, 0));
  const quotedLocalDeliveryTotal = money(items.reduce((sum, item) => sum + item.hongKongDelivery, 0));
  const estimatedDriverPayableHkd = money(quotedLocalDeliveryTotal * DRIVER_SHARE_RATE);
  const estimatedCompanyDeliveryRetentionHkd = money(quotedLocalDeliveryTotal - estimatedDriverPayableHkd);
  const estimatedNetProfitHkd = money(
    quotedProfitTotal - discountValueHkd + estimatedCompanyDeliveryRetentionHkd,
  );
  const localDeliveryDeductedAsOffer = deliveryOfferReason.length > 0
    && discountValueHkd >= quotedLocalDeliveryTotal
    && quotedLocalDeliveryTotal > 0;
  const warnings: string[] = [];
  if (estimatedNetProfitHkd < 0) {
    warnings.push('優惠後 Estimated Net Profit 低於 HKD $0；最低利潤門檻仍為 Deferred，請由 Chrissie 決定。');
  }
  if (localDeliveryDeductedAsOffer) {
    warnings.push('優惠可能同時包含送貨扣減；請確認沒有把香港運費重複扣除。');
  }
  return {
    customer,
    phone,
    items,
    subtotal,
    promotionType,
    discountType,
    discountMultiplier,
    discountAmountHkd,
    discountReason,
    discountValueHkd,
    discountDisplayText,
    deliveryChargeMode: '已包本地送貨',
    deliveryOfferReason,
    deliveryDisplayText,
    quoteSourceChannel: String(input.quoteSourceChannel || ''),
    validUntil: String(input.validUntil || ''),
    customerMatch: input.customerMatch || 'supplied',
    offerPresetLabel: String(input.offerPresetLabel || ''),
    quotedProfitTotal,
    quotedLocalDeliveryTotal,
    estimatedDriverPayableHkd,
    estimatedCompanyDeliveryRetentionHkd,
    estimatedNetProfitHkd,
    estimatedNetProfitFormula:
      `Quoted Profit HKD $${quotedProfitTotal} - Discount deduction HKD $${discountValueHkd}`
      + ` + 香港送貨公司保留10% HKD $${estimatedCompanyDeliveryRetentionHkd}`
      + ` = HKD $${estimatedNetProfitHkd}`,
    review: {
      missingFields: [],
      duplicateDeductions: localDeliveryDeductedAsOffer,
      localDeliveryDeductedAsOffer,
      obviousUnderquoteRisk: estimatedNetProfitHkd < 0,
      warnings,
      summary: warnings.length
        ? '需要 Chrissie 核對上述風險；未有套用任何最低利潤門檻。'
        : '未發現漏計、重複扣減或明顯報少；最低利潤門檻仍為 Deferred。',
    },
    finalTotal,
  };
};

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

export const issueConfirmationId = (
  input: PilotQuoteInput,
  secret: string,
  now = Date.now(),
  nonce = crypto.randomBytes(12).toString('hex'),
): string => {
  if (!secret) throw new Error('Quote Pilot confirmation secret is not configured.');
  const preview = buildPilotPreview(input);
  const payload = Buffer.from(stableStringify({ v: 1, issuedAt: now, nonce, input, preview }), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
};

export const verifyConfirmationId = (
  confirmationId: string,
  secret: string,
  now = Date.now(),
): { input: PilotQuoteInput; preview: PilotPreview } => {
  const [payload, signature, extra] = String(confirmationId || '').split('.');
  if (!payload || !signature || extra) throw new Error('Invalid confirmation ID.');
  const expected = crypto.createHmac('sha256', secret).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) throw new Error('Invalid confirmation ID.');
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    v: number; issuedAt: number; input: PilotQuoteInput; preview: PilotPreview;
  };
  if (decoded.v !== 1 || !Number.isFinite(decoded.issuedAt)) throw new Error('Invalid confirmation ID.');
  if (now - decoded.issuedAt > PILOT_CONFIRMATION_TTL_MS || decoded.issuedAt > now + 60_000) {
    throw new Error('Confirmation ID has expired. Generate a new preview.');
  }
  const recalculated = buildPilotPreview(decoded.input);
  if (stableStringify(recalculated) !== stableStringify(decoded.preview)) throw new Error('Confirmation preview mismatch.');
  return { input: decoded.input, preview: recalculated };
};

export const idempotencyPublicToken = (confirmationId: string, secret: string): string =>
  crypto.createHmac('sha256', secret).update(`quote:${confirmationId}`).digest('hex').slice(0, 32);

export const toCreateQuoteBody = (input: PilotQuoteInput, preview: PilotPreview) => ({
  quoteLanguage: '中文',
  contactName: preview.customer,
  phone: preview.phone,
  contactMethod: input.contactMethod || 'WhatsApp',
  contactHandle: '',
  quoteSourceChannel: input.quoteSourceChannel || '',
  validUntil: input.validUntil || '',
  items: preview.items,
  subtotal: preview.subtotal,
  promotionType: preview.promotionType,
  discountType: preview.discountType,
  discountMultiplier: preview.discountMultiplier ?? '',
  discountAmountHkd: preview.discountAmountHkd,
  discountReason: preview.discountReason,
  discountValueHkd: preview.discountValueHkd,
  discountDisplayText: preview.discountDisplayText,
  deliveryChargeMode: preview.deliveryChargeMode,
  deliveryOfferReason: preview.deliveryOfferReason,
  deliveryDisplayText: preview.deliveryDisplayText,
  notes: '',
  terms: '',
});
