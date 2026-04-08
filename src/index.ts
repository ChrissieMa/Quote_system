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
};


const DEFAULT_TERMS = `1. 由送貨起計，三天內包補板，過左三天後才發現有爆板請再購買壞板。
2. 如發現強行安裝而弄花或損壞，恕不會補發！
3. 如客戶要求LKS司機在收貨地址以外地方收貨，均不會為損壞板件補發。
4. 司機大約會在兩天內聯絡，請耐心等待司機聯絡相約送貨時間。
5. LKS Display Box 保留最終決定權。`;

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
    ${COMPANY.email}
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
      records = records.filter(r => {
        const qn = ((r.fields['Quote Number'] as string) || '').toLowerCase();
        const cn = ((r.fields['Customer Name'] as string) || '').toLowerCase();
        const ph = ((r.fields['Customer Phone'] as string) || '').toLowerCase();
        const contact = ((r.fields['Contact Name'] as string) || '').toLowerCase();
        return qn.includes(search) || cn.includes(search) || ph.includes(search) || contact.includes(search);
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
          const receiptToken = f['Receipt Public Token'] as string | undefined;

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
        <form id="quoteForm" action="/quote/create" method="POST">

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
                    <th>Amount ($)</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody id="itemsBody">
                  <tr>
                    <td><input type="text" name="items[0][itemType]" class="f-type" placeholder="e.g. Display Case"></td>
                    <td><input type="text" name="items[0][forWhat]" class="f-for" placeholder="e.g. Shoes"></td>
                    <td><input type="number" name="items[0][interL]" class="f-il" step="0.1" style="width:60px"></td>
                    <td><input type="number" name="items[0][interD]" class="f-id" step="0.1" style="width:60px"></td>
                    <td><input type="number" name="items[0][interH]" class="f-ih" step="0.1" style="width:60px"></td>
                    <td><input type="number" name="items[0][outerL]" class="f-ol" step="0.1" style="width:60px"></td>
                    <td><input type="number" name="items[0][outerD]" class="f-od" step="0.1" style="width:60px"></td>
                    <td><input type="number" name="items[0][outerH]" class="f-oh" step="0.1" style="width:60px"></td>
                    <td><input type="number" name="items[0][noOfLevels]" class="f-lv" min="1" style="width:50px"></td>
                    <td><input type="text" name="items[0][levelHeights]" class="f-lh" placeholder="e.g. 20,30"></td>
                    <td>
                      <div class="f-acc-wrap" style="min-width:140px;max-height:120px;overflow-y:auto;border:1px solid #e5e7eb;border-radius:4px;padding:4px;font-size:12px;">
                        <label style="display:block;"><input type="checkbox" name="items[0][accessories][]" value="獨立燈板 - 上燈"> 獨立燈板 - 上燈</label>
                        <label style="display:block;"><input type="checkbox" name="items[0][accessories][]" value="獨立燈板 - 下燈"> 獨立燈板 - 下燈</label>
                        <label style="display:block;"><input type="checkbox" name="items[0][accessories][]" value="獨立燈板 - 上下燈"> 獨立燈板 - 上下燈</label>
                        <label style="display:block;"><input type="checkbox" name="items[0][accessories][]" value="上下燈"> 上下燈</label>
                        <label style="display:block;"><input type="checkbox" name="items[0][accessories][]" value="背燈"> 背燈</label>
                        <label style="display:block;"><input type="checkbox" name="items[0][accessories][]" value="白色刻字"> 白色刻字</label>
                        <label style="display:block;"><input type="checkbox" name="items[0][accessories][]" value="彩色刻字"> 彩色刻字</label>
                        <label style="display:block;"><input type="checkbox" name="items[0][accessories][]" value="背景"> 背景</label>
                        <label style="display:block;"><input type="checkbox" name="items[0][accessories][]" value="樓梯"> 樓梯</label>
                        <label style="display:block;"><input type="checkbox" name="items[0][accessories][]" value="鏡面"> 鏡面</label>
                        <label style="display:block;"><input type="checkbox" name="items[0][accessories][]" value="趟門"> 趟門</label>
                        <label style="display:block;"><input type="checkbox" name="items[0][accessories][]" value="磁石門"> 磁石門</label>
                        <label style="display:block;"><input type="checkbox" name="items[0][accessories][]" value="黑底板"> 黑底板</label>
                        <label style="display:block;"><input type="checkbox" name="items[0][accessories][]" value="透明底板"> 透明底板</label>
                      </div>
                    </td>
                    <td><input type="text" name="items[0][description]" class="f-desc" placeholder="Remarks"></td>
                    <td><input type="number" name="items[0][qty]" class="f-qty amount-input" min="1" value="1" style="width:55px" oninput="recalcSubtotal()"></td>
                    <td><input type="number" name="items[0][amount]" class="f-amt amount-input" step="0.01" style="width:80px" oninput="recalcSubtotal()"></td>
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
                <textarea name="notes" rows="3"></textarea>
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
    function addRow() {
      const tbody = document.getElementById('itemsBody');
      const rows = tbody.querySelectorAll('tr');
      const newIndex = rows.length;
      const first = rows[0];
      const clone = first.cloneNode(true);
      clone.querySelectorAll('input, select, textarea').forEach(function(el) {
        if (el.name) {
          el.name = el.name.replace(/items\[\d+\]/, 'items[' + newIndex + ']');
        }
        if (el.type === 'checkbox') {
          el.checked = false;
        } else if (el.type === 'number') {
          el.value = el.classList.contains('f-qty') ? '1' : '';
        } else {
          el.value = '';
        }
      });
      tbody.appendChild(clone);
    }
    function removeRow(btn) {
      const tbody = document.getElementById('itemsBody');
      if (tbody.querySelectorAll('tr').length <= 1) return;
      btn.closest('tr').remove();
      // Re-index all rows
      tbody.querySelectorAll('tr').forEach(function(row, idx) {
        row.querySelectorAll('input, select, textarea').forEach(function(el) {
          if (el.name) {
            el.name = el.name.replace(/items\[\d+\]/, 'items[' + idx + ']');
          }
        });
      });
      recalcSubtotal();
    }
    function recalcSubtotal() {
      let sum = 0;
      document.querySelectorAll('.f-amt').forEach(i => { sum += parseFloat(i.value) || 0; });
      document.getElementById('subtotal').value = sum.toFixed(2);
      recalcTotal();
    }
    function recalcTotal() {
      const sub = parseFloat(document.getElementById('subtotal').value) || 0;
      const disc = parseFloat(document.getElementById('discount').value);
      const d = isNaN(disc) ? 1 : disc;
      document.getElementById('total').value = Math.ceil(sub * d);
    }
    recalcSubtotal();
  </script>`;

  res.send(renderPage('Create Quote', content, extraHead));
});

// ═══════════════════════════════════════════════════════════════════════════
// ROUTE: POST /quote/create
// ═══════════════════════════════════════════════════════════════════════════
app.post('/quote/create', async (req: Request, res: Response) => {
  try {
    const b = req.body;

    // Express extended:true will parse items[0][itemType] into nested objects
    let items: any[] = [];
    if (b.items) {
      if (Array.isArray(b.items)) {
        items = b.items;
      } else if (typeof b.items === 'object') {
        // Express sometimes parses as { '0': {...}, '1': {...} }
        items = Object.values(b.items);
      }
    }
    // Filter empty rows
    items = items.filter((item: any) => item && (item.itemType || item.amount));
    // Normalize accessories, qty, amount
    items = items.map((item: any) => ({
      ...item,
      accessories: item.accessories ? (Array.isArray(item.accessories) ? item.accessories : [item.accessories]) : [],
      qty: parseInt(item.qty) || 1,
      amount: parseFloat(item.amount) || 0,
      noOfLevels: item.noOfLevels ? parseInt(item.noOfLevels) : null,
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

    await tableQuotes.create([{
      fields: {
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
      }
    }]);

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
              <div class="form-row form-row-2">
                <div class="form-group">
                  <label>Payment Method *</label>
                  <select name="paymentMethod" required>
                    <option value="FPS">FPS 轉數快</option>
                    <option value="Bank Transfer">Bank Transfer 銀行轉帳</option>
                    <option value="PayMe">PayMe</option>
                  </select>
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
            </div>

            <div class="privacy-notice">
              閣下所提供的個人資料僅作訂單跟進、送貨安排及客戶聯絡之用途，所有資料將予以保密，並不會向第三方公開或作其他未經授權之用途。
            </div>

            <div style="margin-top:20px;text-align:right;">
              <a href="/quote/${token}" class="btn btn-outline" style="margin-right:10px;">← Back to Quote</a>
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
    const { customerName, customerPhone, customerEmail, chineseDeliveryAddress, paymentMethod, howDidYouKnowUs } = req.body;

    const records = await tableQuotes.select({ filterByFormula: `{Public Token} = '${token}'` }).firstPage();
    if (records.length === 0) return res.status(404).send(renderPage('Not Found', '<div class="alert alert-danger">Quote not found.</div>'));

    const record = records[0];
    const currentStatus = record.fields['Status'] as string;
    if (currentStatus === 'Mark as Paid') {
      return res.status(400).send(renderPage('Error', '<div class="alert alert-danger">This quote has already been converted.</div>'));
    }

    // Save customer info back to Quote first
    await tableQuotes.update([{
      id: record.id,
      fields: {
        'Customer Name': customerName,
        'Customer Phone': customerPhone,
        'Customer Email': customerEmail,
        'Chinese Delivery Address': chineseDeliveryAddress,
        'Payment Method': paymentMethod,
        'How Did You Know Us': howDidYouKnowUs || '',
        'Customer Submitted At': new Date().toISOString(),
        'Status': 'Ready to Convert'
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

    // Also upsert customer master for easier conversion later
    const existingByPhone = await tableCustomers.select({ filterByFormula: `{Phone} = '${customerPhone}'` }).firstPage();
    if (existingByPhone.length > 0) {
      await tableCustomers.update([{
        id: existingByPhone[0].id,
        fields: {
          'Customer Name': customerName,
          'Phone': customerPhone,
          'Email': customerEmail,
          'Address': chineseDeliveryAddress,
          ...(howKnowUsValue ? { 'How did you know us?': howKnowUsValue } : {}),
        } as FieldSet
      }]);
    } else {
      await tableCustomers.create([{
        fields: {
          'Customer Name': customerName,
          'Phone': customerPhone,
          'Email': customerEmail,
          'Address': chineseDeliveryAddress,
          ...(howKnowUsValue ? { 'How did you know us?': howKnowUsValue } : {}),
        } as FieldSet
      }]);
    }

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

    // A. Customers — look up by submitted phone from Customers table
    let customerRecordId: string;
    const existingCustomers = await tableCustomers.select({ filterByFormula: `{Phone} = '${quotePhone}'` }).firstPage();

    if (existingCustomers.length > 0) {
      customerRecordId = existingCustomers[0].id;
    } else {
      // Customer not found — create a minimal record using Contact Name from Quote
      const contactName = (qf['Contact Name'] as string) || '';
      const newCustomer = await tableCustomers.create([{
        fields: { 'Customer Name': contactName, 'Phone': quotePhone } as FieldSet
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
      'Status': 'Unpaid',
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
        const accArray: string[] = Array.isArray(item.accessories)
          ? item.accessories.filter(Boolean)
          : (item.accessories ? String(item.accessories).split(',').map((s: string) => s.trim()).filter(Boolean) : []);

        const fields: FieldSet = {
          'Order Link': [orderRecordId],
          'Description': [item.itemType, item.forWhat, item.description].filter(Boolean).join(' / '),
          'QTY': item.qty || 1,
          'Product Amount': item.amount || 0,
          'Item Type': item.itemType || '',
          'For What': item.forWhat || '',
          'Inter L': item.interL ? String(item.interL) : '',
          'Inter D': item.interD ? String(item.interD) : '',
          'Inter H': item.interH ? String(item.interH) : '',
          'No. of Levels': item.noOfLevels || null,
          'Level Heights': item.levelHeights || '',
        };
        if (accArray.length > 0) fields['Accessories'] = accArray;
        if (item.outerL) fields['Outer L'] = String(item.outerL);
        if (item.outerD) fields['Outer D'] = String(item.outerD);
        if (item.outerH) fields['Outer H'] = String(item.outerH);
        return { fields };
      });
      await tableOrderItems.create(orderItemsPayload);
    }

    // D. Update Quote
    await tableQuotes.update([{
      id: quote.id,
      fields: {
        'Status': 'Mark as Paid',
        'Converted Order No': internalOrderNo,
        'Converted Invoice No': invoiceNumber,
        'Order Ref': orderRecordId,
        'Converted At': new Date().toISOString(),
        'Invoice Public Token': invoicePublicToken,
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

    // Order items — filter by Order Link (linked record)
    const itemRecords = await tableOrderItems
      .select({ filterByFormula: `OR(SEARCH('${order.id}', ARRAYJOIN({Order Link})) > 0, SEARCH('${order.id}', ARRAYJOIN({Order})) > 0)` })
      .firstPage();

    const itemRows = itemRecords.length === 0
      ? '<tr><td colspan="8" style="text-align:center;color:#9ca3af;">No items</td></tr>'
      : itemRecords.map((item: any, idx: number) => {
          const f = item.fields;
          const interSize = [f['Inter L'], f['Inter D'], f['Inter H']].filter(Boolean).join(' x ');
          return `<tr>
            <td>${idx + 1}</td>
            <td>${escapeHtml(f['Item Type'] || f['Description'] || '')}</td>
            <td>${escapeHtml(interSize) || '-'}</td>
            <td style="text-align:center;">${f['No. of Levels'] || '-'}</td>
            <td>${escapeHtml(f['Level Heights'] || '')}</td>
            <td>${renderAccTags(f['Accessories'])}</td>
            <td style="text-align:center;">${f['QTY'] || f['Qty'] || 1}</td>
            <td style="text-align:right;">$${f['Product Amount'] || f['Amount'] || 0}</td>
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
                    <th>Inter Size (cm)</th>
                    <th>Levels</th>
                    <th>Level Heights</th>
                    <th>Accessories</th>
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

          ${of['Payment Method'] ? `<p style="margin-top:12px;"><strong>Payment Method:</strong> ${escapeHtml(of['Payment Method'] as string)}</p>` : ''}
          ${of['Notes'] ? `<div class="section" style="margin-top:16px;"><div class="section-title">Notes</div><p style="font-size:13px;">${nl2br(of['Notes'])}</p></div>` : ''}
          ${of['Terms and Conditions'] ? `<div class="section"><div class="section-title">Terms and Conditions</div><p style="font-size:12px;color:#374151;">${nl2br(of['Terms and Conditions'])}</p></div>` : ''}

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
        'Status': 'Paid',
        'Pay Date': payDate,
        'Receipt Number': receiptNumber,
        'Receipt Public Token': receiptPublicToken,
      }
    }]);

    // Also update the linked Quote status
    const sourceQuoteNumber = order.fields['Source Quote Ref'] as string;
    if (sourceQuoteNumber) {
      const quoteRecords = await tableQuotes.select({
        filterByFormula: `{Quote Number} = '${sourceQuoteNumber}'`
      }).firstPage();
      if (quoteRecords.length > 0) {
        await tableQuotes.update([{
          id: quoteRecords[0].id,
          fields: {
            'Status': 'Mark as Paid',
            'Receipt Public Token': receiptPublicToken,
          }
        }]);
      }
    }

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

          ${of['Terms and Conditions'] ? `<div class="section"><div class="section-title">Terms and Conditions</div><p style="font-size:12px;color:#374151;">${nl2br(of['Terms and Conditions'])}</p></div>` : ''}

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
