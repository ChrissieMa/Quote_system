import type { PilotItemInput, PilotOffer } from './quote-pilot';

export type ShortQuoteReady = {
  kind: 'ready';
  phone: string;
  itemType: PilotItemInput['itemType'];
  innerDimensions: PilotItemInput['innerDimensions'];
  quantity: number;
  accessories: Record<string, number>;
  chinaFreight: number;
  hongKongDelivery: number;
  profit: number;
  sourceAlias: string;
  offerCode: 'none' | 'box-300' | 'case-500' | 'legacy' | 'custom';
  customDiscountAmount?: number;
  customDiscountReason?: string;
  validUntilDays: number;
};

export type ShortQuoteClarification = {
  kind: 'clarification';
  code: string;
  message: string;
  options?: string[];
};

export type ShortQuoteParseResult = ShortQuoteReady | ShortQuoteClarification;

const SOURCE_ALIASES: Array<[RegExp, string]> = [
  [/(?:^|\s)FB(?:\s|$)/i, 'FB'],
  [/(?:^|\s)IG(?:\s|$)/i, 'IG'],
  [/(?:^|\s)Google Search(?:\s|$)/i, 'Google Search'],
  [/(?:^|\s)Google Organic(?:\s|$)/i, 'Google Organic'],
  [/(?:^|\s)Google(?:\s|$)/i, 'Google'],
  [/(?:^|\s)介紹(?:\s|$)/, '介紹'],
  [/(?:^|\s)舊客(?:\s|$)/, '舊客'],
  [/(?:^|\s)其他(?:\s|$)/, '其他'],
  [/(?:^|\s)Meta(?:\s|$)/i, 'Meta'],
  [/(?:^|\s)WhatsApp(?:\s|$)/i, 'WhatsApp'],
  [/(?:^|\s)Website(?:\s|$)/i, 'Website'],
];

const OFFER_PATTERNS: Array<[RegExp, ShortQuoteReady['offerCode']]> = [
  [/(?:^|\s)無優惠(?:\s|$)/, 'none'],
  [/(?:^|\s)盒-?300(?:\s|$)/i, 'box-300'],
  [/(?:^|\s)櫃-?500(?:\s|$)/i, 'case-500'],
  [/(?:^|\s)舊報價保留(?:\s|$)/, 'legacy'],
  [/(?:^|\s)自訂(?:-\s*)?\d*(?:\s|$)/, 'custom'],
];

const ACCESSORY_ALIASES: Array<[RegExp, string]> = [
  [/趟門/, '趟門'],
  [/磁石門/, '磁石門'],
  [/樓梯/, '樓梯'],
  [/黑底板/, '黑底板'],
  [/透明底板/, '透明底板'],
  [/(?:獨立燈板\s*-\s*)?上燈/, '獨立燈板 - 上燈'],
  [/(?:獨立燈板\s*-\s*)?下燈/, '獨立燈板 - 下燈'],
  [/(?:獨立燈板\s*-\s*)?上下燈/, '獨立燈板 - 上下燈'],
  [/背圖|背板圖片/, '背板圖片'],
  [/左圖|左板圖片/, '左板圖片'],
  [/右圖|右板圖片/, '右板圖片'],
  [/底圖|底板圖片/, '底板圖片'],
  [/頂圖|頂板圖片/, '頂板圖片'],
  [/背燈/, '背燈'],
  [/前板白色刻字|白字/, '前板白色刻字'],
  [/前板彩色刻字|彩字/, '前板彩色刻字'],
];

const numberAfter = (text: string, pattern: RegExp): number | null => {
  const match = text.match(pattern);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 0 ? value : null;
};

