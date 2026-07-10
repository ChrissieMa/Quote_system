import express, { Request, Response } from 'express';
import Airtable, { FieldSet } from 'airtable';
import dotenv from 'dotenv';
import crypto from 'crypto';

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

const LOGO_URL = 'https://d2xsxph8kpxj0f.cloudfront.net/310519663253730031/dEsUrrvecqqFg5CteTMEZc/LKSnewLOGO%E9%80%8F%E6%98%8E2023_2674f8ba.png';

// ─── Helpers ───────────────────────────────────────────────────────────────
const generateToken = () => crypto.randomBytes(16).toString('hex');

const cleanEnv = (value: string | undefined, fallback: string): string => {
  const v = (value || '').trim();
  if (!v) return fallback;
  const placeholders = [
    '+852 1234 5678', '12345678', 'info@lksdisplaybox.com', 'your company address here',
    'your_airtable_api_key_here', 'your_airtable_base_id_here'
  ].map(s => s.toLowerCase());
  return placeholders.includes(v.toLowerCase()) ? fallback : v;
};

const parseQuoteItems = (raw: unknown): any[] => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as any[];
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.items)) return obj.items as any[];
    return [];
  }
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return [];
    try {
      const parsed = JSON.parse(s);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
};

const COMPANY = {
  name: process.env.COMPANY_NAME || 'LKS Display Box',
  address1: '香港九龍觀塘成業街7號',
  address2: '寧晉中心35樓G1室',
  phone: process.env.COMPANY_PHONE || '68983722',
  email: process.env.COMPANY_EMAIL || 'lksdisplaybox@gmail.com',
  website: process.env.COMPANY_WEBSITE || 'https://lksdisplaybox.online',
};


const DEFAULT_TERMS = `1. 本報價僅供參考，所有尺寸、設計及細節需經客戶確認後方為最終訂單依據。
2. 客戶需自行量度展示物品尺寸，本公司提供之尺寸建議（包括預留約5–10cm空間）僅供參考用途，最終尺寸需由客戶確認，本公司不會就尺寸不合適承擔責任。
3. 所有產品均為訂製產品，訂單確認後恕不接受取消或退款；如需更改尺寸或設計，可能需重新報價及安排製作時間。
4. 本報價之優惠或折扣只於指定期間內有效，逾期將不再適用，本公司保留最終決定權。
5. 訂單確認後將安排生產，一般發貨時間約為30個工作天，長假期可能延長，實際時間視乎訂單情況而定。
6. 本公司不接受因生產或發貨延遲而提出退款之要求。
7. 如因送貨地點之環境限制（包括門口尺寸、樓梯、電梯或通道空間等）導致無法順利送貨或需額外安排，本公司恕不承擔相關責任或費用。
8. 客戶需於收貨時即時檢查產品，如有問題請即時提出，否則視為驗收完成。
9. 如產品因不當使用、人為損壞或自行安裝不當而造成損壞，本公司概不負責。
10. 展示盒為亞加力製品，可能出現輕微加工痕跡，屬正常情況。
11. LKS Display Box 保留最終報價及訂單之決定權。`;

const DEFAULT_PAYMENT_TERMS = `1. 所有訂單均需於確認後支付全數貨款，本公司將於收到全數付款後開始生產。
2. 完成製作後，本公司將根據貨物及包裝後之實際重量計算運費，並另行發出運費發票（Invoice）。
3. 客戶需於送貨前支付相關運費，否則本公司有權暫停或延遲送貨安排。
4. 運費會因貨物重量、尺寸及送貨地點而有所不同，實際金額以最終發出之運費發票為準。
5. 本公司保留最終收費及送貨安排之決定權。`;

const DEFAULT_PAYMENT_TERMS_EN = `1. Full payment is required after order confirmation. Production will begin after full payment is received.
2. After production is completed, LKS Display Box will confirm delivery arrangements according to the order and delivery location.
3. If the order is marked as local delivery included, no separate local delivery fee is required unless there are special delivery arrangements.
4. If the order is marked as LKS fleet delivery fee payable separately, the customer is responsible for the related delivery fee before delivery.
5. LKS Display Box reserves the final decision on payment, delivery and order arrangements.`;

const DEFAULT_QUOTE_NOTES = `💡 所有優惠必須 Like Facebook Page 並分享指定 Post 才能享有優惠💡

🤏🏻 全港少數採用 5MM 高清厚板製作展示盒及展示櫃 🤏🏻
💫 購買任何展示盒或展示櫃，附送趟門或磁石門。💫
➕ 加購優惠 ➕ 如加購背景或刻字，即免費設計及修圖。
💡 獨立燈板 💡 獨立燈板與展示盒分體設計，方便日後升級成疊高展示櫃，燈板亦可靈活轉為上燈或下燈 🚪`;

const DEFAULT_QUOTE_NOTES_EN = `💡 All offers are only valid after liking our Facebook Page and sharing the designated post. 💡

🤏🏻 LKS Display Box is one of the few Hong Kong brands using 5MM high-clarity thick acrylic panels for display boxes and display cases. 🤏🏻
💫 Any display box or display case order includes a sliding door or magnetic door. 💫
➕ Add-on offer ➕ Add a background or engraving and enjoy free design and image retouching.
💡 Independent light board 💡 The independent light board is separate from the display box, making it easier to upgrade into a stackable display case later. The light board can also be used flexibly as a top light or bottom light. 🚪`;

const DEFAULT_TERMS_EN = `1. This quotation is for reference only. All sizes, design details and specifications must be confirmed by the customer before the order is finalized.
2. Customers are responsible for measuring their display items. Size suggestions provided by LKS Display Box, including the recommended 5–10cm clearance, are for reference only. The final size must be confirmed by the customer.
3. All products are custom-made. Once an order is confirmed, cancellation or refund is not accepted. Any change in size or design may require a new quotation and production schedule.
4. Offers or discounts shown in this quotation are valid only within the specified period. LKS Display Box reserves the final decision.
5. Production will be arranged after order confirmation. Standard production time is around 30 working days. Public holidays or peak seasons may require additional time.
6. Refund requests due to production or delivery delay will not be accepted.
7. If delivery is affected by site restrictions, including doorway size, stairs, lift access or corridor space, LKS Display Box shall not be responsible for related costs or issues.
8. Customers should inspect the product upon delivery. Any issue should be reported immediately; otherwise the product will be treated as accepted.
9. LKS Display Box is not responsible for damage caused by misuse, human damage or incorrect self-installation.
10. Acrylic products may have minor production marks, which are considered normal.
11. LKS Display Box reserves the final decision on all quotations and orders.`;

const MATERIAL_NOTE_EN = 'All LKS display boxes and display cases are made with 5MM high-clarity acrylic panels';

const MATERIAL_NOTE = '本公司全線展示盒及展示櫃均採用 5MM 高清亞加力厚板製作';
const renderPaymentMethodHtml = (isEnglish = false): string => `
  <div class="section">
    <div class="section-title">${isEnglish ? 'Payment Method' : '付款方式'}</div>
    <div class="payment-grid">
      <div class="payment-card">
        <div class="payment-title">${isEnglish ? 'Bank Transfer' : '銀行轉帳'}</div>
        <div>${isEnglish ? 'Bank: HSBC' : '銀行：HSBC'}</div>
        <div>${isEnglish ? 'Account: 582 664 967 838' : '帳號：582 664 967 838'}</div>
      </div>
      <div class="payment-card">
        <div class="payment-title">${isEnglish ? 'FPS' : '轉數快 (FPS)'}</div>
        <div>${isEnglish ? 'Phone number: 68983722' : '電話號碼：68983722'}</div>
      </div>
      <div class="payment-card">
        <div class="payment-title">PayMe</div>
        <div><a href="https://qr.payme.hsbc.com.hk/2/EjV1LxhqMwvqL6h5MN9n3r" target="_blank" rel="noopener noreferrer">${isEnglish ? 'Pay now' : '按此即時付款'}</a></div>
      </div>
    </div>
  </div>`;

// Check required env vars
const requiredEnvVars = [
  'AIRTABLE_API_KEY',
  'AIRTABLE_BASE_ID',
  'AIRTABLE_TABLE_CUSTOMERS',
  'AIRTABLE_TABLE_ORDERS',
  'AIRTABLE_TABLE_ORDER_ITEMS',
  'AIRTABLE_TABLE_QUOTES'
];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

// Airtable Setup
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID!);
const tableCustomers = base(process.env.AIRTABLE_TABLE_CUSTOMERS!);
const tableCustomersActive = base(process.env.AIRTABLE_TABLE_CUSTOMERS_ACTIVE || 'Customers (Active)');
const tableOrders = base(process.env.AIRTABLE_TABLE_ORDERS!);
const tableOrderItems = base(process.env.AIRTABLE_TABLE_ORDER_ITEMS!);
const tableQuotes = base(process.env.AIRTABLE_TABLE_QUOTES!);
const tableInquiries = base(process.env.AIRTABLE_TABLE_INQUIRIES || 'Inquiries');
const tableMonthlyPerformance = base(process.env.AIRTABLE_TABLE_MONTHLY_PERFORMANCE || 'Monthly Performance');

const normalizeQuoteLanguage = (value: unknown): '中文' | 'English' =>
  String(value || '').trim() === 'English' ? 'English' : '中文';

const isEnglishLanguage = (value: unknown): boolean => normalizeQuoteLanguage(value) === 'English';

const mapDiscountReasonEn = (reason: string): string => {
  const map: Record<string, string> = {
    'ToyTV 專屬優惠': 'ToyTV exclusive offer',
    '新客戶優惠': 'New customer offer',
    '回購優惠': 'Returning customer offer'
  };
  return map[reason] || reason || 'Offer discount';
};

const buildDisplayDiscountText = (fields: FieldSet, isEnglish: boolean): string => {
  if (!isEnglish) return (fields['Discount Display Text'] as string) || '';
  const reason = mapDiscountReasonEn(String(fields['Discount Reason'] || ''));
  const type = String(fields['Discount Type'] || '');
  const amount = Number(fields['Discount Amount HKD'] || 0);
  const multiplier = Number(fields['Discount Multiplier'] || 0);
  if (type === '指定金額扣減' && amount > 0) return `${reason}: HKD $${Math.ceil(amount)} off`;
  if (type === '百分比折扣' && multiplier > 0) return `${reason}: ${Math.round((1 - multiplier) * 100)}% off`;
  return 'Offer discount';
};

const buildDisplayDeliveryText = (
  fields: FieldSet,
  isEnglish: boolean,
  localDeliveryAmount = 0,
  validUntil?: unknown
): string => buildDeliveryWaiverText(fields, isEnglish, localDeliveryAmount, validUntil);

const getOrderLanguageFromSourceQuote = async (orderFields: FieldSet): Promise<'中文' | 'English'> => {
  if (orderFields['Quote Language']) return normalizeQuoteLanguage(orderFields['Quote Language']);
  const sourceQuoteRef = (orderFields['Source Quote Ref'] as string) || '';
  if (!sourceQuoteRef) return '中文';
  try {
    const quoteRecords = await tableQuotes.select({ filterByFormula: `{Quote Number} = '${sourceQuoteRef.replace(/'/g, "\\'")}'` }).firstPage();
    if (quoteRecords.length > 0) return normalizeQuoteLanguage(quoteRecords[0].fields['Quote Language']);
  } catch (error) {
    console.error('Failed to read source quote language:', error);
  }
  return '中文';
};

