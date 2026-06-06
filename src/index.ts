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
5. 訂單確認後將安排生產，一般發貨時間約為45個工作天，長假期可能延長，實際時間視乎訂單情況而定。
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

const DEFAULT_QUOTE_NOTES = `LKS 自家物流🚛「運費到付」
🚛💰運費按貨物重量計算
大部分地區運費相若☺️
🌟偏遠地區除外🌟

🎊 新客戶優惠 🎊
🔽 首次購買即享 85 折
💡 必須 Like Facebook Page 並分享指定 Post 💡

❌❌❌ 不接急單 ❌❌❌

展示盒介紹
🤏🏻 全港少數採用 5MM 高清厚板製作展示盒及展示櫃 🤏🏻
💫 購買任何展示盒或展示櫃，附送趟門或磁石門。💫
➕ 加購優惠 ➕ 如加購背景或刻字，即免費設計及修圖。
💡 獨立燈板 💡 獨立燈板與展示盒分體設計，方便日後升級成疊高展示櫃，燈板亦可靈活轉為上燈或下燈 🚪
💰 新客戶專屬優惠 💰 首次購買即享 85 折優惠 🫶🏻`;

const MATERIAL_NOTE = '本公司全線展示盒及展示櫃均採用 5MM 高清亞加力厚板製作';
const PAYMENT_METHOD_HTML = `
  <div class="section">
    <div class="section-title">Payment Method</div>
    <div class="payment-grid">
      <div class="payment-card">
        <div class="payment-title">銀行轉帳</div>
        <div>銀行：HSBC</div>
        <div>帳號：582 664 967 838</div>
      </div>
      <div class="payment-card">
        <div class="payment-title">轉數快 (FPS)</div>
        <div>電話號碼：68983722</div>
      </div>
      <div class="payment-card">
        <div class="payment-title">PayMe</div>
        <div><a href="https://qr.payme.hsbc.com.hk/2/EjV1LxhqMwvqL6h5MN9n3r" target="_blank" rel="noopener noreferrer">按此即時付款</a></div>
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
const tableOrders = base(process.env.AIRTABLE_TABLE_ORDERS!);
const tableOrderItems = base(process.env.AIRTABLE_TABLE_ORDER_ITEMS!);
const tableQuotes = base(process.env.AIRTABLE_TABLE_QUOTES!);

const escapeHtml = (unsafe: unknown): string =>
  String(unsafe ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const nl2br = (str: unknown): string =>
  escapeHtml(str).replace(/\n/g, '<br>');

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

const searchCustomers = async (query: unknown) => {
  const q = String(query ?? '').trim().toLowerCase();
  const normalizedQ = normalizePhone(q);
  if (!q && !normalizedQ) return [];

  const records = await tableCustomers.select({
    fields: ['Customer Display', 'Customer ID', 'Customer Name', 'Phone', 'Email', 'Address']
  }).all();

  return records
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
    .slice(0, 10)
    .map((record: any) => {
      const f = record.fields;
      return {
        id: record.id,
        display: buildCustomerSearchDisplay(f),
        customerId: getCustomerText(f, 'Customer ID'),
        name: getCustomerText(f, 'Customer Name'),
        phone: getCustomerText(f, 'Phone'),
        email: getCustomerText(f, 'Email'),
        address: getCustomerText(f, 'Address'),
      };
    });
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
const docHeader = (titleZh: string, titleEn: string): string => `
<div class="doc-header">
  <div class="logo">
    <img src="${LOGO_URL}" alt="LKS Logo" crossorigin="anonymous">
  </div>
  <div class="doc-title">
    <h1>${titleZh}</h1>
    <p>${titleEn}</p>
  </div>
  <div class="company-info">
    <strong>${COMPANY.name}</strong><br>
    ${COMPANY.address1}<br>
    ${COMPANY.address2}<br>
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
app.get('/quote/create', (_req: Request, res: Response) => {
  const content = `
    <div class="doc-card">
      ${docHeader('建立報價單', 'Create Quote')}
      <div class="doc-body">
        <form id="quoteForm">

          <div class="section">
            <div class="section-title">Existing Customer 客戶搜尋</div>
            <input type="hidden" name="customerRecordId" id="customerRecordId">
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
            <div style="font-size:12px;color:#6b7280;margin-top:6px;">如屬舊客，先搜尋並選擇客戶；選擇後會自動帶入姓名、電話、Email 及地址，並將 Quote 連結到 Customers。</div>
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
                    <th>運費 ($)</th>
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
                    <td><input type="number" class="f-freight amount-input" step="0.01" style="width:80px"></td>
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
            <div class="section-title">Pricing</div>
            <div class="form-row form-row-3">
              <div class="form-group">
                <label>Subtotal ($)</label>
                <input type="number" name="subtotal" id="subtotal" step="0.01" readonly style="background:#f9fafb;">
              </div>
              <div class="form-group">
                <label>Discount (e.g. 0.9 = 9折, 1 = no discount)</label>
                <input type="number" name="discount" id="discount" step="0.01" min="0" max="1" value="1" oninput="recalcTotal()">
              </div>
              <div class="form-group">
                <label>Total ($)</label>
                <input type="number" name="total" id="total" step="0.01" readonly style="background:#f9fafb;">
              </div>
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

    function calcRowAmount(row) {
      var dims = getDims(row);
      var l = dims.l, d = dims.d, h = dims.h;
      var qty = Math.max(1, parseInt((row.querySelector('.f-qty') || {}).value, 10) || 1);
      var freight = parseNum((row.querySelector('.f-freight') || {}).value);
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

      var unitAmount = ((sizeRmb + accessoryRmb) / RMB_DIVISOR) + hkdAddons + freight + profit;
      var lineAmount = unitAmount * qty;
      var amountInput = row.querySelector('.f-amt');
      if (amountInput) amountInput.value = lineAmount.toFixed(2);
      return lineAmount;
    }

    function bindRowEvents(row) {
      row.querySelectorAll('input, select').forEach(function(el) {
        if (el.classList.contains('f-amt')) return;
        var evt = (el.type === 'checkbox' || el.tagName === 'SELECT') ? 'change' : 'input';
        el.addEventListener(evt, function() {
          updateOuterDimensions(row);
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
        } else {
          el.value = '';
        }
      });
      tbody.appendChild(clone);
      bindRowEvents(clone);
      updateOuterDimensionMode(clone);
      updateOuterDimensions(clone);
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
    function recalcTotal() {
      var sub = parseFloat(document.getElementById('subtotal').value) || 0;
      var disc = parseFloat(document.getElementById('discount').value);
      var d = isNaN(disc) ? 1 : disc;
      document.getElementById('total').value = Math.ceil(sub * d);
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
          profit: (row.querySelector('.f-profit') || {}).value || '0',
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
        return '<button type="button" class="customer-result-row" data-id="' + safe(c.id) + '" style="display:block;width:100%;text-align:left;padding:10px 12px;border:0;border-bottom:1px solid #f3f4f6;background:#fff;cursor:pointer;">'
          + '<div style="font-weight:700;color:#111827;">' + safe(c.display || c.name || c.phone || c.id) + '</div>'
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
      if (idInput) idInput.value = customer.id || '';

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
          + [customer.customerId, customer.name, customer.phone].filter(Boolean).join(' | ')
          + (customer.email ? '<br>Email：' + customer.email : '')
          + (customer.address ? '<br>Address：' + customer.address : '');
      }
    }

    function clearSelectedCustomer() {
      selectedCustomer = null;
      var idInput = document.getElementById('customerRecordId');
      if (idInput) idInput.value = '';
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
      });
      document.getElementById('quoteForm').addEventListener('submit', function(e) {
        e.preventDefault();
        var form = e.target;
        var payload = {
          customerRecordId: (document.getElementById('customerRecordId') || {}).value || '',
          contactName: form.querySelector('[name=contactName]').value,
          phone: form.querySelector('[name=phone]').value,
          contactMethod: form.querySelector('[name=contactMethod]').value,
          contactHandle: form.querySelector('[name=contactHandle]').value,
          subtotal: document.getElementById('subtotal').value,
          discount: document.getElementById('discount').value,
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
      profit: parseFloat(String(item.profit)) || 0,
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
          item.freight ? `運費 $${item.freight}` : '',
          item.profit ? `利潤 $${item.profit}` : '',
          item.amount ? `$${item.amount}` : '',
        ].filter(Boolean);
        return parts.join(' | ');
      })
      .join('\n');
    const subtotal = parseFloat(b.subtotal) || 0;
    const discountRate = parseFloat(b.discount) || 1;
    const total = Math.ceil(parseFloat(b.total) || subtotal * discountRate);

    const quoteNumber = await getNextNumber(tableQuotes, 'Quote Number', 'QT');
    const publicToken = generateToken();
    const quoteDate = new Date().toISOString().split('T')[0];

    let selectedCustomerId = String(b.customerRecordId || '').trim();
    let selectedCustomerFields: FieldSet | null = null;
    if (selectedCustomerId) {
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
        'Valid Until': b.validUntil && b.validUntil.trim() ? b.validUntil.trim() : null,
        'Contact Name': b.contactName,
        'Phone': b.phone,
        'Contact Method': b.contactMethod,
        'Contact Handle / Reference': b.contactHandle || '',
        'Sub Total': subtotal,
        'Discount': discountRate,
        'Total': total,
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

    await tableQuotes.create([{ fields: quoteFields }]);

    const publicLink = `${PUBLIC_BASE_URL}/quote/${publicToken}`;
    const customerInfoLink = `${PUBLIC_BASE_URL}/quote/${publicToken}/customer-info`;

    res.send(renderPage('Quote Created', `
      <div class="doc-card">
        ${docHeader('報價單已建立', 'Quote Created')}
        <div class="doc-body">
          <div class="alert alert-success">Quote created successfully!</div>
          <div class="info-grid info-grid-2" style="margin-bottom:20px;">
            <div class="info-block"><div class="lbl">Quote Number</div><div class="val">${escapeHtml(quoteNumber)}</div></div>
            <div class="info-block"><div class="lbl">Date</div><div class="val">${quoteDate}</div></div>
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

    // Parse items
    let items: any[] = [];
    items = parseQuoteItems(quote['Quote Items JSON']);

    const subtotal = (quote['Sub Total'] as number) || 0;
    const discountRate = (quote['Discount'] as number) ?? 1;
    const total = (quote['Total'] as number) || 0;
    const discountAmount = subtotal - total;

    // Items table rows
    const descriptionSummary = (quote['Description Summary'] as string) || '';

    const itemRows = items.length === 0
      ? (
          descriptionSummary
            ? `<tr>
                <td>1</td>
                <td colspan="14" style="white-space:pre-line;">${nl2br(descriptionSummary)}</td>
              </tr>`
            : '<tr><td colspan="15" style="text-align:center;color:#9ca3af;">No items</td></tr>'
        )
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

    // Contact info block (always shown from Quotes table)
    const contactName = (quote['Contact Name'] as string) || '';
    const contactPhone = (quote['Phone'] as string) || '';
    const contactMethod = (quote['Contact Method'] as string) || '';
    const contactHandle = (quote['Contact Handle / Reference'] as string) || '';

    const contactBlock = `
      <div class="section">
        <div class="section-title">Contact Information</div>
        <div class="info-grid info-grid-2">
          <div class="info-block"><div class="lbl">Contact Name</div><div class="val-sm">${escapeHtml(contactName) || 'N/A'}</div></div>
          <div class="info-block"><div class="lbl">Phone</div><div class="val-sm">${escapeHtml(contactPhone) || 'N/A'}</div></div>
          <div class="info-block"><div class="lbl">Contact Method</div><div class="val-sm">${escapeHtml(contactMethod) || 'N/A'}</div></div>
          <div class="info-block"><div class="lbl">Contact Handle / Reference</div><div class="val-sm">${escapeHtml(contactHandle) || 'N/A'}</div></div>
        </div>
      </div>`;

    const content = `
      <div class="doc-card">
        ${docHeader('報價單', 'Quotation')}
        <div class="doc-body">

          <div class="info-grid info-grid-3" style="margin-bottom:16px;">
            <div class="info-block">
              <div class="lbl">Quote Number</div>
              <div class="val">${escapeHtml(quote['Quote Number'] as string)}</div>
            </div>
            <div class="info-block">
              <div class="lbl">Date</div>
              <div class="val-sm">${escapeHtml(quote['Quote Date'] as string)}</div>
            </div>
            ${quote['Valid Until'] ? `<div class="info-block"><div class="lbl">Valid Until</div><div class="val-sm">${escapeHtml(quote['Valid Until'] as string)}</div></div>` : '<div></div>'}
          </div>

          ${contactBlock}

          <div class="section">
            <div class="section-title">Items</div>
            <div style="overflow-x:auto;">
              <div class="material-banner">${escapeHtml(MATERIAL_NOTE)}</div><table class="items-table">
                <thead>
                  <tr>
                    <th>#</th>
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
                    <th>Amount</th>
                  </tr>
                </thead>
                <tbody>${itemRows}</tbody>
              </table>
            </div>
          </div>

          <div class="totals-box">
            <div class="row"><span>Subtotal</span><span>$${subtotal.toFixed(2)}</span></div>
            ${discountAmount > 0 ? `<div class="row"><span>Discount</span><span style="color:#ef4444;">-$${discountAmount.toFixed(2)}</span></div>` : ''}
            <div class="row total-row"><span>Total</span><span>$${total}</span></div>
          </div>

          ${quote['Notes'] ? `<div class="section" style="margin-top:16px;"><div class="section-title">Notes</div><p style="font-size:14px;">${nl2br(quote['Notes'])}</p></div>` : ''}
          ${quote['Terms and Conditions'] ? `<div class="section"><div class="section-title">Terms and Conditions</div><p style="font-size:13px;color:#374151;">${nl2br(quote['Terms and Conditions'])}</p></div>` : ''}

          <div class="thank-you">Thank you!</div>
        </div>
      </div>
    `;

    res.send(renderPage(`Quote ${quote['Quote Number']}`, content));
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
          ${docHeader('客戶資料', 'Customer Information')}
          <div class="doc-body">
            <div class="alert alert-info">Quote ${qNum} — Customer info has been submitted.</div>
            <div class="info-grid info-grid-2">
              <div class="info-block"><div class="lbl">Name</div><div class="val-sm">${custName}</div></div>
              <div class="info-block"><div class="lbl">Phone</div><div class="val-sm">${custPhone}</div></div>
              <div class="info-block"><div class="lbl">Email</div><div class="val-sm">${custEmail}</div></div>
              <div class="info-block"><div class="lbl">Delivery Address</div><div class="val-sm">${custAddr}</div></div>
              <div class="info-block"><div class="lbl">Payment Method</div><div class="val-sm">${payMethod}</div></div>
              <div class="info-block"><div class="lbl">How Did You Know Us</div><div class="val-sm">${howKnow}</div></div>
            </div>
            <div style="margin-top:20px;display:flex;gap:10px;">
              <a href="/quotes" class="btn btn-secondary">Back to Dashboard</a>
              <a href="/quote/${token}" class="btn btn-outline" target="_blank">View Quote</a>
            </div>
          </div>
        </div>`;
      return res.send(renderPage(`Customer Info — ${qNum}`, content));
    }

    // Show form for Draft / Pending Customer Info
    const prefillName = escapeHtml((quote['Customer Name'] as string) || '');
    const prefillPhone = escapeHtml((quote['Customer Phone'] as string) || (quote['Phone'] as string) || '');
    const prefillEmail = escapeHtml((quote['Customer Email'] as string) || '');
    const prefillAddr = escapeHtml((quote['Chinese Delivery Address'] as string) || '');

    const content = `
      <div class="doc-card">
        ${docHeader('填寫資料', '請填寫以下資料以便後續安排')}
        <div class="doc-body">
          <div class="info-grid info-grid-2" style="margin-bottom:16px;">
            <div class="info-block">
              <div class="lbl">製作及發貨安排</div>
              <div class="val-sm">由於訂單數量持續增加，<br>一般需約 <strong>45 個工作天內發貨</strong> ☺️<br><br>如遇長假期，<br>需再加約 <strong>10–15 個工作天</strong> 🙏🏻<br><br>如完成製作，我哋會盡快安排發貨。<br><br>❗️<strong>不接急單</strong>❗️</div>
            </div>
            <div class="info-block">
              <div class="lbl">安裝須知</div>
              <div class="val-sm">每個展示盒及樓梯均需自行安裝，<br>安裝方式簡單易明，一般情況下 <strong>不需要使用大力</strong>，亦 <strong>不需要使用膠水</strong>，之後如有需要亦可自行拆卸☺️<br><br>🌟 如選用 <strong>開門式設計</strong>，則需要使用膠水固定。<br><br>送貨時亦會附上 <strong>電子版安裝說明書</strong> 😎<br><br>使用 <strong>LKS 車隊送貨</strong>，可享 <strong>三天內包補板</strong> 安排。<br>🌟 <strong>人為損壞除外</strong> 🌟</div>
            </div>
          </div>

          <div class="alert alert-info">
            您正在確認 <strong>報價單 ${qNum}</strong> 的訂單。
            請填寫以下資料以便後續安排。
          </div>

          <form action="/quote/${token}/customer-info" method="POST">
            <div class="section">
              <div class="section-title">Your Information</div>
              <div class="form-row form-row-2">
                <div class="form-group">
                  <label>Full Name *</label>
                  <input type="text" name="customerName" value="${prefillName}" required>
                </div>
                <div class="form-group">
                  <label>Phone *</label>
                  <input type="text" name="customerPhone" value="${prefillPhone}" required>
                </div>
              </div>
              <div class="form-group">
                <label>Email *</label>
                <input type="email" name="customerEmail" value="${prefillEmail}" required>
              </div>
              <div class="form-group">
                <label>Chinese Delivery Address *</label>
                <textarea name="chineseDeliveryAddress" rows="3" required>${prefillAddr}</textarea>
              </div>
              <div class="form-group">
                <label>How did you know us? (Optional)</label>
                <select name="howDidYouKnowUs">
                  <option value="">-- Select --</option>
                  <option value="朋友介紹">朋友介紹</option>
                  <option value="Facebook">Facebook</option>
                  <option value="IG">IG</option>
                  <option value="網站搜尋 Google">網站搜尋 Google</option>
                </select>
              </div>
            </div>

            <div class="privacy-notice">
              閣下所提供的個人資料僅作訂單跟進、送貨安排及客戶聯絡之用途，所有資料將予以保密，並不會向第三方公開或作其他未經授權之用途。
            </div>

            <div style="margin-top:20px;text-align:right;">
              <button type="submit" class="btn btn-primary" style="font-size:15px;padding:12px 28px;">Submit &amp; Confirm Order</button>
            </div>
          </form>
        </div>
      </div>`;

    res.send(renderPage(`填寫資料 — ${qNum}`, content));
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
      const newCustomer = await tableCustomers.create([{
        fields: {
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

    res.send(renderPage('已收到資料', `
      <div class="doc-card">
        ${docHeader('多謝您的確認', 'Thank You')}
        <div class="doc-body">
          <div class="alert alert-success" style="font-size:15px;line-height:1.8;">
            <strong>多謝 ${escapeHtml(customerName)}！</strong><br>
            我們已經收到您的資料。<br>
            稍後我們會為您準備 Invoice（發票），並透過 WhatsApp 或電郵發送給您，請留意付款詳情。<br><br>
            如有任何查詢，歡迎隨時聯絡我們。
          </div>
          <div style="margin-top:16px;padding:16px;background:#f9fafb;border-radius:6px;font-size:14px;color:#374151;">
            <strong>聯絡方式：</strong><br>
            📞 WhatsApp / 電話：${COMPANY.phone}<br>
            📧 電郵：${COMPANY.email}
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
      const newCustomer = await tableCustomers.create([{
        fields: {
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
    const invoiceDate = new Date().toISOString().split('T')[0];

    const orderFields: FieldSet = {
      'Internal Order No': internalOrderNo,
      'Invoice Number': invoiceNumber,
      'Invoice Public Token': invoicePublicToken,
      'Customer': [customerRecordId],
      'Product Amount': qf['Sub Total'],
      'Discount': qf['Discount'],
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

    // C. Order Items
    let items: any[] = [];
    items = parseQuoteItems(qf['Quote Items JSON']);

    if (items.length > 0) {
      const orderItemsPayload = items.map((item: any) => {
        // Accessories: Airtable Multiple Select requires an array of strings
        const rawAccArray: string[] = Array.isArray(item.accessories)
          ? item.accessories.filter(Boolean)
          : (item.accessories ? String(item.accessories).split(',').map((s: string) => s.trim()).filter(Boolean) : []);
        const accArray: string[] = Array.from(new Set(rawAccArray.map((s: string) => s.replace(/\s*x\d+$/i, '').trim()).filter(Boolean)));

        const safeStr = (v: any) => (v != null && v !== '') ? String(v) : '';
        const fields: FieldSet = {
          'Order': [orderRecordId],
          'Description': [safeStr(item.itemType), safeStr(item.forWhat), safeStr(item.description)].filter(Boolean).join(' / '),
          'QTY': item.qty || 1,
          'Product Amount': item.amount || 0,
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

    // Customer info via Customer Ref
    let customer: Record<string, unknown> = {};
    const customerRef = (of['Customer'] as string[] | undefined) || (of['Customer Ref'] as string[] | undefined);
    if (customerRef && customerRef.length > 0) {
      const cr = await tableCustomers.find(customerRef[0]);
      if (cr) customer = cr.fields as Record<string, unknown>;
    }

    // Items — read from Source Quote's Quote Items JSON (same as Quote view)
    let items: any[] = [];
    const sourceQuoteRef = (of['Source Quote Ref'] as string) || '';
    if (sourceQuoteRef) {
      const quoteRecords = await tableQuotes.select({ filterByFormula: `{Quote Number} = '${sourceQuoteRef}'` }).firstPage();
      if (quoteRecords.length > 0) {
        items = parseQuoteItems(quoteRecords[0].fields['Quote Items JSON']);
      }
    }

    const itemRows = items.length === 0
      ? '<tr><td colspan="15" style="text-align:center;color:#9ca3af;">No items</td></tr>'
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
    const discountAmount = subtotal - total;
    const balanceDue = status === 'Paid' ? 0 : total;

    const content = `
      <div class="doc-card">
        ${docHeader('發票', 'Invoice')}
        <div class="doc-body">

          <div class="info-grid info-grid-3" style="margin-bottom:16px;">
            <div class="info-block">
              <div class="lbl">Invoice Number</div>
              <div class="val">${escapeHtml(of['Invoice Number'] as string)}</div>
            </div>
            <div class="info-block">
              <div class="lbl">Invoice Date</div>
              <div class="val-sm">${escapeHtml(of['Invoice Date'] as string)}</div>
            </div>
            <div class="info-block">
              <div class="lbl">Due Date</div>
              <div class="val-sm">${escapeHtml(of['Invoice Date'] as string)}</div>
            </div>
          </div>

          <div class="section">
            <div class="section-title">Customer Information</div>
            <div class="info-grid info-grid-2">
              <div class="info-block"><div class="lbl">Name</div><div class="val-sm">${escapeHtml(customer['Customer Name'] as string || 'N/A')}</div></div>
              <div class="info-block"><div class="lbl">Phone</div><div class="val-sm">${escapeHtml(customer['Phone'] as string || 'N/A')}</div></div>
              <div class="info-block"><div class="lbl">Email</div><div class="val-sm">${escapeHtml(customer['Email'] as string || 'N/A')}</div></div>
              <div class="info-block"><div class="lbl">Address</div><div class="val-sm">${escapeHtml(customer['Address'] as string || 'N/A')}</div></div>
            </div>
          </div>

          <div class="section">
            <div class="section-title">Items</div>
            <div style="overflow-x:auto;">
              <table class="items-table">
                <thead>
                  <tr>
                    <th>#</th>
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
                    <th>Amount</th>
                  </tr>
                </thead>
                <tbody>${itemRows}</tbody>
              </table>
            </div>
          </div>

          <div class="totals-box">
            <div class="row"><span>Subtotal</span><span>$${subtotal.toFixed(2)}</span></div>
            ${discountAmount > 0 ? `<div class="row"><span>Discount</span><span style="color:#ef4444;">-$${discountAmount.toFixed(2)}</span></div>` : ''}
            <div class="row total-row"><span>Total</span><span>$${Math.ceil(total)}</span></div>
            <div class="row balance-row" style="color:${status === 'Paid' ? '#10b981' : '#ef4444'};">
              <span>Balance Due</span><span>$${Math.ceil(balanceDue)}</span>
            </div>
          </div>

          ${of['Payment Method'] ? `<div class="section" style="margin-top:16px;"><div class="section-title">Selected Payment Method</div><p style="font-size:13px;">${escapeHtml(of['Payment Method'] as string)}</p></div>` : ''}
          ${PAYMENT_METHOD_HTML}
          ${of['Notes'] ? `<div class="section" style="margin-top:16px;"><div class="section-title">Notes</div><p style="font-size:13px;">${nl2br(of['Notes'])}</p></div>` : ''}
          <div class="section"><div class="section-title">Payment Terms</div><p style="font-size:12px;color:#374151;">${nl2br(DEFAULT_PAYMENT_TERMS)}</p></div>

          <div class="thank-you">Thank you for your business!</div>
        </div>
      </div>
    `;

    res.send(renderPage(`Invoice ${of['Invoice Number']}`, content));
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
        ${docHeader('收據', 'Receipt')}
        <div class="doc-body">

          <div class="info-grid info-grid-3" style="margin-bottom:16px;">
            <div class="info-block">
              <div class="lbl">Receipt Number</div>
              <div class="val">${escapeHtml(of['Receipt Number'] as string)}</div>
            </div>
            <div class="info-block">
              <div class="lbl">Paid Date</div>
              <div class="val-sm">${escapeHtml(of['Pay Date'] as string)}</div>
            </div>
            <div class="info-block">
              <div class="lbl">Related Invoice</div>
              <div class="val-sm">${escapeHtml(of['Invoice Number'] as string)}</div>
            </div>
          </div>

          <div class="section">
            <div class="section-title">Customer Information</div>
            <div class="info-grid info-grid-2">
              <div class="info-block"><div class="lbl">Name</div><div class="val-sm">${escapeHtml(customer['Customer Name'] as string || 'N/A')}</div></div>
              <div class="info-block"><div class="lbl">Phone</div><div class="val-sm">${escapeHtml(customer['Phone'] as string || 'N/A')}</div></div>
              <div class="info-block"><div class="lbl">Email</div><div class="val-sm">${escapeHtml(customer['Email'] as string || 'N/A')}</div></div>
              <div class="info-block"><div class="lbl">Address</div><div class="val-sm">${escapeHtml(customer['Address'] as string || 'N/A')}</div></div>
            </div>
          </div>

          <div class="section">
            <div class="section-title">Payment Details</div>
            <div style="background:#f0fdf4;border:1px solid #6ee7b7;border-radius:6px;padding:20px;text-align:center;">
              <div style="font-size:13px;color:#065f46;margin-bottom:6px;">PAID IN FULL</div>
              <div style="font-size:32px;font-weight:700;color:#10b981;">$${Math.ceil(total)}</div>
              ${of['Payment Method'] ? `<div style="margin-top:8px;color:#374151;font-size:14px;">via ${escapeHtml(of['Payment Method'] as string)}</div>` : ''}
            </div>
          </div>

          <div class="thank-you">Thank you for your payment!</div>
        </div>
      </div>
    `;

    res.send(renderPage(`Receipt ${of['Receipt Number']}`, content));
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