export const parseShortQuoteText = (raw: string): ShortQuoteParseResult => {
  const text = String(raw || '')
    .trim()
    .replace(/^Blue\s*[,，:：]?\s*/i, '')
    .replace(/\s+/g, ' ');
  if (!text) return { kind: 'clarification', code: 'empty', message: '請提供報價資料。' };

  const phoneMatch = text.match(/(?:^|\s)(\d{8})(?:\s|$)/);
  const dimensionsMatch = text.match(/(\d+(?:\.\d+)?)\s*[xX×*]\s*(\d+(?:\.\d+)?)\s*[xX×*]\s*(\d+(?:\.\d+)?)/);
  const quantityMatch = text.match(/(?:^|\s)(\d+)\s*(?:個|件|pcs?)(?:\s|$)/i);
  const chinaFreight = numberAfter(text, /內(?:地)?運(?:費)?\s*\$?\s*(\d+(?:\.\d+)?)/);
  const hongKongDelivery = numberAfter(text, /(?:港運(?:費)?|香港運(?:費)?)\s*\$?\s*(\d+(?:\.\d+)?)/);
  const profit = numberAfter(text, /(?:^|\s)利(?:潤)?\s*\$?\s*(\d+(?:\.\d+)?)(?:\s|$)/);
  const validDays = numberAfter(text, /有效(?:期)?\s*(\d+)\s*日/);

  let itemType: PilotItemInput['itemType'] | null = null;
  if (/(?:^|\s)(?:盒|展示盒)(?:\s|$)/.test(text)) itemType = 'Display box 展示盒';
  if (/(?:^|\s)(?:櫃|展示櫃|疊高展示櫃)(?:\s|$)/.test(text)) {
    if (itemType) {
      return {
        kind: 'clarification',
        code: 'product-conflict',
        message: '產品類型同時出現「盒」及「櫃」，請只選一項。',
        options: ['展示盒', '疊高展示櫃', '取消'],
      };
    }
    itemType = 'Display Case 疊高展示櫃';
  }

  const sourceMatches = SOURCE_ALIASES.filter(([pattern]) => pattern.test(text)).map(([, alias]) => alias);
  const uniqueSources = Array.from(new Set(sourceMatches));
  if (uniqueSources.length > 1) {
    return {
      kind: 'clarification',
      code: 'source-conflict',
      message: `查詢來源有衝突：${uniqueSources.join('、')}。請只選一項。`,
      options: [...uniqueSources, '取消'],
    };
  }

  const offerMatches = OFFER_PATTERNS.filter(([pattern]) => pattern.test(text)).map(([, code]) => code);
  const uniqueOffers = Array.from(new Set(offerMatches));
  if (uniqueOffers.length > 1) {
    return {
      kind: 'clarification',
      code: 'offer-conflict',
      message: `優惠不可疊加：偵測到 ${uniqueOffers.join('、')}。請選擇保留一項或取消。`,
      options: [...uniqueOffers.map(code => `只保留 ${code}`), '取消'],
    };
  }

  const missing: string[] = [];
  if (!phoneMatch) missing.push('客戶電話');
  if (!itemType) missing.push('產品類型');
  if (!dimensionsMatch) missing.push('內尺寸');
  if (chinaFreight === null) missing.push('內地運費');
  if (hongKongDelivery === null) missing.push('香港運費');
  if (profit === null) missing.push('Quoted Profit');
  if (!uniqueSources.length) missing.push('查詢來源');
  if (!uniqueOffers.length) missing.push('優惠簡碼（可用「無優惠」）');
  if (missing.length) {
    return {
      kind: 'clarification',
      code: 'missing-fields',
      message: `尚欠：${missing.join('、')}。請用一行補充。`,
    };
  }

  const accessories: Record<string, number> = {};
  for (const [pattern, formalName] of ACCESSORY_ALIASES) {
    if (pattern.test(text)) accessories[formalName] = 1;
  }

  const customAmount = uniqueOffers[0] === 'custom'
    ? numberAfter(text, /自訂(?:-\s*)?(\d+(?:\.\d+)?)/)
    : null;
  const customReasonMatch = text.match(/自訂(?:-\s*)?\d+(?:\.\d+)?\s+(首次落單優惠|回購優惠|新客戶優惠|ToyTV 專屬優惠)/);

  return {
    kind: 'ready',
    phone: phoneMatch![1],
    itemType: itemType!,
    innerDimensions: {
      length: Number(dimensionsMatch![1]),
      depth: Number(dimensionsMatch![2]),
      height: Number(dimensionsMatch![3]),
    },
    quantity: quantityMatch ? Number(quantityMatch[1]) : 1,
    accessories,
    chinaFreight: chinaFreight!,
    hongKongDelivery: hongKongDelivery!,
    profit: profit!,
    sourceAlias: uniqueSources[0],
    offerCode: uniqueOffers[0],
    customDiscountAmount: customAmount ?? undefined,
    customDiscountReason: customReasonMatch?.[1],
    validUntilDays: validDays ?? 7,
  };
};