const escapeHtml = (unsafe: unknown): string =>
  String(unsafe ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const nl2br = (str: unknown): string =>
  escapeHtml(str).replace(/\n/g, '<br>');


const sumQuoteLocalDelivery = (items: any[]): number =>
  (Array.isArray(items) ? items : []).reduce((sum, item) => {
    const value = Number(item?.hongKongDelivery ?? item?.deliveryCostReserve ?? item?.localDelivery ?? 0);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);

const buildDeliveryFeeRange = (localDeliveryAmount: number): string => {
  const amount = Number(localDeliveryAmount) || 0;
  if (amount <= 0) return '';
  const lower = Math.ceil(amount / 100) * 100;
  const upper = lower + 100;
  return `HK$${lower}–$${upper}`;
};

const formatDeliveryOfferReasonZh = (reason: string): string => {
  if (reason === '新客戶免運費' || reason === '首次落單優惠') return '首次落單優惠';
  return reason || '';
};

const formatDeliveryOfferReasonEn = (reason: string): string => {
  const reasonMap: Record<string, string> = {
    '新客戶免運費': 'First order offer',
    '首次落單優惠': 'First order offer',
    'ToyTV 專屬優惠免運費': 'ToyTV exclusive free delivery offer'
  };
  return reasonMap[reason] || reason || '';
};

const buildDeliveryWaiverText = (
  fields: FieldSet,
  isEnglish: boolean,
  localDeliveryAmount = 0,
  validUntil?: unknown
): string => {
  const mode = String(fields['Delivery Charge Mode'] || '');
  const reason = String(fields['Delivery Offer Reason'] || '');
  const range = buildDeliveryFeeRange(localDeliveryAmount);
  const validUntilText = String(validUntil || fields['Valid Until'] || '').trim();

  if (mode !== '已包本地送貨') {
    if (isEnglish && mode === 'LKS 車隊 運費到付') return 'LKS fleet delivery fee payable separately';
    return mode || '';
  }

  if (isEnglish) {
    const firstLine = reason
      ? `Local delivery included | ${formatDeliveryOfferReasonEn(reason)}`
      : 'Local delivery included';
    const lines = [firstLine];
    if (range) lines.push(`Delivery fee is calculated by weight | Estimated delivery fee approx. ${range}, now waived`);
    if (validUntilText) lines.push(`Offer valid until quotation valid-until date: ${validUntilText}`);
    return lines.join('\n');
  }

  const firstLine = reason
    ? `已包本地送貨｜${formatDeliveryOfferReasonZh(reason)}`
    : '已包本地送貨';
  const lines = [firstLine];
  if (range) lines.push(`運費以重量計算｜預計運費約 ${range}，現已豁免`);
  if (validUntilText) lines.push(`優惠有效期為此報價有效期 ${validUntilText}`);
  return lines.join('\n');
};

// Normalize Hong Kong phone numbers so formats such as
// 68983722, 6898 3722 and +852 6898 3722 are treated as the same number.
const normalizePhone = (value: unknown): string => {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('852')) digits = digits.slice(3);
  return digits;
};

const findCustomerByPhone = async (phone: unknown) => {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  const customers = await tableCustomers.select({ fields: ['Phone'] }).all();
  return customers.find((customer: any) => normalizePhone(customer.fields['Phone']) === normalized) || null;
};

const getLinkedRecordId = (value: unknown): string | null => {
  if (!Array.isArray(value) || value.length === 0) return null;
  const first = value[0] as any;
  if (typeof first === 'string') return first;
  if (first && typeof first.id === 'string') return first.id;
  return null;
};

const getCustomerText = (fields: FieldSet, fieldName: string): string =>
  String(fields[fieldName] ?? '').trim();

const buildCustomerSearchDisplay = (fields: FieldSet): string => {
  const customerId = getCustomerText(fields, 'Customer ID') || getCustomerText(fields, 'Customer Display');
  const name = getCustomerText(fields, 'Customer Name');
  const phone = getCustomerText(fields, 'Phone');
  return [customerId, name, phone].filter(Boolean).join(' | ');
};

const buildLegacyCustomerSearchDisplay = (fields: FieldSet): string => {
  const legacyRef = getCustomerText(fields, 'Customer Display');
  const company = getCustomerText(fields, 'Company Name');
  const name = getCustomerText(fields, 'Last Name');
  const phone = getCustomerText(fields, 'MobilePhone') || getCustomerText(fields, 'Shipping Phone');
  return [legacyRef, company || name, phone].filter(Boolean).join(' | ');
};

const buildLegacyNotes = (fields: FieldSet): string => {
  const lines = [
    getCustomerText(fields, 'CF.Find Us') ? `Find Us: ${getCustomerText(fields, 'CF.Find Us')}` : '',
    getCustomerText(fields, 'CF.Social Media') ? `Social Media: ${getCustomerText(fields, 'CF.Social Media')}` : '',
    getCustomerText(fields, 'CF.Keyword') ? `Keyword: ${getCustomerText(fields, 'CF.Keyword')}` : '',
    getCustomerText(fields, 'CF.Why choose us') ? `Why choose us: ${getCustomerText(fields, 'CF.Why choose us')}` : '',
    getCustomerText(fields, 'Department') ? `Department: ${getCustomerText(fields, 'Department')}` : '',
    getCustomerText(fields, 'Designation') ? `Designation: ${getCustomerText(fields, 'Designation')}` : '',
  ].filter(Boolean);
  return lines.join('\n');
};

const activateLegacyCustomer = async (legacyRecordId: string) => {
  const legacy = await tableCustomersActive.find(legacyRecordId);
  const f = legacy.fields;

  const legacyRef = getCustomerText(f, 'Customer Display');
  const legacyCustomerId = extractCustomerId(legacyRef);
  const companyName = getCustomerText(f, 'Company Name');
  const name = getCustomerText(f, 'Last Name') || companyName || legacyRef;
  const mobilePhone = getCustomerText(f, 'MobilePhone');
  const shippingPhone = getCustomerText(f, 'Shipping Phone');
  const primaryPhone = mobilePhone || shippingPhone;
  const alternatePhone = shippingPhone && normalizePhone(shippingPhone) !== normalizePhone(primaryPhone) ? shippingPhone : '';
  const email = getCustomerText(f, 'EmailID');
  const address = getCustomerText(f, 'Shipping Address');
  const legacyNotes = buildLegacyNotes(f);

  const existingByPrimary = await findCustomerByPhone(primaryPhone);
  const existingByAlternate = !existingByPrimary && alternatePhone ? await findCustomerByPhone(alternatePhone) : null;
  const existing = existingByPrimary || existingByAlternate;

  const legacyFields: FieldSet = {
    'Customer ID': legacyCustomerId || await getNextCustomerId(),
    'Customer Name': name,
    'Phone': primaryPhone,
    'Email': email,
    'Address': address,
    'Customer Status': 'Legacy Activated',
    'Legacy Customer Ref': legacyRef,
    'Alternate Phone': alternatePhone,
    'Company Name': companyName,
    'Legacy Notes': legacyNotes,
  };

  if (existing) {
    const existingCustomerId = extractCustomerId(existing.fields['Customer ID']);
    await tableCustomers.update([{
      id: existing.id,
      fields: {
        ...(!existingCustomerId ? { 'Customer ID': legacyCustomerId || await getNextCustomerId() } : {}),
        'Customer Status': 'Legacy Activated',
        'Legacy Customer Ref': legacyRef,
        'Alternate Phone': alternatePhone,
        'Company Name': companyName,
        'Legacy Notes': legacyNotes,
      } as FieldSet
    }]);
    const updated = await tableCustomers.find(existing.id);
    return updated;
  }

  const created = await tableCustomers.create([{ fields: legacyFields }]);
  return created[0];
};

const searchCustomers = async (query: unknown) => {
  const q = String(query ?? '').trim().toLowerCase();
  const normalizedQ = normalizePhone(q);
  if (!q && !normalizedQ) return [];

  const officialRecords = await tableCustomers.select({
    fields: ['Customer Display', 'Customer ID', 'Customer Name', 'Phone', 'Email', 'Address']
  }).all();

  const officialResults = officialRecords
    .filter((record: any) => {
      const f = record.fields;
      const textFields = [
        getCustomerText(f, 'Customer Display'),
        getCustomerText(f, 'Customer ID'),
        getCustomerText(f, 'Customer Name'),
        getCustomerText(f, 'Phone'),
        getCustomerText(f, 'Email'),
        getCustomerText(f, 'Address'),
      ].map(v => v.toLowerCase());

      const textMatch = textFields.some(v => v.includes(q));
      const phoneMatch = normalizedQ.length >= 4 && normalizePhone(getCustomerText(f, 'Phone')).includes(normalizedQ);
      return textMatch || phoneMatch;
    })
    .map((record: any) => {
      const f = record.fields;
      return {
        source: 'customers',
        id: record.id,
        display: buildCustomerSearchDisplay(f),
        customerId: getCustomerText(f, 'Customer ID'),
        name: getCustomerText(f, 'Customer Name'),
        phone: getCustomerText(f, 'Phone'),
        email: getCustomerText(f, 'Email'),
        address: getCustomerText(f, 'Address'),
      };
    });

  const legacyRecords = await tableCustomersActive.select({
    fields: ['Customer Display', 'Company Name', 'Last Name', 'Shipping Address', 'Shipping Phone', 'EmailID', 'MobilePhone', 'CF.Find Us', 'CF.Social Media', 'CF.Keyword', 'CF.Why choose us', 'Department', 'Designation']
  }).all();

  const legacyResults = legacyRecords
    .filter((record: any) => {
      const f = record.fields;
      const textFields = [
        getCustomerText(f, 'Customer Display'),
        getCustomerText(f, 'Company Name'),
        getCustomerText(f, 'Last Name'),
        getCustomerText(f, 'Shipping Address'),
        getCustomerText(f, 'Shipping Phone'),
        getCustomerText(f, 'EmailID'),
        getCustomerText(f, 'MobilePhone'),
      ].map(v => v.toLowerCase());

      const textMatch = textFields.some(v => v.includes(q));
      const phoneMatch = normalizedQ.length >= 4 && [getCustomerText(f, 'MobilePhone'), getCustomerText(f, 'Shipping Phone')]
        .map(normalizePhone)
        .some(value => value.includes(normalizedQ));
      return textMatch || phoneMatch;
    })
    .map((record: any) => {
      const f = record.fields;
      const mobilePhone = getCustomerText(f, 'MobilePhone');
      const shippingPhone = getCustomerText(f, 'Shipping Phone');
      return {
        source: 'legacy',
        id: record.id,
        display: buildLegacyCustomerSearchDisplay(f),
        customerId: getCustomerText(f, 'Customer Display'),
        name: getCustomerText(f, 'Last Name') || getCustomerText(f, 'Company Name'),
        phone: mobilePhone || shippingPhone,
        email: getCustomerText(f, 'EmailID'),
        address: getCustomerText(f, 'Shipping Address'),
        companyName: getCustomerText(f, 'Company Name'),
        alternatePhone: shippingPhone && normalizePhone(shippingPhone) !== normalizePhone(mobilePhone || shippingPhone) ? shippingPhone : '',
      };
    });

  return [...officialResults, ...legacyResults].slice(0, 20);
};

const getNextNumber = async (
  table: Airtable.Table<FieldSet>,
  field: string,
  prefix: string
): Promise<string> => {
  const records = await table
    .select({ fields: [field], sort: [{ field, direction: 'desc' }], maxRecords: 1 })
    .firstPage();
  if (records.length === 0 || !records[0].get(field)) return `${prefix}-2026-0001`;
  const lastNumber = records[0].get(field) as string;
  const match = lastNumber.match(/-(\d+)$/);
  if (match) {
    const next = parseInt(match[1], 10) + 1;
    return `${prefix}-2026-${next.toString().padStart(4, '0')}`;
  }
  return `${prefix}-2026-0001`;
};

const getHongKongDate = (): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

const extractCustomerId = (value: unknown): string => {
  const match = String(value ?? '').trim().toUpperCase().match(/^L(\d{1,4})$/);
  return match ? `L${match[1].padStart(4, '0')}` : '';
};

const getNextCustomerId = async (): Promise<string> => {
  const [officialCustomers, legacyCustomers] = await Promise.all([
    tableCustomers.select({ fields: ['Customer ID'] }).all(),
    tableCustomersActive.select({ fields: ['Customer Display'] }).all(),
  ]);

  const numbers = [
    ...officialCustomers.map((record: any) => extractCustomerId(record.fields['Customer ID'])),
    ...legacyCustomers.map((record: any) => extractCustomerId(record.fields['Customer Display'])),
  ]
    .filter(Boolean)
    .map(value => parseInt(value.slice(1), 10))
    .filter(Number.isFinite);

  const next = (numbers.length ? Math.max(...numbers) : 0) + 1;
  return `L${String(next).padStart(4, '0')}`;
};

const ORDER_MONTH_PREFIXES = [
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
];

const ORDER_MONTH_SELECT_NAMES = [
  'January', 'Febuary', 'March', 'April', 'May', 'June',
  'July', 'August', 'Sepember', 'October', 'November', 'December',
];

const ITEM_MONTH_SELECT_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const getOrderMonthDetails = (dateText: string) => {
  const match = dateText.match(/^(\d{4})-(\d{2})-/);
  if (!match) throw new Error(`Invalid invoice date: ${dateText}`);
  const year = parseInt(match[1], 10);
  const monthIndex = parseInt(match[2], 10) - 1;
  if (monthIndex < 0 || monthIndex > 11) throw new Error(`Invalid invoice month: ${dateText}`);

  return {
    codePrefix: `${ORDER_MONTH_PREFIXES[monthIndex]}${String(year).slice(-2)}`,
    orderMonthSelect: `${ORDER_MONTH_SELECT_NAMES[monthIndex]}_${year}`,
    itemMonthSelect: `${ITEM_MONTH_SELECT_NAMES[monthIndex]}_${year}`,
  };
};

const getNextInternalOrderCode = async (dateText: string): Promise<string> => {
  const { codePrefix } = getOrderMonthDetails(dateText);
  const records = await tableOrders.select({ fields: ['Internal 1 Order No'] }).all();
  const numbers = records
    .map((record: any) => String(record.fields['Internal 1 Order No'] || '').trim().toUpperCase())
    .map(value => value.match(new RegExp(`^${codePrefix}(\\d+)$`)))
    .filter(Boolean)
    .map(match => parseInt((match as RegExpMatchArray)[1], 10))
    .filter(Number.isFinite);
  const next = (numbers.length ? Math.max(...numbers) : 0) + 1;
  return `${codePrefix}${String(next).padStart(2, '0')}`;
};

const itemSuffixFromIndex = (index: number): string => {
  let value = index + 1;
  let suffix = '';
  while (value > 0) {
    value -= 1;
    suffix = String.fromCharCode(65 + (value % 26)) + suffix;
    value = Math.floor(value / 26);
  }
  return suffix;
};

// ─── Shared CSS ─────────────────────────────────────────────────────────────
const SHARED_CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #f3f4f6;
    color: #111;
    line-height: 1.6;
    padding: 20px;
    font-size: 14px;
  }
  a { color: #d8833b; text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* ── Layout ── */
  .page-wrap { max-width: 900px; margin: 0 auto; }
  .doc-card {
    background: #fff;
    border-radius: 8px;
    box-shadow: 0 2px 12px rgba(0,0,0,0.08);
    overflow: hidden;
    margin-bottom: 24px;
  }
  .doc-body { padding: 28px 32px; }

  /* ── Header ── */
  .doc-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    padding: 20px 32px 16px;
    border-bottom: 3px solid #d8833b;
    background: #fff;
  }
  .doc-header .logo { width: 100px; flex-shrink: 0; }
  .doc-header .logo img { width: 100%; height: auto; display: block; }
  .doc-header .doc-title {
    flex: 1;
    text-align: center;
    padding-top: 8px;
  }
  .doc-header .doc-title h1 {
    font-size: 26px;
    font-weight: 700;
    color: #d8833b;
    margin-bottom: 2px;
  }
  .doc-header .doc-title p {
    font-size: 14px;
    color: #d8833b;
    font-weight: 600;
  }
  .doc-header .company-info {
    text-align: right;
    font-size: 12px;
    line-height: 1.7;
    color: #333;
  }
  .doc-header .company-info strong { font-size: 14px; }

  /* ── Info Grid ── */
  .info-grid { display: grid; gap: 12px; margin-bottom: 16px; }
  .info-grid-2 { grid-template-columns: 1fr 1fr; }
  .info-grid-3 { grid-template-columns: 1fr 1fr 1fr; }
  .info-block .lbl { font-weight: 700; color: #d8833b; font-size: 12px; margin-bottom: 3px; text-transform: uppercase; letter-spacing: 0.5px; }
  .info-block .val { font-size: 15px; font-weight: 600; }
  .info-block .val-sm { font-size: 13px; }

  /* ── Section ── */
  .section { margin-bottom: 20px; }
  .section-title {
    font-weight: 700;
    color: #d8833b;
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 8px;
    padding-bottom: 4px;
    border-bottom: 1px solid #f0e0d0;
  }

  /* ── Items Table ── */
  .items-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .items-table th {
    background: #d8833b;
    color: #fff;
    padding: 9px 10px;
    text-align: left;
    font-weight: 600;
    white-space: nowrap;
  }
  .items-table td { border: 1px solid #e5e7eb; padding: 8px 10px; vertical-align: top; }
  .items-table tr:nth-child(even) td { background: #fdf8f5; }
  .items-table .item-sub-detail td { background: #fffaf5 !important; }
  .mini-label { font-size: 11px; font-weight: 700; color: #d8833b; text-transform: uppercase; letter-spacing: 0.3px; margin-bottom: 4px; }
  .free-delivery-offer { font-weight: 700; color: #d8833b; font-size: 14px; }
  .offer-preview { background:#fffaf6; border:1px solid #f0e0d0; border-radius:6px; padding:12px; font-size:13px; }
  .offer-preview .line { display:flex; justify-content:space-between; gap:12px; margin-bottom:4px; }
  .offer-preview .final { border-top:1px solid #f0e0d0; padding-top:6px; margin-top:6px; font-size:16px; font-weight:700; color:#d8833b; }
  .discount-row span:last-child { color:#ef4444; }
  .delivery-row span:last-child { color:#d8833b; font-weight:700; }

  /* ── Accessories Tags ── */
  .acc-tags { display: flex; flex-wrap: wrap; gap: 4px; }
  .acc-tag {
    display: inline-block;
    border: 1px solid #d8833b;
    border-radius: 3px;
    padding: 2px 7px;
    font-size: 11px;
    color: #d8833b;
    background: #fff8f2;
    white-space: nowrap;
  }

  /* ── Totals ── */
  .totals-box { text-align: right; padding: 12px 0; border-top: 1px solid #e5e7eb; }
  .totals-box .row { display: flex; justify-content: flex-end; gap: 24px; margin-bottom: 4px; font-size: 14px; }
  .totals-box .row span:first-child { color: #666; }
  .totals-box .row.total-row { font-size: 17px; font-weight: 700; color: #d8833b; margin-top: 6px; border-top: 2px solid #d8833b; padding-top: 6px; }
  .totals-box .row.balance-row { font-size: 16px; font-weight: 700; }

  /* ── Badges ── */
  .badge {
    display: inline-block;
    padding: 3px 10px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 700;
    color: #fff;
    vertical-align: middle;
  }
  .badge-draft { background: #6b7280; }
  .badge-pending { background: #f59e0b; color: #000; }
  .badge-ready { background: #3b82f6; }
  .badge-converted { background: #10b981; }
  .badge-paid { background: #10b981; }
  .badge-unpaid { background: #ef4444; }
  .material-banner {
    background: #d8833b;
    color: #fff;
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 700;
    margin-bottom: 12px;
    text-align: center;
  }
  .payment-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
  .payment-card { border: 1px solid #f0e0d0; border-radius: 6px; padding: 12px; background: #fffaf6; font-size: 13px; }
  .payment-card .payment-title { font-weight: 700; color: #d8833b; margin-bottom: 6px; }

  /* ── Buttons ── */
  .btn {
    display: inline-block;
    padding: 9px 18px;
    border-radius: 5px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    border: none;
    text-decoration: none;
    transition: opacity 0.15s;
  }
  .btn:hover { opacity: 0.85; text-decoration: none; }
  .btn-primary { background: #d8833b; color: #fff; }
  .btn-secondary { background: #6b7280; color: #fff; }
  .btn-success { background: #10b981; color: #fff; }
  .btn-danger { background: #ef4444; color: #fff; }
  .btn-outline { background: #fff; color: #d8833b; border: 1.5px solid #d8833b; }
  .btn-sm { padding: 5px 12px; font-size: 12px; }

  /* ── Forms ── */
  .form-group { margin-bottom: 16px; }
  .form-group label { display: block; font-weight: 600; margin-bottom: 5px; font-size: 13px; color: #333; }
  .form-group input,
  .form-group select,
  .form-group textarea {
    width: 100%;
    padding: 9px 12px;
    border: 1.5px solid #d1d5db;
    border-radius: 5px;
    font-size: 14px;
    font-family: inherit;
    transition: border-color 0.15s;
  }
  .form-group input:focus,
  .form-group select:focus,
  .form-group textarea:focus {
    outline: none;
    border-color: #d8833b;
  }
  .form-row { display: grid; gap: 12px; }
  .form-row-2 { grid-template-columns: 1fr 1fr; }
  .form-row-3 { grid-template-columns: 1fr 1fr 1fr; }

  /* ── Alerts ── */
  .alert { padding: 12px 16px; border-radius: 5px; margin-bottom: 16px; font-size: 14px; }
  .alert-success { background: #d1fae5; color: #065f46; border: 1px solid #6ee7b7; }
  .alert-danger { background: #fee2e2; color: #991b1b; border: 1px solid #fca5a5; }
  .alert-info { background: #dbeafe; color: #1e40af; border: 1px solid #93c5fd; }

  /* ── Dashboard Cards ── */
  .dash-grid { display: grid; gap: 14px; }
  .quote-card {
    background: #fff;
    border: 1px solid #e5e7eb;
    border-left: 4px solid #d8833b;
    border-radius: 6px;
    padding: 16px 20px;
  }
  .quote-card-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px; }
  .quote-card-title { font-size: 16px; font-weight: 700; }
  .quote-card-meta { font-size: 12px; color: #6b7280; margin-top: 2px; }
  .quote-card-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; padding-top: 10px; border-top: 1px solid #f3f4f6; }

  /* ── Search / Filter Bar ── */
  .filter-bar { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; align-items: center; }
  .filter-bar input { flex: 1; min-width: 200px; padding: 8px 12px; border: 1.5px solid #d1d5db; border-radius: 5px; font-size: 14px; }
  .filter-tabs { display: flex; gap: 6px; flex-wrap: wrap; }
  .filter-tab {
    padding: 5px 14px;
    border-radius: 20px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    border: 1.5px solid #d1d5db;
    background: #fff;
    color: #6b7280;
    text-decoration: none;
  }
  .filter-tab.active, .filter-tab:hover { background: #d8833b; color: #fff; border-color: #d8833b; text-decoration: none; }

  /* ── Items Input Table ── */
  .items-input-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .items-input-table th {
    background: #f9fafb;
    border: 1px solid #d1d5db;
    padding: 7px 8px;
    text-align: left;
    font-weight: 600;
    color: #374151;
    font-size: 12px;
    white-space: nowrap;
  }
  .items-input-table td { border: 1px solid #d1d5db; padding: 5px 6px; vertical-align: middle; }
  .items-input-table input, .items-input-table select {
    width: 100%;
    padding: 5px 7px;
    border: 1px solid #e5e7eb;
    border-radius: 3px;
    font-size: 12px;
    font-family: inherit;
  }
  .items-input-table input:focus, .items-input-table select:focus {
    outline: none;
    border-color: #d8833b;
  }

  /* ── Privacy Notice ── */
  .privacy-notice {
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 5px;
    padding: 12px 16px;
    font-size: 12px;
    color: #6b7280;
    margin-top: 16px;
  }

  /* ── Thank You ── */
  .thank-you { text-align: center; padding: 16px 0 4px; color: #d8833b; font-size: 16px; font-weight: 600; }

  /* ── Divider ── */
  .divider { border: none; border-top: 1px solid #e5e7eb; margin: 20px 0; }

  /* ── Responsive ── */
  @media (max-width: 640px) {
    body { padding: 10px; }
    .doc-header { flex-direction: column; gap: 12px; }
    .doc-header .company-info { text-align: left; }
    .doc-header .doc-title { text-align: left; }
    .info-grid-2, .info-grid-3 { grid-template-columns: 1fr 1fr; }
    .form-row-2, .form-row-3 { grid-template-columns: 1fr; }
    .doc-body { padding: 16px; }
    .items-input-table { font-size: 11px; }
    .items-input-table th, .items-input-table td { padding: 4px 4px; }
  }
`;

// ─── HTML Page Template ──────────────────────────────────────────────────────
const renderPage = (title: string, content: string, extraHead = ''): string => `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} | LKS Display Box</title>
  <style>${SHARED_CSS}</style>
  ${extraHead}
</head>
<body>
  <div class="page-wrap">
    ${content}
  </div>
</body>
</html>`;

// ─── Shared Components ───────────────────────────────────────────────────────
const docHeader = (title: string, subtitle: string, isEnglish = false): string => `
<div class="doc-header">
  <div class="logo">
    <img src="${LOGO_URL}" alt="LKS Logo" crossorigin="anonymous">
  </div>
  <div class="doc-title">
    <h1>${title}</h1>
    ${subtitle ? `<p>${subtitle}</p>` : ''}
  </div>
  <div class="company-info">
    <strong>${COMPANY.name}</strong><br>
    ${isEnglish ? 'Unit G1, 35/F, Legend Tower, 7 Shing Yip Street' : COMPANY.address1}<br>
    ${isEnglish ? 'Kwun Tong, Kowloon, Hong Kong' : COMPANY.address2}<br>
    ${COMPANY.phone}<br>
    ${COMPANY.email}<br>
    <a href="${COMPANY.website}" target="_blank" rel="noopener noreferrer">${COMPANY.website.replace(/^https?:\/\//, '')}</a>
  </div>
</div>`;

const parseAccessories = (raw: unknown): string[] => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String).filter(s => s.length > 0);
  if (typeof raw === 'string') {
    if (raw.trim() === '' || raw.trim() === '-') return [];
    return raw.split(/[,，;\n]+/).map(s => s.trim()).filter(s => s.length > 0);
  }
  return [];
};

const renderAccTags = (raw: unknown): string => {
  const tags = parseAccessories(raw);
  if (tags.length === 0) return '<span style="color:#9ca3af">-</span>';
  return `<div class="acc-tags">${tags.map(t => `<span class="acc-tag">${escapeHtml(t)}</span>`).join('')}</div>`;
};

const statusBadgeClass = (status: string): string => {
  const map: Record<string, string> = {
    'Draft': 'badge-draft',
    'Ready to Convert': 'badge-ready',
    'Mark as Paid': 'badge-paid',
    'Unpaid': 'badge-unpaid',
  };
  return map[status] || 'badge-draft';
};


// ═══════════════════════════════════════════════════════════════════════════
// ROUTE: GET /api/customers/search  — Search existing customers for Create Quote
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/customers/search', async (req: Request, res: Response) => {
  try {
    const q = (req.query.q as string) || '';
    const customers = await searchCustomers(q);
    res.json({ customers });
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: error.message || 'Customer search failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ROUTE: GET /quotes  — Dashboard
// ═══════════════════════════════════════════════════════════════════════════
app.get('/quotes', async (req: Request, res: Response) => {
  try {
    const filterStatus = (req.query.status as string) || 'all';
    const search = ((req.query.search as string) || '').toLowerCase().trim();

    const allRecords = await tableQuotes
      .select({ sort: [{ field: 'Created At', direction: 'desc' }] })
      .firstPage();

    let records = allRecords;

    // Filter by status tab
    if (filterStatus !== 'all') {
      const statusMap: Record<string, string[]> = {
        draft: ['Draft'],
        ready: ['Ready to Convert'],
        paid: ['Mark as Paid'],
      };
      const allowed = statusMap[filterStatus] || [];
      records = records.filter(r => allowed.includes(r.fields['Status'] as string));
    }

    // Search filter
    if (search) {
      const normalizedSearchPhone = normalizePhone(search);
      records = records.filter(r => {
        const qn = ((r.fields['Quote Number'] as string) || '').toLowerCase();
        const customerName = ((r.fields['Customer Name'] as string) || '').toLowerCase();
        const customerEmail = ((r.fields['Customer Email'] as string) || '').toLowerCase();
        const customerPhone = (r.fields['Customer Phone'] as string) || '';
        const contactName = ((r.fields['Contact Name'] as string) || '').toLowerCase();
        const quotePhone = (r.fields['Phone'] as string) || '';

        const textMatch = [qn, customerName, customerEmail, contactName, customerPhone.toLowerCase(), quotePhone.toLowerCase()]
          .some(value => value.includes(search));

        const phoneMatch = normalizedSearchPhone.length >= 4
          && [customerPhone, quotePhone]
            .map(normalizePhone)
            .some(value => value.includes(normalizedSearchPhone));

        return textMatch || phoneMatch;
      });
    }

    const tabs = [
      { key: 'all', label: 'All' },
      { key: 'draft', label: 'Draft' },
      { key: 'ready', label: 'Ready' },
      { key: 'paid', label: 'Mark as Paid' },
    ];

    const tabsHtml = tabs.map(t => {
      const isActive = filterStatus === t.key;
      const url = `/quotes?status=${t.key}${search ? `&search=${encodeURIComponent(search)}` : ''}`;
      return `<a href="${url}" class="filter-tab${isActive ? ' active' : ''}">${t.label}</a>`;
    }).join('');

    // Pre-fetch receipt tokens from Order_2026 for quotes that have been converted
    const receiptTokenMap: Record<string, string> = {};
    const convertedRecords = records.filter(r => r.fields['Order Ref']);
    if (convertedRecords.length > 0) {
      for (const cr of convertedRecords) {
        const orderRecordId = cr.fields['Order Ref'] as string;
        if (orderRecordId) {
          try {
            const orderRecord = await tableOrders.find(orderRecordId);
            if (orderRecord && orderRecord.fields['Receipt Public Token']) {
              receiptTokenMap[cr.id] = orderRecord.fields['Receipt Public Token'] as string;
            }
          } catch { /* order not found, skip */ }
        }
      }
    }

    const cardsHtml = records.length === 0
      ? '<div style="text-align:center;padding:40px;color:#9ca3af;">No quotes found.</div>'
      : records.map(r => {
          const f = r.fields;
          const token = f['Public Token'] as string;
          const status = (f['Status'] as string) || 'Draft';
          const qNum = escapeHtml(f['Quote Number'] as string);
          const qDate = escapeHtml(f['Quote Date'] as string);
          const customerName = escapeHtml((f['Customer Name'] as string) || (f['Contact Name'] as string) || 'N/A');
          const phone = escapeHtml((f['Customer Phone'] as string) || (f['Phone'] as string) || '');
          const total = f['Total'] ? `$${f['Total']}` : '-';
          const invoiceToken = f['Invoice Public Token'] as string | undefined;
          const receiptToken = receiptTokenMap[r.id] || undefined;

          // Build action buttons — ALL always shown
          const customerInfoLink = `${PUBLIC_BASE_URL}/quote/${token}/customer-info`;
          let actions = '';

          // 1. View Quote
          actions += `<a href="/quote/${token}" class="btn btn-outline btn-sm" target="_blank">View Quote</a>`;

          // 2. Copy Customer Info Link
          actions += ` <button type="button" class="btn btn-secondary btn-sm" onclick="copyLink('${customerInfoLink}', this)">Copy Customer Info Form Link</button>`;

          // 3. Convert to Invoice (always shown)
          actions += `
            <form method="POST" action="/admin/quote/${token}/convert" style="display:inline;" onsubmit="return confirm('Convert this quote to Invoice?')">
              <button type="submit" class="btn btn-primary btn-sm">Convert to Invoice</button>
            </form>`;

          // 4. View Invoice (only if token exists)
          if (invoiceToken) {
            actions += ` <a href="/invoice/${invoiceToken}" class="btn btn-success btn-sm" target="_blank">View Invoice</a>`;
          }

          // 5. Mark as Paid (only if invoice token exists)
          if (invoiceToken) {
            actions += `
              <form method="POST" action="/admin/invoice/${invoiceToken}/mark-paid" style="display:inline;" onsubmit="return confirm('Mark this invoice as Paid?')">
                <button type="submit" class="btn btn-primary btn-sm">Mark as Paid</button>
              </form>`;
          }

          // 6. View Receipt (only if receipt token exists)
          if (receiptToken) {
            actions += ` <a href="/receipt/${receiptToken}" class="btn btn-success btn-sm" target="_blank">View Receipt</a>`;
          }

          return `
            <div class="quote-card">
              <div class="quote-card-header">
                <div>
                  <div class="quote-card-title">${qNum} <span class="badge ${statusBadgeClass(status)}">${escapeHtml(status)}</span></div>
                  <div class="quote-card-meta">${qDate}${phone ? ` · ${phone}` : ''}</div>
                </div>
                <div style="text-align:right;">
                  <div style="font-size:18px;font-weight:700;color:#d8833b;">${total}</div>
                  <div style="font-size:13px;color:#6b7280;">${customerName}</div>
                </div>
              </div>
              <div class="quote-card-actions">${actions}</div>
            </div>`;
        }).join('');

    const content = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">
        <h2 style="font-size:22px;font-weight:700;">Quote Dashboard</h2>
        <a href="/quote/create" class="btn btn-primary">+ New Quote</a>
      </div>

      <form method="GET" action="/quotes" style="margin-bottom:12px;">
        <div class="filter-bar">
          <input type="text" name="search" placeholder="Search quote no. / customer / phone..." value="${escapeHtml(search)}">
          <input type="hidden" name="status" value="${escapeHtml(filterStatus)}">
          <button type="submit" class="btn btn-secondary">Search</button>
          ${search ? `<a href="/quotes?status=${escapeHtml(filterStatus)}" class="btn btn-outline">Clear</a>` : ''}
        </div>
      </form>

      <div class="filter-tabs" style="margin-bottom:16px;">${tabsHtml}</div>

      <div class="dash-grid">${cardsHtml}</div>
    `;

    const extraHead = `<script>
      function copyLink(url, btn) {
        navigator.clipboard.writeText(url).then(() => {
          const orig = btn.textContent;
          btn.textContent = 'Copied!';
          btn.style.background = '#10b981';
          setTimeout(() => { btn.textContent = orig; btn.style.background = ''; }, 2000);
        }).catch(() => {
          prompt('Copy this link:', url);
        });
      }
    </script>`;
    res.send(renderPage('Quote Dashboard', content, extraHead));
  } catch (error: any) {
    console.error(error);
    res.status(500).send(renderPage('Error', `<div class="alert alert-danger">Error loading dashboard: ${escapeHtml(error.message)}</div>`));
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ROUTE: GET /quote/create
// ═══════════════════════════════════════════════════════════════════════════
app.get('/quote/create', async (_req: Request, res: Response) => {
  let inquiryOptions = '<option value="">不連結查詢</option>';
  let performanceMonthOptions = '<option value="">不連結月份</option>';
  try {
    const inquiryRecords = await tableInquiries.select({ maxRecords: 100 }).all();
    inquiryOptions += inquiryRecords.map((record) => {
      const f = record.fields;
      const label = String(f['Inquiry Ref'] || f['Inquiry No'] || f['Customer Name'] || f['Phone'] || record.id);
      const channel = f['Channel'] ? ` · ${String(f['Channel'])}` : '';
      return `<option value="${record.id}">${escapeHtml(label + channel)}</option>`;
    }).join('');
  } catch (error) {
    console.warn('Unable to load Inquiries for Create Quote:', error);
  }
  try {
    const performanceRecords = await tableMonthlyPerformance.select({ maxRecords: 60 }).all();
    performanceMonthOptions += performanceRecords.map((record) => {
      const f = record.fields;
      const label = String(f['Month'] || record.id);
      return `<option value="${record.id}">${escapeHtml(label)}</option>`;
    }).join('');
  } catch (error) {
    console.warn('Unable to load Monthly Performance for Create Quote:', error);
  }

  const content = `
    <div class="doc-card">
      ${docHeader('建立報價單', 'Create Quote')}
      <div class="doc-body">
        <form id="quoteForm">

          <div class="section">
            <div class="section-title">報價單語言 / Quote Language</div>
            <div class="form-row form-row-2">
              <div class="form-group">
                <label>Share View 顯示語言</label>
                <select name="quoteLanguage" id="quoteLanguage">
                  <option value="中文">中文</option>
                  <option value="English">English</option>
                </select>
              </div>
              <div class="form-group" style="display:flex;align-items:flex-end;color:#6b7280;font-size:12px;">
                只影響客人 Share View 顯示；Create Quote 內部介面維持原本格式。
              </div>
            </div>
          </div>

          <div class="section">
            <div class="section-title">查詢來源 / Monthly Review</div>
            <div class="form-row form-row-2">
              <div class="form-group">
                <label>Quote Source / Channel</label>
                <select name="quoteSourceChannel" id="quoteSourceChannel">
                  <option value="">請選擇</option>
                  <option value="Website">Website</option>
                  <option value="WhatsApp Direct">WhatsApp Direct</option>
                  <option value="Meta Ads">Meta Ads</option>
                  <option value="Facebook Organic">Facebook Organic</option>
                  <option value="Instagram Organic">Instagram Organic</option>
                  <option value="Carousell">Carousell</option>
                  <option value="KOL">KOL</option>
                  <option value="Google Search">Google Search</option>
                  <option value="Google Organic">Google Organic</option>
                  <option value="Referral">Referral</option>
                  <option value="Returning Customer">Returning Customer</option>
                  <option value="Other">Other</option>
                </select>
              </div>
              <div class="form-group">
                <label>Campaign / Source Detail</label>
                <input type="text" name="campaignSourceDetail" id="campaignSourceDetail" placeholder="例如 ToyTV June 2026 / Carousell BE@RBRICK 1000%">
              </div>
            </div>
            <div class="form-row form-row-2">
              <div class="form-group">
                <label>Inquiry</label>
                <select name="inquiryRecordId" id="inquiryRecordId">
                  ${inquiryOptions}
                </select>
              </div>
              <div class="form-group">
                <label>Performance Month</label>
                <select name="performanceMonthRecordId" id="performanceMonthRecordId">
                  ${performanceMonthOptions}
                </select>
              </div>
            </div>
            <div style="font-size:12px;color:#6b7280;margin-top:6px;">用於每月檢討：來源會跟 Quote 一齊保存，Convert to Invoice 時會帶去 Order_2026。</div>
          </div>

          <div class="section">
            <div class="section-title">Existing Customer 客戶搜尋</div>
            <input type="hidden" name="customerRecordId" id="customerRecordId">
            <input type="hidden" name="customerSource" id="customerSource">
            <input type="hidden" name="legacyCustomerRecordId" id="legacyCustomerRecordId">
            <div class="form-row form-row-2">
              <div class="form-group">
                <label>Search Customer ID / Name / Phone / Email</label>
                <input type="text" id="customerSearchInput" placeholder="例如：L0759 / 91945953 / +852 9194 5953 / 客人名">
              </div>
              <div class="form-group" style="display:flex;align-items:flex-end;gap:8px;">
                <button type="button" class="btn btn-secondary" onclick="searchExistingCustomers()">Search Customer</button>
                <button type="button" class="btn btn-outline" onclick="clearSelectedCustomer()">Clear</button>
              </div>
            </div>
            <div id="customerSearchResults" style="display:none;border:1px solid #e5e7eb;border-radius:6px;background:#fff;margin-top:8px;overflow:hidden;"></div>
            <div id="selectedCustomerBox" style="display:none;margin-top:10px;padding:10px 12px;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:6px;font-size:13px;color:#065f46;"></div>
            <div style="font-size:12px;color:#6b7280;margin-top:6px;">可搜尋正式 Customers 或 Customers (Active) 舊客資料；如選擇 Legacy 舊客，建立 Quote 時會自動啟用到正式 Customers。</div>
          </div>

          <div class="section">
            <div class="section-title">Contact Information</div>
            <div class="form-row form-row-2">
              <div class="form-group">
                <label>Contact Name *</label>
                <input type="text" name="contactName" required>
              </div>
              <div class="form-group">
                <label>Phone *</label>
                <input type="text" name="phone" required>
              </div>
            </div>
            <div class="form-row form-row-2">
              <div class="form-group">
                <label>Contact Method</label>
                <select name="contactMethod">
                  <option value="WhatsApp">WhatsApp</option>
                  <option value="IG">IG</option>
                  <option value="Facebook">Facebook</option>
                  <option value="網頁搜尋">網頁搜尋</option>
                </select>
              </div>
              <div class="form-group">
                <label>Contact Handle / Reference</label>
                <input type="text" name="contactHandle">
              </div>
            </div>
          </div>

          <div class="section">
            <div class="section-title">Items</div>
            <div style="overflow-x:auto;">
              <table class="items-input-table" id="itemsTable">
                <thead>
                  <tr>
                    <th>Item Type</th>
                    <th>For What</th>
                    <th>Inter L</th>
                    <th>Inter D</th>
                    <th>Inter H</th>
                    <th>Outer L</th>
                    <th>Outer D</th>
                    <th>Outer H</th>
                    <th>Levels</th>
                    <th>Level Heights</th>
                    <th>Accessories</th>
                    <th>Description</th>
                    <th>QTY</th>
                    <th>內地運費 ($)</th>
                    <th>香港運費 ($)</th>
                    <th>利潤 ($)</th>
                    <th>Amount ($)</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody id="itemsBody">
                  <tr>
                    <td><select class="f-type"><option value="Display box 展示盒">Display box 展示盒</option><option value="Display Case 疊高展示櫃">Display Case 疊高展示櫃</option></select></td>
                    <td><input type="text" class="f-for" placeholder="e.g. Shoes"></td>
                    <td><input type="number" class="f-il" step="0.1" style="width:60px"></td>
                    <td><input type="number" class="f-id" step="0.1" style="width:60px"></td>
                    <td><input type="number" class="f-ih" step="0.1" style="width:60px"></td>
                    <td><input type="number" class="f-ol" step="0.1" style="width:60px;background:#f9fafb;" readonly></td>
                    <td><input type="number" class="f-od" step="0.1" style="width:60px;background:#f9fafb;" readonly></td>
                    <td><input type="number" class="f-oh" step="0.1" style="width:60px;background:#f9fafb;" readonly></td>
                    <td><input type="number" class="f-lv" min="1" style="width:50px"></td>
                    <td><input type="text" class="f-lh" placeholder="e.g. 20,30"></td>
                    <td>
                      <div style="min-width:300px;max-height:220px;overflow-y:auto;border:1px solid #e5e7eb;border-radius:4px;padding:6px;font-size:12px;background:#fff;">
                        <div style="font-weight:700;color:#d8833b;margin-bottom:4px;">單次配件</div>
                        <div class="f-acc-wrap" style="margin-bottom:8px;">
                          <label style="display:block;"><input type="checkbox" value="樓梯"> 樓梯</label>
                          <label style="display:block;"><input type="checkbox" value="趟門"> 趟門</label>
                          <label style="display:block;"><input type="checkbox" value="磁石門"> 磁石門</label>
                          <label style="display:block;"><input type="checkbox" value="黑底板"> 黑底板</label>
                          <label style="display:block;"><input type="checkbox" value="透明底板"> 透明底板</label>
                        </div>
                        <div style="font-weight:700;color:#d8833b;margin-bottom:4px;">數量配件</div>
                        <div class="f-acc-qty-wrap" style="display:grid;grid-template-columns:1fr 58px;gap:4px 6px;align-items:center;">
                          <label>獨立燈板 - 上燈</label><input type="number" min="0" class="f-acc-qty" data-name="獨立燈板 - 上燈" value="0" style="width:58px;">
                          <label>獨立燈板 - 下燈</label><input type="number" min="0" class="f-acc-qty" data-name="獨立燈板 - 下燈" value="0" style="width:58px;">
                          <label>獨立燈板 - 上下燈</label><input type="number" min="0" class="f-acc-qty" data-name="獨立燈板 - 上下燈" value="0" style="width:58px;">
                          <label>上下燈</label><input type="number" min="0" class="f-acc-qty" data-name="上下燈" value="0" style="width:58px;">
                          <label>背燈</label><input type="number" min="0" class="f-acc-qty" data-name="背燈" value="0" style="width:58px;">
                          <label>前板白色刻字</label><input type="number" min="0" class="f-acc-qty" data-name="前板白色刻字" value="0" style="width:58px;">
                          <label>前板彩色刻字</label><input type="number" min="0" class="f-acc-qty" data-name="前板彩色刻字" value="0" style="width:58px;">
                          <label>左板圖片</label><input type="number" min="0" class="f-acc-qty" data-name="左板圖片" value="0" style="width:58px;">
                          <label>右板圖片</label><input type="number" min="0" class="f-acc-qty" data-name="右板圖片" value="0" style="width:58px;">
                          <label>底板圖片</label><input type="number" min="0" class="f-acc-qty" data-name="底板圖片" value="0" style="width:58px;">
                          <label>頂板圖片</label><input type="number" min="0" class="f-acc-qty" data-name="頂板圖片" value="0" style="width:58px;">
                          <label>背板圖片</label><input type="number" min="0" class="f-acc-qty" data-name="背板圖片" value="0" style="width:58px;">
                          <label>左板鏡面</label><input type="number" min="0" class="f-acc-qty" data-name="左板鏡面" value="0" style="width:58px;">
                          <label>右板鏡面</label><input type="number" min="0" class="f-acc-qty" data-name="右板鏡面" value="0" style="width:58px;">
                          <label>底板鏡面</label><input type="number" min="0" class="f-acc-qty" data-name="底板鏡面" value="0" style="width:58px;">
                          <label>頂板鏡面</label><input type="number" min="0" class="f-acc-qty" data-name="頂板鏡面" value="0" style="width:58px;">
                          <label>背板鏡面</label><input type="number" min="0" class="f-acc-qty" data-name="背板鏡面" value="0" style="width:58px;">
                        </div>
                      </div>
                    </td>
                    <td><input type="text" class="f-desc" placeholder="Remarks"></td>
                    <td><input type="number" class="f-qty amount-input" min="1" value="1" style="width:55px"></td>
                    <td><input type="number" class="f-freight amount-input" step="0.01" style="width:80px" title="內地運費"></td>
                    <td><input type="number" class="f-hk-delivery amount-input" step="0.01" style="width:80px" title="系統建議，可手動修改"></td>
                    <td><input type="number" class="f-profit amount-input" step="0.01" style="width:80px"></td>
                    <td><input type="number" class="f-amt amount-input" step="0.01" style="width:90px;background:#f9fafb;" readonly></td>
                    <td><button type="button" class="btn btn-danger btn-sm" onclick="removeRow(this)">✕</button></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div style="margin-top:10px;">
              <button type="button" class="btn btn-outline btn-sm" onclick="addRow()">+ Add Item</button>
            </div>
          </div>

          <div class="section">
            <div class="section-title">Pricing / 優惠及送貨設定</div>
            <div class="form-row form-row-3">
              <div class="form-group">
                <label>Subtotal ($)</label>
                <input type="number" name="subtotal" id="subtotal" step="0.01" readonly style="background:#f9fafb;">
              </div>
              <div class="form-group">
                <label>使用優惠</label>
                <select name="promotionType" id="promotionType" onchange="applyPromotionPreset(); recalcTotal();">
                  <option value="">不使用優惠</option>
                  <option value="首次落單優惠">首次落單優惠</option>
                  <option value="ToyTV 專屬優惠">ToyTV 專屬優惠</option>
                  <option value="現貨優惠">現貨優惠</option>
                </select>
              </div>
              <div class="form-group">
                <label>Total ($)</label>
                <input type="number" name="total" id="total" step="0.01" readonly style="background:#f9fafb;">
              </div>
            </div>

            <div class="form-row form-row-3">
              <div class="form-group">
                <label>折扣方式</label>
                <select name="discountType" id="discountType" onchange="toggleDiscountInputs(); recalcTotal();">
                  <option value="無折扣">無折扣</option>
                  <option value="百分比折扣">百分比折扣</option>
                  <option value="指定金額扣減">指定金額扣減</option>
                </select>
              </div>
              <div class="form-group" id="discountMultiplierGroup">
                <label>折扣倍率（0.9 = 9折 / 0.85 = 85折）</label>
                <input type="number" name="discountMultiplier" id="discountMultiplier" step="0.01" min="0" max="1" value="" oninput="recalcTotal()">
              </div>
              <div class="form-group" id="discountAmountGroup">
                <label>指定扣減金額 HKD</label>
                <input type="number" name="discountAmountHkd" id="discountAmountHkd" step="1" min="0" value="" oninput="recalcTotal()">
              </div>
            </div>

            <div class="form-row form-row-3">
              <div class="form-group">
                <label>折扣原因</label>
                <select name="discountReason" id="discountReason" onchange="recalcTotal()">
                  <option value="">不適用</option>
                  <option value="ToyTV 專屬優惠">ToyTV 專屬優惠</option>
                  <option value="新客戶優惠">新客戶優惠</option>
                  <option value="回購優惠">回購優惠</option>
                </select>
              </div>
              <div class="form-group">
                <label>送貨收費方式</label>
                <select name="deliveryChargeMode" id="deliveryChargeMode" onchange="toggleDeliveryInputs(); recalcTotal();">
                  <option value="已包本地送貨">已包本地送貨</option>
                  <option value="LKS 車隊 運費到付">LKS 車隊 運費到付</option>
                </select>
              </div>
              <div class="form-group" id="deliveryOfferReasonGroup">
                <label>免運費原因</label>
                <select name="deliveryOfferReason" id="deliveryOfferReason" onchange="recalcTotal()">
                  <option value="">不適用</option>
                  <option value="首次落單優惠">首次落單優惠</option>
                  <option value="ToyTV 專屬優惠免運費">ToyTV 專屬優惠免運費</option>
                </select>
              </div>
            </div>

            <div class="offer-preview" id="offerPreview">
              <div class="line"><span>Subtotal</span><span id="previewSubtotal">$0.00</span></div>
              <div class="line" id="previewDiscountRow" style="display:none;"><span id="previewDiscountText">優惠折扣</span><span id="previewDiscountAmount">-$0.00</span></div>
              <div class="line"><span>送貨安排</span><span id="previewDeliveryText">已包本地送貨</span></div>
              <div class="line final"><span>Total</span><span id="previewTotal">$0</span></div>
            </div>
          </div>

          <div class="section">
            <div class="section-title">Additional Info</div>
            <div class="form-row form-row-2">
              <div class="form-group">
                <label>Valid Until</label>
                <input type="date" name="validUntil">
              </div>
              <div class="form-group">
                <label>Notes</label>
                <textarea name="notes" rows="14">${escapeHtml(DEFAULT_QUOTE_NOTES)}</textarea>
              </div>
            </div>
            <div class="form-group">
              <label>Terms and Conditions</label>
              <textarea name="terms" rows="6">${escapeHtml(DEFAULT_TERMS)}</textarea>
            </div>
          </div>

          <div style="text-align:right;">
            <button type="submit" class="btn btn-primary" style="font-size:16px;padding:12px 32px;">Generate Quote</button>
          </div>
        </form>
      </div>
    </div>
  `;

  const extraHead = `
  <script>
    var RMB_DIVISOR = 0.85;

    function parseNum(val) {
      var n = parseFloat(val);
      return isNaN(n) ? 0 : n;
    }

    function getDims(row) {
      return {
        l: parseNum((row.querySelector('.f-il') || {}).value),
        d: parseNum((row.querySelector('.f-id') || {}).value),
        h: parseNum((row.querySelector('.f-ih') || {}).value)
      };
    }

    function getSingleAccessories(row) {
      var acc = [];
      row.querySelectorAll('.f-acc-wrap input[type=checkbox]:checked').forEach(function(cb) {
        acc.push(cb.value);
      });
      return acc;
    }

    function getAccessoryQtyMap(row) {
      var map = {};
      row.querySelectorAll('.f-acc-qty').forEach(function(input) {
        var name = input.getAttribute('data-name') || '';
        var qty = Math.max(0, parseInt(input.value, 10) || 0);
        if (name && qty > 0) map[name] = qty;
      });
      return map;
    }

    function getAccessories(row) {
      var single = getSingleAccessories(row);
      var qtyMap = getAccessoryQtyMap(row);
      Object.keys(qtyMap).forEach(function(name) {
        single.push(name + ' x' + qtyMap[name]);
      });
      return single;
    }

    function calcDisplayBoxRmb(l, d, h) {
      var fiveSideArea = (l * d) + ((l * h + d * h) * 2);
      return (fiveSideArea * 0.025) + (l * d * 0.013) + (l * d * 0.013) + 20;
    }

    function calcLightBoardRmb(l, d) {
      return ((l * d + d * 2 + l * 2) * 2 * 0.023) + l + d;
    }

    function calcBackLightRmb(l, h) {
      return ((l * h + h * 2 + l * 2) * 2 * 0.02) + l + h;
    }

    function calcBackPanelRmb(l, h) {
      return l * h * 0.025;
    }

    function calcLdPanelRmb(l, d) {
      return l * d * 0.025;
    }

    function calcPowerRmb() {
      return 30;
    }

    function getOuterDimensionIncrease(row) {
      var qtyMap = getAccessoryQtyMap(row);
      var hasTopStandard = (qtyMap['上下燈'] || 0) > 0;
      var hasTopSingleStandard = false;
      var hasTopIndependentSingle = (qtyMap['獨立燈板 - 上燈'] || 0) > 0 || (qtyMap['獨立燈板 - 下燈'] || 0) > 0;
      var hasTopIndependentDouble = (qtyMap['獨立燈板 - 上下燈'] || 0) > 0;
      var hasBack = (qtyMap['背燈'] || 0) > 0;

      var topLikeCount = 0;
      if (hasTopStandard) topLikeCount += 1;
      if (hasTopSingleStandard) topLikeCount += 1;
      if (hasTopIndependentSingle) topLikeCount += 1;
      if (hasTopIndependentDouble) topLikeCount += 1;

      var outerLengthIncrease = 2;
      var outerDepthIncrease = hasBack ? 3.5 : 2;
      var outerHeightIncrease = 1;

      if (hasTopIndependentDouble) {
        outerHeightIncrease = 6;
      } else if (hasTopStandard) {
        outerHeightIncrease = 5;
      } else if (hasTopIndependentSingle || hasTopSingleStandard) {
        outerHeightIncrease = 3.5;
      }

      return {
        outerLengthIncrease: outerLengthIncrease,
        outerDepthIncrease: outerDepthIncrease,
        outerHeightIncrease: outerHeightIncrease
      };
    }

    function updateOuterDimensionMode(row) {
      var itemType = ((row.querySelector('.f-type') || {}).value || '');
      var isDisplayCase = itemType.indexOf('Display Case') !== -1;
      ['.f-ol', '.f-od', '.f-oh'].forEach(function(selector) {
        var input = row.querySelector(selector);
        if (!input) return;
        input.readOnly = !isDisplayCase;
        input.style.background = isDisplayCase ? '#fff' : '#f9fafb';
      });
      return isDisplayCase;
    }

    function updateOuterDimensions(row) {
      var isDisplayCase = updateOuterDimensionMode(row);
      if (isDisplayCase) {
        return;
      }

      var dims = getDims(row);
      var l = dims.l, d = dims.d, h = dims.h;
      var outerLInput = row.querySelector('.f-ol');
      var outerDInput = row.querySelector('.f-od');
      var outerHInput = row.querySelector('.f-oh');

      if (!(l > 0 && d > 0 && h > 0)) {
        if (outerLInput) outerLInput.value = '';
        if (outerDInput) outerDInput.value = '';
        if (outerHInput) outerHInput.value = '';
        return;
      }

      var inc = getOuterDimensionIncrease(row);
      if (outerLInput) outerLInput.value = (l + inc.outerLengthIncrease).toFixed(1);
      if (outerDInput) outerDInput.value = (d + inc.outerDepthIncrease).toFixed(1);
      if (outerHInput) outerHInput.value = (h + inc.outerHeightIncrease).toFixed(1);
    }

    function roundUpToNearest10(value) {
      return Math.ceil(value / 10) * 10;
    }

    function calcDeliveryReserve(driverCost) {
      if (!(driverCost > 0)) return 0;
      var rawReserve = Math.max(driverCost * 1.10, driverCost + 30);
      return roundUpToNearest10(rawReserve);
    }

    function getLightBoardPieceCount(row) {
      var qtyMap = getAccessoryQtyMap(row);
      var count = 0;
      count += (qtyMap['獨立燈板 - 上燈'] || 0);
      count += (qtyMap['獨立燈板 - 下燈'] || 0);
      count += ((qtyMap['獨立燈板 - 上下燈'] || 0) * 2);
      count += ((qtyMap['上下燈'] || 0) * 2);
      count += (qtyMap['背燈'] || 0);
      return count;
    }

    function suggestBaseDriverCost(row) {
      var itemType = ((row.querySelector('.f-type') || {}).value || '');
      var isDisplayCase = itemType.indexOf('Display Case') !== -1;
      var l = parseNum((row.querySelector('.f-ol') || {}).value) || parseNum((row.querySelector('.f-il') || {}).value);
      var d = parseNum((row.querySelector('.f-od') || {}).value) || parseNum((row.querySelector('.f-id') || {}).value);
      var h = parseNum((row.querySelector('.f-oh') || {}).value) || parseNum((row.querySelector('.f-ih') || {}).value);
      if (!(l > 0 && d > 0 && h > 0)) return 0;

      var maxDim = Math.max(l, d, h);
      var suggested = isDisplayCase ? 130 : 100;

      if (maxDim >= 60 || l >= 70 || d >= 35 || h >= 50) suggested = Math.max(suggested, 130);
      if (maxDim >= 90 || l >= 100 || d >= 45 || h >= 80) suggested = Math.max(suggested, 160);
      return suggested;
    }

    function getEstimatedPackageUnits(row) {
      var itemType = ((row.querySelector('.f-type') || {}).value || '');
      var isDisplayCase = itemType.indexOf('Display Case') !== -1;
      var qty = Math.max(1, parseInt((row.querySelector('.f-qty') || {}).value, 10) || 1);
      var levels = Math.max(1, parseInt((row.querySelector('.f-lv') || {}).value, 10) || 1);

      // 包裝 / 運費邏輯：
      // 展示盒：每件 1 個基本包裝；展示櫃：每層 1 個基本包裝。
      // 燈類不論種類，每 1 件燈板加 0.5 個包裝單位；上下燈 / 獨立上下燈按 2 件燈板計。
      // QTY 代表同一 item 有幾件，包裝單位跟件數倍增。
      var basePackageCount = isDisplayCase ? levels : 1;
      var lightBoardPieces = getLightBoardPieceCount(row);
      var unitsPerSet = basePackageCount + (lightBoardPieces * 0.5);
      return unitsPerSet * qty;
    }

    function suggestHongKongDeliveryTotal(row) {
      var baseDriverCost = suggestBaseDriverCost(row);
      var baseReserve = calcDeliveryReserve(baseDriverCost);
      if (!(baseReserve > 0)) return 0;
      return baseReserve * getEstimatedPackageUnits(row);
    }

    function updateLocalDeliveryEstimate(row) {
      var input = row.querySelector('.f-hk-delivery');
      if (!input || input.getAttribute('data-manual') === '1') return;
      var reserve = suggestHongKongDeliveryTotal(row);
      input.value = reserve > 0 ? String(reserve) : '';
      input.setAttribute('data-auto-value', input.value || '');
    }

    function calcRowAmount(row) {
      var dims = getDims(row);
      var l = dims.l, d = dims.d, h = dims.h;
      var qty = Math.max(1, parseInt((row.querySelector('.f-qty') || {}).value, 10) || 1);
      var freight = parseNum((row.querySelector('.f-freight') || {}).value);
      var hkDelivery = parseNum((row.querySelector('.f-hk-delivery') || {}).value);
      var profit = parseNum((row.querySelector('.f-profit') || {}).value);
      var itemType = ((row.querySelector('.f-type') || {}).value || '');
      var levels = Math.max(1, parseInt((row.querySelector('.f-lv') || {}).value, 10) || 1);
      var qtyMap = getAccessoryQtyMap(row);

      if (!(l > 0 && d > 0 && h > 0)) {
        (row.querySelector('.f-amt') || {}).value = '';
        return 0;
      }

      var baseRmb = calcDisplayBoxRmb(l, d, h);
      var sizeRmb = itemType.indexOf('Display Case') !== -1 ? (baseRmb * levels) : baseRmb;
      var accessoryRmb = 0;
      var hkdAddons = 0;

      var lightBoardCount = 0;
      lightBoardCount += (qtyMap['獨立燈板 - 上燈'] || 0);
      lightBoardCount += (qtyMap['獨立燈板 - 下燈'] || 0);
      lightBoardCount += ((qtyMap['獨立燈板 - 上下燈'] || 0) * 2);
      lightBoardCount += ((qtyMap['上下燈'] || 0) * 2);
      if (lightBoardCount > 0) {
        accessoryRmb += calcLightBoardRmb(l, d) * lightBoardCount;
      }

      var backLightCount = qtyMap['背燈'] || 0;
      if (backLightCount > 0) {
        accessoryRmb += calcBackLightRmb(l, h) * backLightCount;
      }

      var backImageCount = qtyMap['背板圖片'] || 0;
      if (backImageCount > 0) {
        accessoryRmb += calcBackPanelRmb(l, h) * backImageCount;
        hkdAddons += 100 * backImageCount;
      }

      ['左板圖片','右板圖片','底板圖片','頂板圖片'].forEach(function(name) {
        var c = qtyMap[name] || 0;
        if (c > 0) {
          accessoryRmb += calcLdPanelRmb(l, d) * c;
          hkdAddons += 100 * c;
        }
      });

      ['左板鏡面','右板鏡面','底板鏡面','頂板鏡面'].forEach(function(name) {
        var c = qtyMap[name] || 0;
        if (c > 0) {
          accessoryRmb += calcLdPanelRmb(l, d) * c;
        }
      });

      var backMirrorCount = qtyMap['背板鏡面'] || 0;
      if (backMirrorCount > 0) {
        accessoryRmb += calcBackPanelRmb(l, h) * backMirrorCount;
      }

      hkdAddons += (qtyMap['前板白色刻字'] || 0) * 70;
      hkdAddons += (qtyMap['前板彩色刻字'] || 0) * 90;

      if (lightBoardCount > 0 || backLightCount > 0) {
        accessoryRmb += calcPowerRmb();
      }

      var unitProductAmount = ((sizeRmb + accessoryRmb) / RMB_DIVISOR) + hkdAddons;
      // QTY 只應該倍增產品 / 配件本身金額。
      // 內地運費、香港運費及利潤均視為該行 item 的總數，由使用者或系統直接填入，不再因 QTY 被重複相乘。
      var lineAmount = (unitProductAmount * qty) + freight + hkDelivery + profit;
      var amountInput = row.querySelector('.f-amt');
      if (amountInput) amountInput.value = lineAmount.toFixed(2);
      return lineAmount;
    }

    function bindRowEvents(row) {
      row.querySelectorAll('input, select').forEach(function(el) {
        if (el.classList.contains('f-amt')) return;
        if (el.classList.contains('f-hk-delivery')) {
          el.addEventListener('input', function() {
            el.setAttribute('data-manual', '1');
            calcRowAmount(row);
            recalcSubtotal();
          });
          return;
        }
        var evt = (el.type === 'checkbox' || el.tagName === 'SELECT') ? 'change' : 'input';
        el.addEventListener(evt, function() {
          updateOuterDimensions(row);
          updateLocalDeliveryEstimate(row);
          calcRowAmount(row);
          recalcSubtotal();
        });
      });
    }

    function addRow() {
      var tbody = document.getElementById('itemsBody');
      var first = tbody.querySelector('tr');
      var clone = first.cloneNode(true);
      clone.querySelectorAll('input, select').forEach(function(el) {
        if (el.type === 'checkbox') {
          el.checked = false;
        } else if (el.tagName === 'SELECT') {
          el.selectedIndex = 0;
        } else if (el.type === 'number') {
          if (el.classList.contains('f-qty')) {
            el.value = '1';
          } else if (el.classList.contains('f-acc-qty')) {
            el.value = '0';
          } else {
            el.value = '';
          }
          if (el.classList.contains('f-hk-delivery')) {
            el.removeAttribute('data-manual');
            el.removeAttribute('data-auto-value');
          }
        } else {
          el.value = '';
        }
      });
      tbody.appendChild(clone);
      bindRowEvents(clone);
      updateOuterDimensionMode(clone);
      updateOuterDimensions(clone);
      updateLocalDeliveryEstimate(clone);
      recalcSubtotal();
    }
    function removeRow(btn) {
      var tbody = document.getElementById('itemsBody');
      if (tbody.querySelectorAll('tr').length <= 1) return;
      btn.closest('tr').remove();
      recalcSubtotal();
    }
    function recalcSubtotal() {
      var sum = 0;
      document.querySelectorAll('#itemsBody tr').forEach(function(row) {
        sum += calcRowAmount(row);
      });
      document.getElementById('subtotal').value = sum.toFixed(2);
      recalcTotal();
    }
    function getElValue(id) {
      var el = document.getElementById(id);
      return el ? el.value : '';
    }

    function setElValue(id, value) {
      var el = document.getElementById(id);
      if (el) el.value = value;
    }

    function setText(id, value) {
      var el = document.getElementById(id);
      if (el) el.textContent = value;
    }

    function formatMoney(value, decimals) {
      var n = Number(value) || 0;
      var fixed = typeof decimals === 'number' ? n.toFixed(decimals) : String(Math.ceil(n));
      return '$' + fixed.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    function calculateDiscountValue(subtotal) {
      var discountType = getElValue('discountType');
      var multiplier = parseFloat(getElValue('discountMultiplier'));
      var amount = parseFloat(getElValue('discountAmountHkd')) || 0;

      if (discountType === '百分比折扣') {
        if (isNaN(multiplier)) multiplier = 1;
        return Math.max(0, subtotal * (1 - multiplier));
      }
      if (discountType === '指定金額扣減') {
        return Math.max(0, Math.min(amount, subtotal));
      }
      return 0;
    }

    function buildDiscountDisplayText() {
      var discountType = getElValue('discountType');
      var reason = getElValue('discountReason');
      var multiplier = parseFloat(getElValue('discountMultiplier'));
      var amount = parseFloat(getElValue('discountAmountHkd')) || 0;
      if (discountType === '百分比折扣' && reason && !isNaN(multiplier)) {
        return reason + '：' + (Math.round(multiplier * 100) / 10) + '折優惠';
      }
      if (discountType === '指定金額扣減' && reason && amount > 0) {
        return reason + '：全單減 HKD $' + Math.ceil(amount);
      }
      return '';
    }

    function buildDeliveryDisplayText() {
      var mode = getElValue('deliveryChargeMode');
      var reason = getElValue('deliveryOfferReason');
      if (mode === '已包本地送貨') {
        return reason ? '已包本地送貨｜' + reason : '已包本地送貨';
      }
      if (mode === 'LKS 車隊 運費到付') return 'LKS 車隊 運費到付';
      return mode || '';
    }

    function toggleDiscountInputs() {
      var discountType = getElValue('discountType');
      var multiplierGroup = document.getElementById('discountMultiplierGroup');
      var amountGroup = document.getElementById('discountAmountGroup');
      if (multiplierGroup) multiplierGroup.style.display = discountType === '百分比折扣' ? 'block' : 'none';
      if (amountGroup) amountGroup.style.display = discountType === '指定金額扣減' ? 'block' : 'none';
      if (discountType !== '百分比折扣') setElValue('discountMultiplier', '');
      if (discountType !== '指定金額扣減') setElValue('discountAmountHkd', '');
      if (discountType === '無折扣') setElValue('discountReason', '');
    }

    function toggleDeliveryInputs() {
      var mode = getElValue('deliveryChargeMode');
      var group = document.getElementById('deliveryOfferReasonGroup');
      if (group) group.style.display = mode === '已包本地送貨' ? 'block' : 'none';
      if (mode !== '已包本地送貨') setElValue('deliveryOfferReason', '');
    }

    function applyPromotionPreset() {
      var promotion = getElValue('promotionType');
      if (promotion === 'ToyTV 專屬優惠') {
        setElValue('discountType', '指定金額扣減');
        setElValue('discountAmountHkd', '200');
        setElValue('discountMultiplier', '');
        setElValue('discountReason', 'ToyTV 專屬優惠');
        setElValue('deliveryChargeMode', '已包本地送貨');
        setElValue('deliveryOfferReason', 'ToyTV 專屬優惠免運費');
      } else if (promotion === '首次落單優惠' || promotion === '新客戶免運費') {
        setElValue('discountType', '無折扣');
        setElValue('discountAmountHkd', '');
        setElValue('discountMultiplier', '');
        setElValue('discountReason', '新客戶優惠');
        setElValue('deliveryChargeMode', '已包本地送貨');
        setElValue('deliveryOfferReason', '首次落單優惠');
      } else if (promotion === '現貨優惠') {
        setElValue('discountType', '無折扣');
        setElValue('discountAmountHkd', '');
        setElValue('discountMultiplier', '');
        setElValue('discountReason', '');
        setElValue('deliveryChargeMode', '已包本地送貨');
        setElValue('deliveryOfferReason', '');
      } else if (promotion === '') {
        setElValue('discountType', '無折扣');
        setElValue('discountAmountHkd', '');
        setElValue('discountMultiplier', '');
        setElValue('discountReason', '');
        setElValue('deliveryChargeMode', 'LKS 車隊 運費到付');
        setElValue('deliveryOfferReason', '');
      }
      toggleDiscountInputs();
      toggleDeliveryInputs();
    }

    function recalcTotal() {
      var sub = parseFloat(document.getElementById('subtotal').value) || 0;
      var discountValue = calculateDiscountValue(sub);
      var total = Math.max(0, Math.ceil(sub - discountValue));
      var discountText = buildDiscountDisplayText();
      var deliveryText = buildDeliveryDisplayText();
      document.getElementById('total').value = total;
      setText('previewSubtotal', formatMoney(sub, 2));
      setText('previewTotal', formatMoney(total, 0));
      setText('previewDeliveryText', deliveryText || '-');
      var discountRow = document.getElementById('previewDiscountRow');
      if (discountValue > 0) {
        if (discountRow) discountRow.style.display = 'flex';
        setText('previewDiscountText', discountText || '優惠折扣');
        setText('previewDiscountAmount', '-' + formatMoney(discountValue, 2));
      } else {
        if (discountRow) discountRow.style.display = 'none';
        setText('previewDiscountText', '優惠折扣');
        setText('previewDiscountAmount', '-$0.00');
      }
    }
    function collectItems() {
      var items = [];
      document.querySelectorAll('#itemsBody tr').forEach(function(row) {
        var acc = getAccessories(row);
        items.push({
          itemType: (row.querySelector('.f-type') || {}).value || '',
          forWhat: (row.querySelector('.f-for') || {}).value || '',
          interL: (row.querySelector('.f-il') || {}).value || '',
          interD: (row.querySelector('.f-id') || {}).value || '',
          interH: (row.querySelector('.f-ih') || {}).value || '',
          outerL: (row.querySelector('.f-ol') || {}).value || '',
          outerD: (row.querySelector('.f-od') || {}).value || '',
          outerH: (row.querySelector('.f-oh') || {}).value || '',
          noOfLevels: (row.querySelector('.f-lv') || {}).value || '',
          levelHeights: (row.querySelector('.f-lh') || {}).value || '',
          accessories: acc,
          accessoryQty: getAccessoryQtyMap(row),
          description: (row.querySelector('.f-desc') || {}).value || '',
          qty: (row.querySelector('.f-qty') || {}).value || '1',
          freight: (row.querySelector('.f-freight') || {}).value || '0',
          hongKongDelivery: (row.querySelector('.f-hk-delivery') || {}).value || '0',
          deliveryCostReserve: (row.querySelector('.f-hk-delivery') || {}).value || '0',
          profit: (row.querySelector('.f-profit') || {}).value || '0',
          estimatedPackageUnits: String(getEstimatedPackageUnits(row) || 0),
          localDeliveryOverride: ((row.querySelector('.f-hk-delivery') || {}).getAttribute('data-manual') === '1') ? 'true' : 'false',
          localDeliveryNotes: ((row.querySelector('.f-hk-delivery') || {}).getAttribute('data-manual') === '1') ? '香港運費已人手修改' : '香港運費由系統按包裝單位自動建議',
          amount: (row.querySelector('.f-amt') || {}).value || '0'
        });
      });
      return items;
    }

    var selectedCustomer = null;

    function renderCustomerResults(customers) {
      var box = document.getElementById('customerSearchResults');
      if (!box) return;
      if (!customers || customers.length === 0) {
        box.style.display = 'block';
        box.innerHTML = '<div style="padding:10px 12px;color:#6b7280;font-size:13px;">沒有找到客戶。可直接建立新客 Quote。</div>';
        return;
      }
      box.style.display = 'block';
      box.innerHTML = customers.map(function(c) {
        var safe = function(v) { return String(v || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); };
        var badge = c.source === 'legacy' ? ' <span style="display:inline-block;background:#fef3c7;color:#92400e;border-radius:999px;padding:2px 7px;font-size:11px;margin-left:6px;">Legacy 舊客</span>' : ' <span style="display:inline-block;background:#dbeafe;color:#1d4ed8;border-radius:999px;padding:2px 7px;font-size:11px;margin-left:6px;">Customers</span>';
        return '<button type="button" class="customer-result-row" data-id="' + safe(c.id) + '" style="display:block;width:100%;text-align:left;padding:10px 12px;border:0;border-bottom:1px solid #f3f4f6;background:#fff;cursor:pointer;">'
          + '<div style="font-weight:700;color:#111827;">' + safe(c.display || c.name || c.phone || c.id) + badge + '</div>'
          + '<div style="font-size:12px;color:#6b7280;">' + safe([c.email, c.address].filter(Boolean).join(' · ')) + '</div>'
          + '</button>';
      }).join('');

      box.querySelectorAll('.customer-result-row').forEach(function(btn, idx) {
        btn.addEventListener('click', function() {
          selectExistingCustomer(customers[idx]);
        });
      });
    }

    function searchExistingCustomers() {
      var input = document.getElementById('customerSearchInput');
      var q = input ? input.value.trim() : '';
      if (!q) {
        alert('請先輸入 Customer ID、姓名、電話或 Email。');
        return;
      }
      fetch('/api/customers/search?q=' + encodeURIComponent(q))
        .then(function(res) { return res.json(); })
        .then(function(data) { renderCustomerResults(data.customers || []); })
        .catch(function(err) { alert('Customer search error: ' + err.message); });
    }

    function selectExistingCustomer(customer) {
      selectedCustomer = customer;
      var idInput = document.getElementById('customerRecordId');
      var sourceInput = document.getElementById('customerSource');
      var legacyInput = document.getElementById('legacyCustomerRecordId');
      if (sourceInput) sourceInput.value = customer.source || 'customers';
      if (customer.source === 'legacy') {
        if (idInput) idInput.value = '';
        if (legacyInput) legacyInput.value = customer.id || '';
      } else {
        if (idInput) idInput.value = customer.id || '';
        if (legacyInput) legacyInput.value = '';
      }

      var form = document.getElementById('quoteForm');
      if (form) {
        if (customer.name) form.querySelector('[name=contactName]').value = customer.name;
        if (customer.phone) form.querySelector('[name=phone]').value = customer.phone;
      }

      var results = document.getElementById('customerSearchResults');
      if (results) results.style.display = 'none';
      var selectedBox = document.getElementById('selectedCustomerBox');
      if (selectedBox) {
        selectedBox.style.display = 'block';
        selectedBox.innerHTML = '<strong>已選擇客戶：</strong>'
          + (customer.source === 'legacy' ? '<span style="background:#fef3c7;color:#92400e;border-radius:999px;padding:2px 7px;font-size:11px;margin-right:6px;">Legacy 舊客</span>' : '')
          + [customer.customerId, customer.name, customer.phone].filter(Boolean).join(' | ')
          + (customer.email ? '<br>Email：' + customer.email : '')
          + (customer.address ? '<br>Address：' + customer.address : '');
      }
    }

    function clearSelectedCustomer() {
      selectedCustomer = null;
      var idInput = document.getElementById('customerRecordId');
      var sourceInput = document.getElementById('customerSource');
      var legacyInput = document.getElementById('legacyCustomerRecordId');
      if (idInput) idInput.value = '';
      if (sourceInput) sourceInput.value = '';
      if (legacyInput) legacyInput.value = '';
      var results = document.getElementById('customerSearchResults');
      if (results) results.style.display = 'none';
      var selectedBox = document.getElementById('selectedCustomerBox');
      if (selectedBox) {
        selectedBox.style.display = 'none';
        selectedBox.innerHTML = '';
      }
    }

    document.addEventListener('DOMContentLoaded', function() {
      document.querySelectorAll('#itemsBody tr').forEach(function(row) {
        bindRowEvents(row);
        updateOuterDimensions(row);
        updateLocalDeliveryEstimate(row);
      });
      document.getElementById('quoteForm').addEventListener('submit', function(e) {
        e.preventDefault();
        var form = e.target;
        var payload = {
          customerRecordId: (document.getElementById('customerRecordId') || {}).value || '',
          customerSource: (document.getElementById('customerSource') || {}).value || '',
          legacyCustomerRecordId: (document.getElementById('legacyCustomerRecordId') || {}).value || '',
          contactName: form.querySelector('[name=contactName]').value,
          phone: form.querySelector('[name=phone]').value,
          contactMethod: form.querySelector('[name=contactMethod]').value,
          contactHandle: form.querySelector('[name=contactHandle]').value,
          subtotal: document.getElementById('subtotal').value,
          quoteLanguage: getElValue('quoteLanguage') || '中文',
          quoteSourceChannel: getElValue('quoteSourceChannel'),
          campaignSourceDetail: getElValue('campaignSourceDetail'),
          inquiryRecordId: getElValue('inquiryRecordId'),
          performanceMonthRecordId: getElValue('performanceMonthRecordId'),
          promotionType: getElValue('promotionType'),
          discountType: getElValue('discountType'),
          discountMultiplier: getElValue('discountMultiplier'),
          discountAmountHkd: getElValue('discountAmountHkd'),
          discountReason: getElValue('discountReason'),
          discountValueHkd: calculateDiscountValue(parseFloat(document.getElementById('subtotal').value) || 0),
          discountDisplayText: buildDiscountDisplayText(),
          deliveryChargeMode: getElValue('deliveryChargeMode'),
          deliveryOfferReason: getElValue('deliveryOfferReason'),
          deliveryDisplayText: buildDeliveryDisplayText(),
          total: document.getElementById('total').value,
          validUntil: form.querySelector('[name=validUntil]').value,
          notes: form.querySelector('[name=notes]').value,
          terms: form.querySelector('[name=terms]').value,
          items: collectItems()
        };
        fetch('/quote/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).then(function(res) { return res.text(); })
          .then(function(html) {
            document.open();
            document.write(html);
            document.close();
          })
          .catch(function(err) { alert('Error: ' + err.message); });
      });
      toggleDiscountInputs();
      toggleDeliveryInputs();
      recalcSubtotal();
    });
  </script>`;

  res.send(renderPage('Create Quote', content, extraHead));
});

// ═══════════════════════════════════════════════════════════════════════════
// ROUTE: POST /quote/create
// ═══════════════════════════════════════════════════════════════════════════
app.post('/quote/create', async (req: Request, res: Response) => {
  try {
    const b = req.body;

    // Body is JSON from fetch — items is already a clean array
    let items: any[] = Array.isArray(b.items) ? b.items : [];
    // Filter empty rows
    items = items.filter((item: any) => item && (item.itemType || item.amount));
    // Normalize
    items = items.map((item: any) => ({
      itemType: String(item.itemType || ''),
      forWhat: String(item.forWhat || ''),
      interL: String(item.interL || ''),
      interD: String(item.interD || ''),
      interH: String(item.interH || ''),
      outerL: String(item.outerL || ''),
      outerD: String(item.outerD || ''),
      outerH: String(item.outerH || ''),
      noOfLevels: item.noOfLevels ? parseInt(String(item.noOfLevels)) : null,
      levelHeights: String(item.levelHeights || ''),
      accessories: Array.isArray(item.accessories) ? item.accessories.map((a: any) => String(a)) : [],
      accessoryQty: (item.accessoryQty && typeof item.accessoryQty === 'object') ? item.accessoryQty : {},
      description: String(item.description || ''),
      qty: parseInt(String(item.qty)) || 1,
      freight: parseFloat(String(item.freight)) || 0,
      hongKongDelivery: parseFloat(String(item.hongKongDelivery ?? item.deliveryCostReserve ?? item.localDelivery)) || 0,
      deliveryCostReserve: parseFloat(String(item.deliveryCostReserve ?? item.hongKongDelivery ?? item.localDelivery)) || 0,
      profit: parseFloat(String(item.profit)) || 0,
      estimatedPackageUnits: parseFloat(String(item.estimatedPackageUnits)) || 0,
      localDeliveryOverride: String(item.localDeliveryOverride) === 'true' || item.localDeliveryOverride === true,
      localDeliveryNotes: String(item.localDeliveryNotes || ''),
      amount: parseFloat(String(item.amount)) || 0,
    }));

    const itemsJson = JSON.stringify(items);
    const descriptionSummary = items
      .map((item: any) => {
        const parts = [
          item.itemType,
          item.forWhat,
          item.description,
          item.interL && item.interD && item.interH ? `內尺寸 ${item.interL}*${item.interD}*${item.interH}` : '',
          item.outerL && item.outerD && item.outerH ? `外尺寸 ${item.outerL}*${item.outerD}*${item.outerH}` : '',
          item.noOfLevels ? `${item.noOfLevels}層` : '',
          item.levelHeights ? `層高 ${item.levelHeights}` : '',
          item.accessories ? `配件 ${Array.isArray(item.accessories) ? item.accessories.join(', ') : item.accessories}` : '',
          item.qty ? `QTY ${item.qty}` : '',
          item.freight ? `內地運費 $${item.freight}` : '',
          item.hongKongDelivery ? `香港運費 $${item.hongKongDelivery}` : '',
          item.profit ? `利潤 $${item.profit}` : '',
          item.amount ? `$${item.amount}` : '',
        ].filter(Boolean);
        return parts.join(' | ');
      })
      .join('\n');
    const subtotal = parseFloat(b.subtotal) || 0;
    const quoteLanguage = String(b.quoteLanguage || '中文') === 'English' ? 'English' : '中文';
    const promotionType = String(b.promotionType || '');
    const discountType = String(b.discountType || '無折扣');
    const discountMultiplierRaw = parseFloat(String(b.discountMultiplier));
    const discountMultiplier = Number.isFinite(discountMultiplierRaw) ? discountMultiplierRaw : null;
    const discountAmountHkd = parseFloat(String(b.discountAmountHkd)) || 0;
    const discountReason = String(b.discountReason || '');
    const deliveryChargeMode = String(b.deliveryChargeMode || '已包本地送貨');
    const deliveryOfferReason = String(b.deliveryOfferReason || '');
    const quoteSourceChannel = String(b.quoteSourceChannel || '').trim();
    const campaignSourceDetail = String(b.campaignSourceDetail || '').trim();
    const inquiryRecordId = String(b.inquiryRecordId || '').trim();
    const performanceMonthRecordId = String(b.performanceMonthRecordId || '').trim();

    let discountValueHkd = 0;
    if (discountType === '百分比折扣') {
      const multiplier = discountMultiplier ?? 1;
      discountValueHkd = Math.max(0, subtotal * (1 - multiplier));
    } else if (discountType === '指定金額扣減') {
      discountValueHkd = Math.max(0, Math.min(discountAmountHkd, subtotal));
    }
    discountValueHkd = Math.round(discountValueHkd * 100) / 100;

    const total = Math.max(0, Math.ceil(subtotal - discountValueHkd));
    const discountRate = subtotal > 0 ? Math.max(0, Math.round((total / subtotal) * 10000) / 10000) : 1;

    const discountDisplayText = String(b.discountDisplayText || (discountValueHkd > 0
      ? (discountType === '百分比折扣' && discountReason && discountMultiplier
        ? `${discountReason}：${Math.round(discountMultiplier * 100) / 10}折優惠`
        : (discountType === '指定金額扣減' && discountReason
          ? `${discountReason}：全單減 HKD $${Math.ceil(discountAmountHkd)}`
          : '優惠折扣'))
      : ''));
    const deliveryDisplayText = String(b.deliveryDisplayText || (deliveryChargeMode === '已包本地送貨'
      ? (deliveryOfferReason && deliveryOfferReason !== '不適用' ? `已包本地送貨｜${deliveryOfferReason}` : '已包本地送貨')
      : deliveryChargeMode));

    const quoteNumber = await getNextNumber(tableQuotes, 'Quote Number', 'QT');
    const publicToken = generateToken();
    const quoteDate = new Date().toISOString().split('T')[0];

    let selectedCustomerId = String(b.customerRecordId || '').trim();
    const customerSource = String(b.customerSource || '').trim();
    const legacyCustomerRecordId = String(b.legacyCustomerRecordId || '').trim();
    let selectedCustomerFields: FieldSet | null = null;

    if (customerSource === 'legacy' && legacyCustomerRecordId) {
      try {
        const activatedCustomer = await activateLegacyCustomer(legacyCustomerRecordId);
        selectedCustomerId = activatedCustomer.id;
        selectedCustomerFields = activatedCustomer.fields;
      } catch (error) {
        console.error('Legacy customer activation failed:', error);
        selectedCustomerId = '';
        selectedCustomerFields = null;
      }
    } else if (selectedCustomerId) {
      try {
        const selectedCustomerRecord = await tableCustomers.find(selectedCustomerId);
        selectedCustomerFields = selectedCustomerRecord.fields;
      } catch {
        selectedCustomerId = '';
        selectedCustomerFields = null;
      }
    }

    const quoteCustomerName = selectedCustomerFields ? getCustomerText(selectedCustomerFields, 'Customer Name') : '';
    const quoteCustomerPhone = selectedCustomerFields ? getCustomerText(selectedCustomerFields, 'Phone') : '';
    const quoteCustomerEmail = selectedCustomerFields ? getCustomerText(selectedCustomerFields, 'Email') : '';
    const quoteCustomerAddress = selectedCustomerFields ? getCustomerText(selectedCustomerFields, 'Address') : '';

    const quoteFields: FieldSet = {
        'Quote Number': quoteNumber,
        'Quote Date': quoteDate,
        'Public Token': publicToken,
        'Quote Language': quoteLanguage,
        ...(quoteSourceChannel ? { 'Quote Source / Channel': quoteSourceChannel } : {}),
        ...(campaignSourceDetail ? { 'Campaign / Source Detail': campaignSourceDetail } : {}),
        ...(inquiryRecordId ? { 'Inquiry': [inquiryRecordId] } : {}),
        ...(performanceMonthRecordId ? { 'Performance Month': [performanceMonthRecordId] } : {}),
        'Valid Until': b.validUntil && b.validUntil.trim() ? b.validUntil.trim() : null,
        'Contact Name': b.contactName,
        'Phone': b.phone,
        'Contact Method': b.contactMethod,
        'Contact Handle / Reference': b.contactHandle || '',
        'Sub Total': subtotal,
        // Legacy Discount is kept as an effective multiplier so old Airtable formulas/views stay compatible.
        'Discount': discountRate,
        'Total': total,
        'Promotion / Offer Type': promotionType || undefined,
        'Discount Type': discountType,
        'Discount Multiplier': discountType === '百分比折扣' && discountMultiplier !== null ? discountMultiplier : undefined,
        'Discount Amount HKD': discountType === '指定金額扣減' ? discountAmountHkd : 0,
        'Discount Reason': discountReason || undefined,
        // Discount Value HKD / Discount Display Text / Delivery Display Text are Airtable formula fields in Quotes, so do not write them here.
        'Delivery Charge Mode': deliveryChargeMode,
        'Delivery Offer Reason': deliveryOfferReason || undefined,
        'Quote Items JSON': itemsJson,
        'Description Summary': descriptionSummary,
        'Notes': b.notes || '',
        'Terms and Conditions': b.terms || '',
        'Created At': new Date().toISOString(),
        'Status': 'Draft',
        ...(selectedCustomerId ? {
          'Customer': [selectedCustomerId],
          'Customer Name': quoteCustomerName || b.contactName,
          'Customer Phone': quoteCustomerPhone || b.phone,
          'Customer Email': quoteCustomerEmail,
          'Chinese Delivery Address': quoteCustomerAddress,
        } : {}),
      };

    const createdQuoteRecords = await tableQuotes.create([{ fields: quoteFields }]);
    const createdQuoteRecordId = createdQuoteRecords[0].id;

    // V13: Auto-create / update Inquiry from Create Quote so daily workflow does not require double entry.
    // If an Inquiry is manually selected, link this Quote back to it and mark it as Quoted.
    // If no Inquiry is selected, create a new Inquiry record from the Quote source fields, then link it back to the Quote.
    try {
      if (inquiryRecordId) {
        const inquiryUpdateFields: FieldSet = {
          'Inquiry Status': 'Quoted',
          'Quote': [createdQuoteRecordId],
          ...(performanceMonthRecordId ? { 'Performance Month': [performanceMonthRecordId] } : {}),
          ...(quoteSourceChannel ? { 'Channel': quoteSourceChannel } : {}),
          ...(campaignSourceDetail ? { 'Campaign / Source Detail': campaignSourceDetail } : {}),
        };
        await tableInquiries.update([{ id: inquiryRecordId, fields: inquiryUpdateFields }]);
      } else if (quoteSourceChannel || performanceMonthRecordId || campaignSourceDetail) {
        const firstItem = items[0] || {};
        const autoInquiryFields: FieldSet = {
          'Inquiry Date': quoteDate,
          'Customer Name': quoteCustomerName || String(b.contactName || '').trim(),
          'Phone': quoteCustomerPhone || String(b.phone || '').trim(),
          ...(quoteSourceChannel ? { 'Channel': quoteSourceChannel } : {}),
          ...(campaignSourceDetail ? { 'Campaign / Source Detail': campaignSourceDetail } : {}),
          ...(firstItem.itemType ? { 'Product Interest': firstItem.itemType } : {}),
          'Inquiry Status': 'Quoted',
          'Quote': [createdQuoteRecordId],
          ...(performanceMonthRecordId ? { 'Performance Month': [performanceMonthRecordId] } : {}),
          'Notes': `Auto-created from Create Quote ${quoteNumber}`,
        };
        const createdInquiryRecords = await tableInquiries.create([{ fields: autoInquiryFields }]);
        await tableQuotes.update([{
          id: createdQuoteRecordId,
          fields: { 'Inquiry': [createdInquiryRecords[0].id] } as FieldSet,
        }]);
      }
    } catch (inquiryError) {
      console.error('V13 inquiry auto-link failed:', inquiryError);
      // Do not block quote creation if Inquiry automation fails.
    }

    const publicLink = `${PUBLIC_BASE_URL}/quote/${publicToken}`;
    const customerInfoLink = `${PUBLIC_BASE_URL}/quote/${publicToken}/customer-info`;

    res.send(renderPage('Quote Created', `
      <div class="doc-card">
        ${docHeader('報價單已建立', 'Quote Created')}
        <div class="doc-body">
          <div class="alert alert-success">Quote created successfully!</div>
          <div class="info-grid info-grid-2" style="margin-bottom:20px;">
            <div class="info-block"><div class="lbl">Quote Number</div><div class="val">${escapeHtml(quoteNumber)}</div></div>
            <div class="info-block"><div class="lbl">Quote Date</div><div class="val">${quoteDate}</div></div>
          </div>
          <div class="section">
            <div class="section-title">Links</div>
            <p style="margin-bottom:8px;"><strong>Quote (Customer View):</strong><br>
              <a href="${publicLink}" target="_blank">${publicLink}</a>
            </p>
            <p><strong>Customer Info Form:</strong><br>
              <a href="${customerInfoLink}" target="_blank">${customerInfoLink}</a>
            </p>
          </div>
          <div style="margin-top:20px;display:flex;gap:10px;">
            <a href="/quotes" class="btn btn-secondary">Back to Dashboard</a>
            <a href="/quote/create" class="btn btn-outline">Create Another</a>
          </div>
        </div>
      </div>
    `));
  } catch (error: any) {
    console.error(error);
    res.status(500).send(renderPage('Error', `<div class="alert alert-danger">Error creating quote: ${escapeHtml(error.message)}</div><a href="/quote/create" class="btn btn-secondary" style="margin-top:10px;">Back</a>`));
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ROUTE: GET /quote/:token  — Public Quote View
// ═══════════════════════════════════════════════════════════════════════════
app.get('/quote/:token', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const records = await tableQuotes.select({ filterByFormula: `{Public Token} = '${token}'` }).firstPage();
    if (records.length === 0) return res.status(404).send(renderPage('Not Found', '<div class="alert alert-danger">Quote not found.</div>'));

    const quote = records[0].fields;
    const status = (quote['Status'] as string) || 'Draft';
    const quoteLanguage = ((quote['Quote Language'] as string) || '中文') === 'English' ? 'English' : '中文';
    const isEnglish = quoteLanguage === 'English';
    const L = {
      quoteTitle: isEnglish ? 'Quotation' : '報價單',
      quoteSubTitle: isEnglish ? '' : 'Quotation',
      quoteNumber: isEnglish ? 'Quote Number' : '報價編號',
      date: isEnglish ? 'Date' : '報價日期',
      validUntil: isEnglish ? 'Valid Until' : '報價有效日期',
      contactInfo: isEnglish ? 'Contact Information' : '客戶資料',
      contactName: isEnglish ? 'Contact Name' : '聯絡人',
      phone: isEnglish ? 'Phone' : '電話',
      contactMethod: isEnglish ? 'Contact Method' : '聯絡方式',
      contactHandle: isEnglish ? 'Contact Handle / Reference' : '聯絡帳號 / 參考',
      items: isEnglish ? 'Items' : '產品項目',
      itemType: isEnglish ? 'Item Type' : '產品類型',
      forWhat: isEnglish ? 'For What' : '擺放物品',
      interL: isEnglish ? 'Internal L' : '內長',
      interD: isEnglish ? 'Internal D' : '內深',
      interH: isEnglish ? 'Internal H' : '內高',
      outerL: isEnglish ? 'Outer L' : '外長',
      outerD: isEnglish ? 'Outer D' : '外深',
      outerH: isEnglish ? 'Outer H' : '外高',
      levels: isEnglish ? 'Levels' : '層數',
      levelHeights: isEnglish ? 'Level Heights' : '每層高度',
      accessories: isEnglish ? 'Accessories' : '配件',
      description: isEnglish ? 'Description' : '描述',
      qty: isEnglish ? 'QTY' : '數量',
      amount: isEnglish ? 'Amount' : '金額',
      subtotal: isEnglish ? 'Subtotal' : '小計',
      delivery: isEnglish ? 'Delivery Arrangement' : '送貨安排',
      total: isEnglish ? 'Total' : '總額',
      notes: isEnglish ? 'Notes' : '備註',
      terms: isEnglish ? 'Terms and Conditions' : '條款及細則',
      thankYou: isEnglish ? 'Thank you!' : '多謝！'
    };
    const mapDiscountReasonEn = (reason: string): string => {
      const map: Record<string, string> = {
        'ToyTV 專屬優惠': 'ToyTV exclusive offer',
        '新客戶優惠': 'New customer offer',
        '回購優惠': 'Returning customer offer'
      };
      return map[reason] || reason || 'Offer discount';
    };
    const buildShareDiscountText = (): string => {
      if (!isEnglish) return (quote['Discount Display Text'] as string) || '';
      const reason = mapDiscountReasonEn(String(quote['Discount Reason'] || ''));
      const type = String(quote['Discount Type'] || '');
      const amount = Number(quote['Discount Amount HKD'] || 0);
      const multiplier = Number(quote['Discount Multiplier'] || 0);
      if (type === '指定金額扣減' && amount > 0) return `${reason}: HKD $${Math.ceil(amount)} off`;
      if (type === '百分比折扣' && multiplier > 0) return `${reason}: ${Math.round((1 - multiplier) * 100)}% off`;
      return 'Offer discount';
    };
    // Parse items
    let items: any[] = [];
    items = parseQuoteItems(quote['Quote Items JSON']);

    const buildShareDeliveryText = (): string =>
      buildDeliveryWaiverText(quote, isEnglish, sumQuoteLocalDelivery(items), quote['Valid Until']);

    const subtotal = (quote['Sub Total'] as number) || 0;
    const discountRate = (quote['Discount'] as number) ?? 1;
    const total = (quote['Total'] as number) || 0;
    const discountAmount = Number(quote['Discount Value HKD'] || 0) || Math.max(0, subtotal - total);
    const discountDisplayText = discountAmount > 0 ? buildShareDiscountText() : '';
    const deliveryDisplayText = buildShareDeliveryText();

    // Items table rows
    const descriptionSummary = (quote['Description Summary'] as string) || '';

    const itemRows = items.length === 0
      ? (
          descriptionSummary
            ? `<tr>
                <td>1</td>
                <td colspan="10" style="white-space:pre-line;">${nl2br(descriptionSummary)}</td>
              </tr>`
            : '<tr><td colspan="11" style="text-align:center;color:#9ca3af;">No items</td></tr>'
        )
      : items.map((item: any, idx: number) => {
          return `<tr class="item-main-row">
            <td>${idx + 1}</td>
            <td>${escapeHtml(item.itemType) || '-'}</td>
            <td>${escapeHtml(item.forWhat) || '-'}</td>
            <td style="text-align:center;">${item.interL || '-'}</td>
            <td style="text-align:center;">${item.interD || '-'}</td>
            <td style="text-align:center;">${item.interH || '-'}</td>
            <td style="text-align:center;">${item.outerL || '-'}</td>
            <td style="text-align:center;">${item.outerD || '-'}</td>
            <td style="text-align:center;">${item.outerH || '-'}</td>
            <td style="text-align:center;">${item.noOfLevels || '-'}</td>
            <td>${escapeHtml(item.levelHeights) || '-'}</td>
          </tr>
          <tr class="item-sub-detail">
            <td></td>
            <td colspan="5"><div class="mini-label">${L.accessories}</div>${renderAccTags(item.accessories)}</td>
            <td colspan="3"><div class="mini-label">${L.description}</div>${escapeHtml(item.description) || '-'}</td>
            <td style="text-align:center;"><div class="mini-label">${L.qty}</div>${item.qty || 1}</td>
            <td style="text-align:right;"><div class="mini-label">${L.amount}</div>$${item.amount || 0}</td>
          </tr>`;
        }).join('');

    // Contact info block (always shown from Quotes table)
    const contactName = (quote['Contact Name'] as string) || '';
    const contactPhone = (quote['Phone'] as string) || '';
    const contactMethod = (quote['Contact Method'] as string) || '';
    const contactHandle = (quote['Contact Handle / Reference'] as string) || '';

    const contactBlock = `
      <div class="section">
        <div class="section-title">Contact Information</div>
        <div class="info-grid info-grid-2">
          <div class="info-block"><div class="lbl">${L.contactName}</div><div class="val-sm">${escapeHtml(contactName) || 'N/A'}</div></div>
          <div class="info-block"><div class="lbl">${L.phone}</div><div class="val-sm">${escapeHtml(contactPhone) || 'N/A'}</div></div>
          <div class="info-block"><div class="lbl">${L.contactMethod}</div><div class="val-sm">${escapeHtml(contactMethod) || 'N/A'}</div></div>
          <div class="info-block"><div class="lbl">${L.contactHandle}</div><div class="val-sm">${escapeHtml(contactHandle) || 'N/A'}</div></div>
        </div>
      </div>`;

    const content = `
      <div class="doc-card">
        ${docHeader(L.quoteTitle, L.quoteSubTitle, isEnglish)}
        <div class="doc-body">

          <div class="info-grid info-grid-3" style="margin-bottom:16px;">
            <div class="info-block">
              <div class="lbl">${L.quoteNumber}</div>
              <div class="val">${escapeHtml(quote['Quote Number'] as string)}</div>
            </div>
            <div class="info-block">
              <div class="lbl">${L.date}</div>
              <div class="val-sm">${escapeHtml(quote['Quote Date'] as string)}</div>
            </div>
            ${quote['Valid Until'] ? `<div class="info-block"><div class="lbl">${L.validUntil}</div><div class="val-sm">${escapeHtml(quote['Valid Until'] as string)}</div></div>` : '<div></div>'}
          </div>

          ${contactBlock}

          <div class="section">
            <div class="section-title">${L.items}</div>
            <div style="overflow-x:auto;">
              <div class="material-banner">${escapeHtml(isEnglish ? MATERIAL_NOTE_EN : MATERIAL_NOTE)}</div><table class="items-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>${L.itemType}</th>
                    <th>${L.forWhat}</th>
                    <th>${L.interL}</th>
                    <th>${L.interD}</th>
                    <th>${L.interH}</th>
                    <th>${L.outerL}</th>
                    <th>${L.outerD}</th>
                    <th>${L.outerH}</th>
                    <th>${L.levels}</th>
                    <th>${L.levelHeights}</th>
                  </tr>
                </thead>
                <tbody>${itemRows}</tbody>
              </table>
            </div>
          </div>

          <div class="totals-box">
            <div class="row"><span>${L.subtotal}</span><span>$${subtotal.toFixed(2)}</span></div>
            ${discountAmount > 0 ? `<div class="row discount-row"><span>${escapeHtml(discountDisplayText)}</span><span>-$${discountAmount.toFixed(2)}</span></div>` : ''}
            ${deliveryDisplayText ? `<div class="row delivery-row"><span>${L.delivery}</span><span>${nl2br(deliveryDisplayText)}</span></div>` : ''}
            <div class="row total-row"><span>${L.total}</span><span>$${Math.ceil(total)}</span></div>
          </div>

          ${quote['Notes'] ? `<div class="section" style="margin-top:16px;"><div class="section-title">${L.notes}</div><p style="font-size:14px;">${nl2br(isEnglish ? DEFAULT_QUOTE_NOTES_EN : String(quote['Notes'] || ''))}</p></div>` : ''}
          ${quote['Terms and Conditions'] ? `<div class="section"><div class="section-title">${L.terms}</div><p style="font-size:13px;color:#374151;">${nl2br(isEnglish ? DEFAULT_TERMS_EN : String(quote['Terms and Conditions'] || ''))}</p></div>` : ''}

          <div class="thank-you">${L.thankYou}</div>
        </div>
      </div>
    `;

    res.send(renderPage(`${isEnglish ? 'Quote' : '報價單'} ${quote['Quote Number']}`, content));
  } catch (error: any) {
    console.error(error);
    res.status(500).send(renderPage('Error', `<div class="alert alert-danger">Error: ${escapeHtml(error.message)}</div>`));
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ROUTE: GET /quote/:token/customer-info  — Customer fills in details
// ═══════════════════════════════════════════════════════════════════════════
app.get('/quote/:token/customer-info', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const records = await tableQuotes.select({ filterByFormula: `{Public Token} = '${token}'` }).firstPage();
    if (records.length === 0) return res.status(404).send(renderPage('Not Found', '<div class="alert alert-danger">Quote not found.</div>'));

    const quote = records[0].fields;
    const status = (quote['Status'] as string) || 'Draft';
    const qNum = escapeHtml(quote['Quote Number'] as string);
    const quoteLanguage = normalizeQuoteLanguage(quote['Quote Language']);
    const isEnglish = quoteLanguage === 'English';
    const C = {
      infoTitle: isEnglish ? 'Customer Information' : '客戶資料',
      infoSubtitle: isEnglish ? '' : 'Customer Information',
      submittedAlert: isEnglish ? `Quote ${qNum} — Customer information has been submitted.` : `報價單 ${qNum} — 客戶資料已提交。`,
      name: isEnglish ? 'Name' : '姓名',
      phone: isEnglish ? 'Phone' : '電話',
      email: isEnglish ? 'Email' : '電郵',
      address: isEnglish ? 'Delivery Address' : '送貨地址',
      paymentMethod: isEnglish ? 'Payment Method' : '付款方式',
      howKnow: isEnglish ? 'How Did You Know Us' : '如何認識我們',
      backDashboard: isEnglish ? 'Back to Dashboard' : '返回後台',
      viewQuote: isEnglish ? 'View Quote' : '查看報價單',
      formTitle: isEnglish ? 'Confirm Order Details' : '填寫資料',
      formSubtitle: isEnglish ? 'Please fill in the details below for order arrangement' : '請填寫以下資料以便後續安排',
      productionTitle: isEnglish ? 'Production and Delivery Schedule' : '製作及發貨安排',
      installationTitle: isEnglish ? 'Installation Notes' : '安裝須知',
      orderConfirmAlert: isEnglish ? `You are confirming <strong>Quote ${qNum}</strong>. Please fill in the details below for order arrangement.` : `您正在確認 <strong>報價單 ${qNum}</strong> 的訂單。請填寫以下資料以便後續安排。`,
      yourInfo: isEnglish ? 'Your Information' : '您的資料',
      fullName: isEnglish ? 'Full Name *' : '姓名 *',
      chineseAddress: isEnglish ? 'Delivery Address *' : '中文送貨地址 *',
      howKnowOptional: isEnglish ? 'How did you know us? (Optional)' : '如何認識我們？（選填）',
      select: isEnglish ? '-- Select --' : '-- 請選擇 --',
      privacy: isEnglish ? 'The personal information you provide will only be used for order follow-up, delivery arrangement and customer contact. All information will be kept confidential and will not be disclosed to third parties or used for other unauthorized purposes.' : '閣下所提供的個人資料僅作訂單跟進、送貨安排及客戶聯絡之用途，所有資料將予以保密，並不會向第三方公開或作其他未經授權之用途。',
      submit: isEnglish ? 'Submit & Confirm Order' : '提交並確認訂單',
      receivedTitle: isEnglish ? 'Thank You' : '多謝您的確認',
      receivedSubtitle: isEnglish ? 'Information received' : 'Thank You',
      receivedPageTitle: isEnglish ? 'Information Received' : '已收到資料',
    };
    const productionText = isEnglish
      ? `Lead time 🕐<br><br>📦 <strong>Tailor-made display box / stackable display case</strong><br>Usually ready for dispatch within <strong>30 working days</strong> ☺️<br><br>⚡ <strong>Ready-made / in-stock products</strong><br>Usually ready for dispatch within <strong>15 working days</strong> 😊<br><br>During long holidays such as Lunar New Year or National Day,<br>lead time may be extended by an additional <strong>10–15 working days</strong> 🙏🏻<br><br>Please do not place an order if the lead time is not suitable for you 🙏🏻<br><br>If the order is completed earlier, we will arrange dispatch as soon as possible 😊<br>🔥 Early ordering is recommended 🔥<br>❗️Rush orders are not accepted❗️`
      : `貨期時間🕐<br><br>📦 <strong>度身訂造展示盒／疊高展示櫃</strong><br>一般會於 <strong>30個工作天內發貨</strong> ☺️<br><br>⚡ <strong>現貨成品</strong><br>一般會於 <strong>15個工作天內發貨</strong> 😊<br><br>如遇農曆新年、國慶等長假期，<br>貨期需額外增加 <strong>10–15個工作天</strong> 🙏🏻<br><br>介意貨期者請勿下單🙏🏻<br><br>如提早完成，我哋會立即安排發貨😊<br>🔥 寧早莫遲，建議預早訂購 🔥<br>❗️不接急單❗️`;
    const installationText = isEnglish
      ? `🔧 Installation notes<br><br>Each display box and stair accessory requires self-installation.<br>The installation process is simple ☺️<br><br>No glue is needed,<br>and no heavy force is required 💪🏻<br>If needed, the display box can also be disassembled and reassembled later 😉<br><br>An electronic installation guide will be provided upon delivery for easy reference 😎<br><br>For orders delivered by the LKS fleet, if any panel issue is found after delivery,<br>please contact us within 3 days after receiving the goods for panel replacement arrangement 🙏🏻<br><br>🌟 Human damage is excluded 🌟`
      : `🔧 安裝說明<br><br>每個展示盒及樓梯配件均需要自行安裝，<br>安裝過程非常簡單☺️<br><br>全程唔需要用膠水，<br>亦唔需要「大力士」先裝到💪🏻<br>日後有需要時，亦可以自行拆卸及重新安裝😉<br><br>送貨時會附上電子版安裝說明書，方便跟住步驟安裝😎<br><br>使用 LKS 車隊送貨，如收貨後發現板件有問題，<br>可於收貨後 3 日內聯絡我哋安排補板🙏🏻<br><br>🌟 人為損壞除外 🌟`;

    // If already submitted, show read-only view
    if (status === 'Ready to Convert' || status === 'Mark as Paid') {
      const custName = escapeHtml((quote['Customer Name'] as string) || 'N/A');
      const custPhone = escapeHtml((quote['Customer Phone'] as string) || 'N/A');
      const custEmail = escapeHtml((quote['Customer Email'] as string) || 'N/A');
      const custAddr = escapeHtml((quote['Chinese Delivery Address'] as string) || 'N/A');
      const payMethod = escapeHtml((quote['Payment Method'] as string) || 'N/A');
      const howKnow = escapeHtml((quote['How Did You Know Us'] as string) || 'N/A');

      const content = `
        <div class="doc-card">
          ${docHeader(C.infoTitle, C.infoSubtitle, isEnglish)}
          <div class="doc-body">
            <div class="alert alert-info">${C.submittedAlert}</div>
            <div class="info-grid info-grid-2">
              <div class="info-block"><div class="lbl">${C.name}</div><div class="val-sm">${custName}</div></div>
              <div class="info-block"><div class="lbl">${C.phone}</div><div class="val-sm">${custPhone}</div></div>
              <div class="info-block"><div class="lbl">${C.email}</div><div class="val-sm">${custEmail}</div></div>
              <div class="info-block"><div class="lbl">${C.address}</div><div class="val-sm">${custAddr}</div></div>
              <div class="info-block"><div class="lbl">${C.paymentMethod}</div><div class="val-sm">${payMethod}</div></div>
              <div class="info-block"><div class="lbl">${C.howKnow}</div><div class="val-sm">${howKnow}</div></div>
            </div>
            <div style="margin-top:20px;display:flex;gap:10px;">
              <a href="/quotes" class="btn btn-secondary">${C.backDashboard}</a>
              <a href="/quote/${token}" class="btn btn-outline" target="_blank">${C.viewQuote}</a>
            </div>
          </div>
        </div>`;
      return res.send(renderPage(`${C.infoTitle} — ${qNum}`, content));
    }

    // Show form for Draft / Pending Customer Info
    const prefillName = escapeHtml((quote['Customer Name'] as string) || '');
    const prefillPhone = escapeHtml((quote['Customer Phone'] as string) || (quote['Phone'] as string) || '');
    const prefillEmail = escapeHtml((quote['Customer Email'] as string) || '');
    const prefillAddr = escapeHtml((quote['Chinese Delivery Address'] as string) || '');

    const content = `
      <div class="doc-card">
        ${docHeader(C.formTitle, C.formSubtitle, isEnglish)}
        <div class="doc-body">
          <div class="info-grid info-grid-2" style="margin-bottom:16px;">
            <div class="info-block">
              <div class="lbl">${C.productionTitle}</div>
              <div class="val-sm">${productionText}</div>
            </div>
            <div class="info-block">
              <div class="lbl">${C.installationTitle}</div>
              <div class="val-sm">${installationText}</div>
            </div>
          </div>

<div class="alert alert-info">${C.orderConfirmAlert}</div>

          <form action="/quote/${token}/customer-info" method="POST">
            <div class="section">
              <div class="section-title">${C.yourInfo}</div>
              <div class="form-row form-row-2">
                <div class="form-group">
                  <label>${C.fullName}</label>
                  <input type="text" name="customerName" value="${prefillName}" required>
                </div>
                <div class="form-group">
                  <label>${C.phone} *</label>
                  <input type="text" name="customerPhone" value="${prefillPhone}" required>
                </div>
              </div>
              <div class="form-group">
                <label>${C.email} *</label>
                <input type="email" name="customerEmail" value="${prefillEmail}" required>
              </div>
              <div class="form-group">
                <label>${C.chineseAddress}</label>
                <textarea name="chineseDeliveryAddress" rows="3" required>${prefillAddr}</textarea>
              </div>
              <div class="form-group">
                <label>${C.howKnowOptional}</label>
                <select name="howDidYouKnowUs">
                  <option value="">${C.select}</option>
                  <option value="朋友介紹">朋友介紹</option>
                  <option value="Facebook">Facebook</option>
                  <option value="IG">IG</option>
                  <option value="網站搜尋 Google">網站搜尋 Google</option>
                </select>
              </div>
            </div>

<div class="privacy-notice">${C.privacy}</div>

            <div style="margin-top:20px;text-align:right;">
              <button type="submit" class="btn btn-primary" style="font-size:15px;padding:12px 28px;">${C.submit}</button>
            </div>
          </form>
        </div>
      </div>`;

    res.send(renderPage(`${C.formTitle} — ${qNum}`, content));
  } catch (error: any) {
    console.error(error);
    res.status(500).send(renderPage('Error', `<div class="alert alert-danger">Error: ${escapeHtml(error.message)}</div>`));
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ROUTE: POST /quote/:token/customer-info
// ═══════════════════════════════════════════════════════════════════════════
app.post('/quote/:token/customer-info', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const { customerName, customerPhone, customerEmail, chineseDeliveryAddress, howDidYouKnowUs } = req.body;

    const records = await tableQuotes.select({ filterByFormula: `{Public Token} = '${token}'` }).firstPage();
    if (records.length === 0) return res.status(404).send(renderPage('Not Found', '<div class="alert alert-danger">Quote not found.</div>'));

    const record = records[0];
    const isEnglish = isEnglishLanguage(record.fields['Quote Language']);
    const currentStatus = record.fields['Status'] as string;
    if (currentStatus === 'Mark as Paid') {
      return res.status(400).send(renderPage('Error', '<div class="alert alert-danger">This quote has already been converted.</div>'));
    }

    // Save customer info back to Quote
    await tableQuotes.update([{
      id: record.id,
      fields: {
        'Customer Name': customerName,
        'Customer Phone': customerPhone,
        'Customer Email': customerEmail,
        'Chinese Delivery Address': chineseDeliveryAddress,
        'How Did You Know Us': howDidYouKnowUs || '',
        'Customer Submitted At': new Date().toISOString(),
        'Status': 'Ready to Convert',
      } as FieldSet
    }]);

    // Map howDidYouKnowUs to valid singleSelect options for Customers table
    const howKnowUsMapping: Record<string, string> = {
      '朋友介紹': '朋友介紹',
      'Facebook': 'Facebook',
      'IG': 'IG',
      '網站搜尋 Google': '網站搜尋 Google',
    };
    const howKnowUsValue = howKnowUsMapping[howDidYouKnowUs] || undefined;

    // Upsert customer master. If the Quote is already linked to a Customer,
    // update that exact Customer first. Otherwise use normalized phone matching.
    const linkedCustomerId = getLinkedRecordId(record.fields['Customer']);
    const existingCustomer = linkedCustomerId
      ? await tableCustomers.find(linkedCustomerId)
      : await findCustomerByPhone(customerPhone);

    let customerRecordId = '';
    if (existingCustomer) {
      customerRecordId = existingCustomer.id;
      await tableCustomers.update([{
        id: existingCustomer.id,
        fields: {
          'Customer Name': customerName,
          'Phone': customerPhone,
          'Email': customerEmail,
          'Address': chineseDeliveryAddress,
          ...(howKnowUsValue ? { 'How did you know us?': howKnowUsValue } : {}),
        } as FieldSet
      }]);
    } else {
      const newCustomerId = await getNextCustomerId();
      const newCustomer = await tableCustomers.create([{
        fields: {
          'Customer ID': newCustomerId,
          'Customer Name': customerName,
          'Phone': customerPhone,
          'Email': customerEmail,
          'Address': chineseDeliveryAddress,
          ...(howKnowUsValue ? { 'How did you know us?': howKnowUsValue } : {}),
        } as FieldSet
      }]);
      customerRecordId = newCustomer[0].id;
    }

    await tableQuotes.update([{
      id: record.id,
      fields: {
        'Customer': [customerRecordId],
      } as FieldSet
    }]);

    res.send(renderPage(isEnglish ? 'Information Received' : '已收到資料', `
      <div class="doc-card">
        ${docHeader(isEnglish ? 'Thank You' : '多謝您的確認', isEnglish ? 'Information received' : 'Thank You', isEnglish)}
        <div class="doc-body">
          <div class="alert alert-success" style="font-size:15px;line-height:1.8;">
            ${isEnglish
              ? `<strong>Thank you, ${escapeHtml(customerName)}!</strong><br>We have received your information.<br>We will prepare the invoice and send it to you by WhatsApp or email. Please check the payment details when received.<br><br>Please feel free to contact us if you have any questions.`
              : `<strong>多謝 ${escapeHtml(customerName)}！</strong><br>我們已經收到您的資料。<br>稍後我們會為您準備 Invoice（發票），並透過 WhatsApp 或電郵發送給您，請留意付款詳情。<br><br>如有任何查詢，歡迎隨時聯絡我們。`}
          </div>
          <div style="margin-top:16px;padding:16px;background:#f9fafb;border-radius:6px;font-size:14px;color:#374151;">
            <strong>${isEnglish ? 'Contact:' : '聯絡方式：'}</strong><br>
            📞 ${isEnglish ? 'WhatsApp / Phone' : 'WhatsApp / 電話'}：${COMPANY.phone}<br>
            📧 ${isEnglish ? 'Email' : '電郵'}：${COMPANY.email}
          </div>
        </div>
      </div>
    `));
  } catch (error: any) {
    console.error(error);
    res.status(500).send(renderPage('Error', `<div class="alert alert-danger">Error: ${escapeHtml(error.message)}</div>`));
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ROUTE: POST /admin/quote/:token/convert
// ═══════════════════════════════════════════════════════════════════════════
app.post('/admin/quote/:token/convert', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const records = await tableQuotes.select({ filterByFormula: `{Public Token} = '${token}'` }).firstPage();
    if (records.length === 0) return res.status(404).send(renderPage('Not Found', '<div class="alert alert-danger">Quote not found.</div>'));

    const quote = records[0];
    const qf = quote.fields;

    // Use submitted customer phone first; fall back to quote phone
    const submittedPhone = (qf['Customer Phone'] as string) || '';
    const quotePhone = (qf['Phone'] as string) || '';
    const lookupPhone = submittedPhone || quotePhone;
    if (!lookupPhone) {
      return res.status(400).send(renderPage('Error', '<div class="alert alert-danger">Quote has no customer phone number. Please ask customer to fill in the form first.</div><a href="/quotes" class="btn btn-secondary" style="margin-top:10px;">Back</a>'));
    }

    // A. Customers — use linked Customer first, then normalized phone matching.
    let customerRecordId: string;
    const submittedName = (qf['Customer Name'] as string) || (qf['Contact Name'] as string) || '';
    const submittedEmail = (qf['Customer Email'] as string) || '';
    const submittedAddress = (qf['Chinese Delivery Address'] as string) || '';
    const linkedCustomerId = getLinkedRecordId(qf['Customer']);

    let existingCustomer: any = null;
    if (linkedCustomerId) {
      try {
        existingCustomer = await tableCustomers.find(linkedCustomerId);
      } catch {
        existingCustomer = null;
      }
    }
    if (!existingCustomer) {
      existingCustomer = await findCustomerByPhone(lookupPhone);
    }

    if (existingCustomer) {
      customerRecordId = existingCustomer.id;
      await tableCustomers.update([{
        id: existingCustomer.id,
        fields: {
          'Customer Name': submittedName,
          'Phone': lookupPhone,
          'Email': submittedEmail,
          'Address': submittedAddress,
        } as FieldSet
      }]);
    } else {
      const newCustomerId = await getNextCustomerId();
      const newCustomer = await tableCustomers.create([{
        fields: {
          'Customer ID': newCustomerId,
          'Customer Name': submittedName,
          'Phone': lookupPhone,
          'Email': submittedEmail,
          'Address': submittedAddress,
        } as FieldSet
      }]);
      customerRecordId = newCustomer[0].id;
    }

    // B. Order_2026
    const internalOrderNo = await getNextNumber(tableOrders, 'Internal Order No', 'ORD');
    const invoiceNumber = await getNextNumber(tableOrders, 'Invoice Number', 'INV');
    const invoicePublicToken = generateToken();
    const invoiceDate = getHongKongDate();
    const internalOrderCode = await getNextInternalOrderCode(invoiceDate);
    const { orderMonthSelect, itemMonthSelect } = getOrderMonthDetails(invoiceDate);

    const orderFields: FieldSet = {
      'Internal Order No': internalOrderNo,
      'Internal 1 Order No': internalOrderCode,
      'Invoice Number': invoiceNumber,
      'Order Month & Year': orderMonthSelect,
      'Invoice Public Token': invoicePublicToken,
      'Customer': [customerRecordId],
      'Product Amount': qf['Sub Total'],
      'Discount': qf['Discount'],
      'Promotion / Offer Type': qf['Promotion / Offer Type'] || undefined,
      'Discount Type': qf['Discount Type'] || '無折扣',
      'Discount Multiplier': (qf['Discount Multiplier'] as number | undefined) || undefined,
      'Discount Amount HKD': qf['Discount Amount HKD'] || 0,
      'Discount Reason': qf['Discount Reason'] || undefined,
      'Discount Value HKD': qf['Discount Value HKD'] || Math.max(0, Number(qf['Sub Total'] || 0) - Number(qf['Total'] || 0)),
      'Discount Display Text': qf['Discount Display Text'] || '',
      'Delivery Charge Mode': qf['Delivery Charge Mode'] || '',
      'Delivery Offer Reason': qf['Delivery Offer Reason'] || undefined,
      'Delivery Display Text': qf['Delivery Display Text'] || '',
      ...(qf['Quote Source / Channel'] ? { 'Order Source / Channel': qf['Quote Source / Channel'] } : {}),
      ...(qf['Campaign / Source Detail'] ? { 'Campaign / Source Detail': qf['Campaign / Source Detail'] } : {}),
      ...(Array.isArray(qf['Inquiry']) && qf['Inquiry'].length ? { 'Inquiry': qf['Inquiry'] } : {}),
      ...(Array.isArray(qf['Performance Month']) && qf['Performance Month'].length ? { 'Performance Month': qf['Performance Month'] } : {}),
      // 'Final Amount' is computed — do NOT write
      // 'Description' is computed — do NOT write
      'Payment Method': qf['Payment Method'] || '',
      'Invoice Date': invoiceDate,
      'Notes': qf['Notes'] || '',
      'Terms and Conditions': qf['Terms and Conditions'] || '',
      'Source Quote Ref': (qf['Quote Number'] as string) || '',
    };
    const newOrder = await tableOrders.create([{ fields: orderFields }]);
    const orderRecordId = newOrder[0].id;

    // V13: When a Quote converts to Invoice, mark the linked Inquiry as Converted and link the Order.
    try {
      const linkedInquiryId = getLinkedRecordId(qf['Inquiry']);
      if (linkedInquiryId) {
        await tableInquiries.update([{
          id: linkedInquiryId,
          fields: {
            'Inquiry Status': 'Converted',
            'Order': [orderRecordId],
          } as FieldSet,
        }]);
      }
    } catch (inquiryUpdateError) {
      console.error('V13 inquiry conversion update failed:', inquiryUpdateError);
      // Do not block invoice conversion if Inquiry update fails.
    }

    // C. Order Items
    let items: any[] = [];
    items = parseQuoteItems(qf['Quote Items JSON']);

    if (items.length > 0) {
      const orderItemsPayload = items.map((item: any, itemIndex: number) => {
        // Accessories: Airtable Multiple Select requires an array of strings
        const rawAccArray: string[] = Array.isArray(item.accessories)
          ? item.accessories.filter(Boolean)
          : (item.accessories ? String(item.accessories).split(',').map((s: string) => s.trim()).filter(Boolean) : []);
        const accArray: string[] = Array.from(new Set(rawAccArray.map((s: string) => s.replace(/\s*x\d+$/i, '').trim()).filter(Boolean)));

        const safeStr = (v: any) => (v != null && v !== '') ? String(v) : '';
        const itemNo = `${internalOrderCode}-${itemSuffixFromIndex(itemIndex)}`;
        const fields: FieldSet = {
          'Item No': itemNo,
          'Month': itemMonthSelect,
          'Order': [orderRecordId],
          'Description': [safeStr(item.itemType), safeStr(item.forWhat), safeStr(item.description)].filter(Boolean).join(' / '),
          'QTY': item.qty || 1,
          'Product Amount': item.amount || 0,
          'Quoted China Freight HKD': Number(item.freight) || 0,
          'Quoted Local Delivery HKD': Number(item.hongKongDelivery ?? item.deliveryCostReserve) || 0,
          'Quoted Profit HKD': Number(item.profit) || 0,
          'Estimated Package Units': Number(item.estimatedPackageUnits) || 0,
          'Local Delivery Override': Boolean(item.localDeliveryOverride),
          'Local Delivery Notes': safeStr(item.localDeliveryNotes),
          'Item Type': safeStr(item.itemType),
          'For What': safeStr(item.forWhat),
          'Inter L': safeStr(item.interL),
          'Inter D': safeStr(item.interD),
          'Inter H': safeStr(item.interH),
          'No. of Levels': item.noOfLevels || null,
          'Level Heights': safeStr(item.levelHeights),
        };
        if (accArray.length > 0) fields['Accessories'] = accArray;
        if (item.outerL) fields['Outer L'] = safeStr(item.outerL);
        if (item.outerD) fields['Outer D'] = safeStr(item.outerD);
        if (item.outerH) fields['Outer H'] = safeStr(item.outerH);
        return { fields };
      });
      await tableOrderItems.create(orderItemsPayload);
    }

    // D. Update Quote
    await tableQuotes.update([{
      id: quote.id,
      fields: {
        'Converted Order No': internalOrderNo,
        'Converted Invoice No': invoiceNumber,
        'Order Ref': orderRecordId,
        'Customer': [customerRecordId],
        'Converted At': new Date().toISOString(),
        'Invoice Public Token': invoicePublicToken,
        'Status': 'Mark as Paid',
      }
    }]);

    res.redirect(`/quotes?converted=${invoiceNumber}`);
  } catch (error: any) {
    console.error(error);
    res.status(500).send(renderPage('Error', `<div class="alert alert-danger">Error converting quote: ${escapeHtml(error.message)}</div><a href="/quotes" class="btn btn-secondary" style="margin-top:10px;">Back</a>`));
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ROUTE: GET /invoice/:token
// ═══════════════════════════════════════════════════════════════════════════
app.get('/invoice/:token', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const records = await tableOrders.select({ filterByFormula: `{Invoice Public Token} = '${token}'` }).firstPage();
    if (records.length === 0) return res.status(404).send(renderPage('Not Found', '<div class="alert alert-danger">Invoice not found.</div>'));

    const order = records[0];
    const of = order.fields;
    const status = (of['Status'] as string) || 'Unpaid';
    const orderLanguage = await getOrderLanguageFromSourceQuote(of);
    const isEnglish = orderLanguage === 'English';
    const I = {
      invoiceTitle: isEnglish ? 'Invoice' : '發票',
      invoiceSubtitle: isEnglish ? '' : 'Invoice',
      invoiceNumber: isEnglish ? 'Invoice Number' : '發票編號',
      invoiceDate: isEnglish ? 'Invoice Date' : '發票日期',
      dueDate: isEnglish ? 'Due Date' : '付款日期',
      customerInfo: isEnglish ? 'Customer Information' : '客戶資料',
      name: isEnglish ? 'Name' : '姓名',
      phone: isEnglish ? 'Phone' : '電話',
      email: isEnglish ? 'Email' : '電郵',
      address: isEnglish ? 'Address' : '地址',
      items: isEnglish ? 'Items' : '產品項目',
      itemType: isEnglish ? 'Item Type' : '產品類型',
      forWhat: isEnglish ? 'For What' : '擺放物品',
      interL: isEnglish ? 'Internal L' : '內長',
      interD: isEnglish ? 'Internal D' : '內深',
      interH: isEnglish ? 'Internal H' : '內高',
      outerL: isEnglish ? 'Outer L' : '外長',
      outerD: isEnglish ? 'Outer D' : '外深',
      outerH: isEnglish ? 'Outer H' : '外高',
      levels: isEnglish ? 'Levels' : '層數',
      levelHeights: isEnglish ? 'Level Heights' : '每層高度',
      accessories: isEnglish ? 'Accessories' : '配件',
      description: isEnglish ? 'Description' : '描述',
      qty: isEnglish ? 'QTY' : '數量',
      amount: isEnglish ? 'Amount' : '金額',
      subtotal: isEnglish ? 'Subtotal' : '小計',
      delivery: isEnglish ? 'Delivery Arrangement' : '送貨安排',
      total: isEnglish ? 'Total' : '總額',
      balanceDue: isEnglish ? 'Balance Due' : '尚欠金額',
      selectedPayment: isEnglish ? 'Selected Payment Method' : '已選付款方式',
      notes: isEnglish ? 'Notes' : '備註',
      paymentTerms: isEnglish ? 'Payment Terms' : '付款條款',
      thankYou: isEnglish ? 'Thank you for your business!' : '多謝您的訂購！',
      noItems: isEnglish ? 'No items' : '沒有產品項目'
    };

    // Customer info via Customer Ref
    let customer: Record<string, unknown> = {};
    const customerRef = (of['Customer'] as string[] | undefined) || (of['Customer Ref'] as string[] | undefined);
    if (customerRef && customerRef.length > 0) {
      const cr = await tableCustomers.find(customerRef[0]);
      if (cr) customer = cr.fields as Record<string, unknown>;
    }

    // Items — read from Source Quote's Quote Items JSON (same as Quote view)
    let items: any[] = [];
    let sourceQuoteFields: FieldSet | null = null;
    const sourceQuoteRef = (of['Source Quote Ref'] as string) || '';
    if (sourceQuoteRef) {
      const quoteRecords = await tableQuotes.select({ filterByFormula: `{Quote Number} = '${sourceQuoteRef}'` }).firstPage();
      if (quoteRecords.length > 0) {
        sourceQuoteFields = quoteRecords[0].fields;
        items = parseQuoteItems(sourceQuoteFields['Quote Items JSON']);
      }
    }

    const itemRows = items.length === 0
      ? `<tr><td colspan="15" style="text-align:center;color:#9ca3af;">${I.noItems}</td></tr>`
      : items.map((item: any, idx: number) => {
          return `<tr>
            <td>${idx + 1}</td>
            <td>${escapeHtml(item.itemType) || '-'}</td>
            <td>${escapeHtml(item.forWhat) || '-'}</td>
            <td style="text-align:center;">${item.interL || '-'}</td>
            <td style="text-align:center;">${item.interD || '-'}</td>
            <td style="text-align:center;">${item.interH || '-'}</td>
            <td style="text-align:center;">${item.outerL || '-'}</td>
            <td style="text-align:center;">${item.outerD || '-'}</td>
            <td style="text-align:center;">${item.outerH || '-'}</td>
            <td style="text-align:center;">${item.noOfLevels || '-'}</td>
            <td>${escapeHtml(item.levelHeights) || '-'}</td>
            <td>${renderAccTags(item.accessories)}</td>
            <td>${escapeHtml(item.description) || '-'}</td>
            <td style="text-align:center;">${item.qty || 1}</td>
            <td style="text-align:right;">$${item.amount || 0}</td>
          </tr>`;
        }).join('');

    const subtotal = (of['Product Amount'] as number) || 0;
    const discountRate = (of['Discount'] as number) ?? 1;
    const total =
      (of['Final Amount'] as number) ||
      Math.ceil(subtotal * discountRate);
    const discountAmount = Number(of['Discount Value HKD'] || 0) || Math.max(0, subtotal - total);
    const discountDisplayText = discountAmount > 0 ? buildDisplayDiscountText(of, isEnglish) : '';
    const deliveryDisplayText = buildDisplayDeliveryText(
      of,
      isEnglish,
      sumQuoteLocalDelivery(items),
      sourceQuoteFields?.['Valid Until']
    );
    const balanceDue = status === 'Paid' ? 0 : total;

    const content = `
      <div class="doc-card">
        ${docHeader(I.invoiceTitle, I.invoiceSubtitle, isEnglish)}
        <div class="doc-body">

          <div class="info-grid info-grid-3" style="margin-bottom:16px;">
            <div class="info-block">
              <div class="lbl">${I.invoiceNumber}</div>
              <div class="val">${escapeHtml(of['Invoice Number'] as string)}</div>
            </div>
            <div class="info-block">
              <div class="lbl">${I.invoiceDate}</div>
              <div class="val-sm">${escapeHtml(of['Invoice Date'] as string)}</div>
            </div>
            <div class="info-block">
              <div class="lbl">${I.dueDate}</div>
              <div class="val-sm">${escapeHtml(of['Invoice Date'] as string)}</div>
            </div>
          </div>

          <div class="section">
            <div class="section-title">${I.customerInfo}</div>
            <div class="info-grid info-grid-2">
              <div class="info-block"><div class="lbl">${I.name}</div><div class="val-sm">${escapeHtml(customer['Customer Name'] as string || 'N/A')}</div></div>
              <div class="info-block"><div class="lbl">${I.phone}</div><div class="val-sm">${escapeHtml(customer['Phone'] as string || 'N/A')}</div></div>
              <div class="info-block"><div class="lbl">${I.email}</div><div class="val-sm">${escapeHtml(customer['Email'] as string || 'N/A')}</div></div>
              <div class="info-block"><div class="lbl">${I.address}</div><div class="val-sm">${escapeHtml(customer['Address'] as string || 'N/A')}</div></div>
            </div>
          </div>

          <div class="section">
            <div class="section-title">${I.items}</div>
            <div style="overflow-x:auto;">
              <table class="items-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>${I.itemType}</th>
                    <th>${I.forWhat}</th>
                    <th>${I.interL}</th>
                    <th>${I.interD}</th>
                    <th>${I.interH}</th>
                    <th>${I.outerL}</th>
                    <th>${I.outerD}</th>
                    <th>${I.outerH}</th>
                    <th>${I.levels}</th>
                    <th>${I.levelHeights}</th>
                    <th>${I.accessories}</th>
                    <th>${I.description}</th>
                    <th>${I.qty}</th>
                    <th>${I.amount}</th>
                  </tr>
                </thead>
                <tbody>${itemRows}</tbody>
              </table>
            </div>
          </div>

          <div class="totals-box">
            <div class="row"><span>${I.subtotal}</span><span>$${subtotal.toFixed(2)}</span></div>
            ${discountAmount > 0 ? `<div class="row discount-row"><span>${escapeHtml(discountDisplayText)}</span><span>-$${discountAmount.toFixed(2)}</span></div>` : ''}
            ${deliveryDisplayText ? `<div class="row delivery-row"><span>${I.delivery}</span><span>${nl2br(deliveryDisplayText)}</span></div>` : ''}
            <div class="row total-row"><span>${I.total}</span><span>$${Math.ceil(total)}</span></div>
            <div class="row balance-row" style="color:${status === 'Paid' ? '#10b981' : '#ef4444'};">
              <span>${I.balanceDue}</span><span>$${Math.ceil(balanceDue)}</span>
            </div>
          </div>

          ${of['Payment Method'] ? `<div class="section" style="margin-top:16px;"><div class="section-title">${I.selectedPayment}</div><p style="font-size:13px;">${escapeHtml(of['Payment Method'] as string)}</p></div>` : ''}
          ${renderPaymentMethodHtml(isEnglish)}
          ${of['Notes'] ? `<div class="section" style="margin-top:16px;"><div class="section-title">${I.notes}</div><p style="font-size:13px;">${nl2br(of['Notes'])}</p></div>` : ''}
          <div class="section"><div class="section-title">${I.paymentTerms}</div><p style="font-size:12px;color:#374151;">${nl2br(isEnglish ? DEFAULT_PAYMENT_TERMS_EN : DEFAULT_PAYMENT_TERMS)}</p></div>

          <div class="thank-you">${I.thankYou}</div>
        </div>
      </div>
    `;

    res.send(renderPage(`${isEnglish ? 'Invoice' : '發票'} ${of['Invoice Number']}`, content));
  } catch (error: any) {
    console.error(error);
    res.status(500).send(renderPage('Error', `<div class="alert alert-danger">Error: ${escapeHtml(error.message)}</div>`));
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ROUTE: POST /admin/invoice/:token/mark-paid
// ═══════════════════════════════════════════════════════════════════════════
app.post('/admin/invoice/:token/mark-paid', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const records = await tableOrders.select({ filterByFormula: `{Invoice Public Token} = '${token}'` }).firstPage();
    if (records.length === 0) return res.status(404).send(renderPage('Not Found', '<div class="alert alert-danger">Invoice not found.</div>'));

    const order = records[0];
    if (order.fields['Status'] === 'Paid') {
      return res.status(400).send(renderPage('Error', '<div class="alert alert-danger">Invoice is already paid.</div><a href="/quotes" class="btn btn-secondary" style="margin-top:10px;">Back</a>'));
    }

    const receiptNumber = await getNextNumber(tableOrders, 'Receipt Number', 'RCPT');
    const receiptPublicToken = generateToken();
    const payDate = new Date().toISOString().split('T')[0];

    await tableOrders.update([{
      id: order.id,
      fields: {
        'Pay Date': payDate,
        'Receipt Number': receiptNumber,
        'Receipt Public Token': receiptPublicToken,
        'Status': 'Paid',
      }
    }]);

    res.redirect('/quotes');
  } catch (error: any) {
    console.error(error);
    res.status(500).send(renderPage('Error', `<div class="alert alert-danger">Error marking as paid: ${escapeHtml(error.message)}</div><a href="/quotes" class="btn btn-secondary" style="margin-top:10px;">Back</a>`));
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ROUTE: GET /receipt/:token
// ═══════════════════════════════════════════════════════════════════════════
app.get('/receipt/:token', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;
    const records = await tableOrders.select({ filterByFormula: `{Receipt Public Token} = '${token}'` }).firstPage();
    if (records.length === 0) return res.status(404).send(renderPage('Not Found', '<div class="alert alert-danger">Receipt not found.</div>'));

    const order = records[0];
    const of = order.fields;
    const orderLanguage = await getOrderLanguageFromSourceQuote(of);
    const isEnglish = orderLanguage === 'English';
    const R = {
      receiptTitle: isEnglish ? 'Receipt' : '收據',
      receiptSubtitle: isEnglish ? '' : 'Receipt',
      receiptNumber: isEnglish ? 'Receipt Number' : '收據編號',
      paidDate: isEnglish ? 'Paid Date' : '付款日期',
      relatedInvoice: isEnglish ? 'Related Invoice' : '相關發票',
      customerInfo: isEnglish ? 'Customer Information' : '客戶資料',
      name: isEnglish ? 'Name' : '姓名',
      phone: isEnglish ? 'Phone' : '電話',
      email: isEnglish ? 'Email' : '電郵',
      address: isEnglish ? 'Address' : '地址',
      paymentDetails: isEnglish ? 'Payment Details' : '付款詳情',
      paidInFull: isEnglish ? '${R.paidInFull}' : '已全數付款',
      via: isEnglish ? 'via' : '付款方式：',
      thankYou: isEnglish ? 'Thank you for your payment!' : '多謝您的付款！'
    };

    // Customer info via Customer Ref
    let customer: Record<string, unknown> = {};
    const customerRef = (of['Customer'] as string[] | undefined) || (of['Customer Ref'] as string[] | undefined);
    if (customerRef && customerRef.length > 0) {
      const cr = await tableCustomers.find(customerRef[0]);
      if (cr) customer = cr.fields as Record<string, unknown>;
    }

    const subtotal = (of['Product Amount'] as number) || 0;
    const discountRate = (of['Discount'] as number) ?? 1;
    const total = (of['Final Amount'] as number) || Math.ceil(subtotal * discountRate);

    const content = `
      <div class="doc-card">
        ${docHeader(R.receiptTitle, R.receiptSubtitle, isEnglish)}
        <div class="doc-body">

          <div class="info-grid info-grid-3" style="margin-bottom:16px;">
            <div class="info-block">
              <div class="lbl">${R.receiptNumber}</div>
              <div class="val">${escapeHtml(of['Receipt Number'] as string)}</div>
            </div>
            <div class="info-block">
              <div class="lbl">${R.paidDate}</div>
              <div class="val-sm">${escapeHtml(of['Pay Date'] as string)}</div>
            </div>
            <div class="info-block">
              <div class="lbl">${R.relatedInvoice}</div>
              <div class="val-sm">${escapeHtml(of['Invoice Number'] as string)}</div>
            </div>
          </div>

          <div class="section">
            <div class="section-title">${R.customerInfo}</div>
            <div class="info-grid info-grid-2">
              <div class="info-block"><div class="lbl">${R.name}</div><div class="val-sm">${escapeHtml(customer['Customer Name'] as string || 'N/A')}</div></div>
              <div class="info-block"><div class="lbl">${R.phone}</div><div class="val-sm">${escapeHtml(customer['Phone'] as string || 'N/A')}</div></div>
              <div class="info-block"><div class="lbl">${R.email}</div><div class="val-sm">${escapeHtml(customer['Email'] as string || 'N/A')}</div></div>
              <div class="info-block"><div class="lbl">${R.address}</div><div class="val-sm">${escapeHtml(customer['Address'] as string || 'N/A')}</div></div>
            </div>
          </div>

          <div class="section">
            <div class="section-title">${R.paymentDetails}</div>
            <div style="background:#f0fdf4;border:1px solid #6ee7b7;border-radius:6px;padding:20px;text-align:center;">
              <div style="font-size:13px;color:#065f46;margin-bottom:6px;">${R.paidInFull}</div>
              <div style="font-size:32px;font-weight:700;color:#10b981;">$${Math.ceil(total)}</div>
              ${of['Payment Method'] ? `<div style="margin-top:8px;color:#374151;font-size:14px;">${R.via} ${escapeHtml(of['Payment Method'] as string)}</div>` : ''}
            </div>
          </div>

          <div class="thank-you">${R.thankYou}</div>
        </div>
      </div>
    `;

    res.send(renderPage(`${isEnglish ? 'Receipt' : '收據'} ${of['Receipt Number']}`, content));
  } catch (error: any) {
    console.error(error);
    res.status(500).send(renderPage('Error', `<div class="alert alert-danger">Error: ${escapeHtml(error.message)}</div>`));
  }
});

// ─── Root redirect ───────────────────────────────────────────────────────────
app.get('/', (_req: Request, res: Response) => res.redirect('/quotes'));

// ─── Start server ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`LKS Quote System running on port ${PORT}`);
  console.log(`Public Base URL: ${PUBLIC_BASE_URL}`);
  console.log(`Dashboard: ${PUBLIC_BASE_URL}/quotes`);
});