export const resolveSourceAlias = (
  alias: string,
  productionOptions: string[],
): { value?: string; clarification?: ShortQuoteClarification } => {
  const exactMap: Record<string, string> = {
    FB: 'Facebook Organic',
    IG: 'Instagram Organic',
    'Google Search': 'Google Search',
    'Google Organic': 'Google Organic',
    '介紹': 'Referral',
    '舊客': 'Returning Customer',
    '其他': 'Other',
    Meta: 'Meta Ads',
    WhatsApp: 'WhatsApp Direct',
    Website: 'Website',
  };
  if (alias === 'Google') {
    const options = ['Google Search', 'Google Organic'].filter(option => productionOptions.includes(option));
    return {
      clarification: {
        kind: 'clarification',
        code: 'source-ambiguous',
        message: 'Google 無法準確判斷是付費搜尋或自然搜尋，請選擇一項。',
        options,
      },
    };
  }
  const value = exactMap[alias];
  if (!value || !productionOptions.includes(value)) {
    return {
      clarification: {
        kind: 'clarification',
        code: 'source-unmapped',
        message: `「${alias}」未能映射至 production 現有正式選項，請重新選擇。`,
        options: productionOptions,
      },
    };
  }
  return { value };
};

export const resolveOfferPreset = (
  parsed: ShortQuoteReady,
  discountReasonOptions: string[],
): { offer?: PilotOffer; label?: string; clarification?: ShortQuoteClarification } => {
  if (parsed.offerCode === 'none') return { offer: { kind: 'none' }, label: '無優惠' };
  if (parsed.offerCode === 'legacy') {
    return {
      clarification: {
        kind: 'clarification',
        code: 'legacy-offer-reference-required',
        message: '「舊報價保留」需要舊 Quote No 或需保留的實際扣減金額，才可安全預覽。',
        options: ['提供舊 Quote No', '提供扣減金額', '取消'],
      },
    };
  }
  if (parsed.offerCode === 'box-300' && parsed.itemType !== 'Display box 展示盒') {
    return {
      clarification: {
        kind: 'clarification',
        code: 'offer-product-conflict',
        message: '「盒-300」只適用於展示盒；目前產品是展示櫃。',
        options: ['改用 櫃-500', '改產品為展示盒', '取消優惠'],
      },
    };
  }
  if (parsed.offerCode === 'case-500' && parsed.itemType !== 'Display Case 疊高展示櫃') {
    return {
      clarification: {
        kind: 'clarification',
        code: 'offer-product-conflict',
        message: '「櫃-500」只適用於展示櫃；目前產品是展示盒。',
        options: ['改用 盒-300', '改產品為展示櫃', '取消優惠'],
      },
    };
  }

  let amount = parsed.offerCode === 'box-300' ? 300 : parsed.offerCode === 'case-500' ? 500 : parsed.customDiscountAmount;
  let reason = parsed.offerCode === 'custom' ? parsed.customDiscountReason : '新客戶優惠';
  if (parsed.offerCode === 'custom' && (!Number.isFinite(amount) || amount! < 0 || !reason)) {
    return {
      clarification: {
        kind: 'clarification',
        code: 'custom-offer-details-required',
        message: '自訂優惠請一次提供扣減金額及 production 現有折扣原因。',
        options: discountReasonOptions.map(option => `自訂-金額 ${option}`),
      },
    };
  }
  if (!reason || !discountReasonOptions.includes(reason)) {
    return {
      clarification: {
        kind: 'clarification',
        code: 'offer-reason-unmapped',
        message: '優惠未能映射至 production 現有正式折扣原因。',
        options: discountReasonOptions,
      },
    };
  }
  const label = parsed.offerCode === 'box-300'
    ? '盒-300'
    : parsed.offerCode === 'case-500'
      ? '櫃-500'
      : `自訂-$${amount}`;
  return {
    offer: { kind: 'fixed', amountHkd: Number(amount), reason },
    label,
  };
};
