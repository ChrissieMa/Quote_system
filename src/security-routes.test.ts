import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8');

test('all owner pages and owner data APIs require the admin session', () => {
  const protectedRoutes = [
    "app.get('/api/customers/search', requireAdmin,",
    "app.get('/api/inquiries/check-phone', requireAdmin,",
    "app.get('/inquiry/create', requireAdmin,",
    "app.post('/inquiry/create', requireAdmin, requireSameOrigin,",
    "app.get('/quotes', requireAdmin,",
    "app.get('/quote/create', requireAdmin,",
    "app.post('/quote/create', requireAdminOrPilotInternal, requireSameOrigin,",
    "app.post('/admin/quote/:token/convert', requireAdmin, requireSameOrigin,",
    "app.post('/admin/invoice/:token/mark-paid', requireAdmin, requireSameOrigin,",
    "app.get('/admin/receipts/audit', requireAdmin,",
    "app.post('/admin/receipts/backfill', requireAdmin, requireSameOrigin,",
    "app.get('/admin/dashboard', requireAdmin,",
    "app.get('/admin/analytics/purchase-cycles', requireAdmin,",
    "app.post('/admin/china-shipments/:shipmentId/driver-payments', requireAdmin, requireSameOrigin,",
    "app.get('/admin/costs', requireAdmin,",
    'app.get(QUOTATION_IMAGE_READY_HANDSHAKE_PATH, requireAdmin,',
    "app.post('/admin/china-shipments', requireAdmin, requireSameOrigin,",
    "app.post('/admin/costs', requireAdmin, requireSameOrigin,",
    "app.post('/admin/finance/sync', requireAdmin, requireSameOrigin,",
  ];
  for (const route of protectedRoutes) assert.ok(source.includes(route), `missing protection: ${route}`);
  assert.ok(!/ADMIN_PASSWORD\s*\|\|\s*['"][^'"]+/.test(source), 'admin password must never have a default');
});

test('owner-only quotation-image TEST route is isolated from Production data and worker behavior', () => {
  const start = source.indexOf('app.get(QUOTATION_IMAGE_READY_HANDSHAKE_PATH, requireAdmin,');
  const end = source.indexOf('if (BROWSER_QUOTATION_IMAGE_BRIDGE && QUOTATION_IMAGE_RENDERER_URL)', start);
  assert.ok(start >= 0 && end > start, 'owner-only TEST handshake route must exist');
  const route = source.slice(start, end);
  for (const required of [
    'requireAdmin',
    'requireSameOrigin',
    'quotationImageBridgeCsp(QUOTATION_IMAGE_READY_HANDSHAKE_RENDERER_URL)',
    'quotationImageReadyHandshakeFixture',
  ]) assert.ok(route.includes(required), `TEST handshake route missing ${required}`);
  assert.equal((route.match(/requireAdmin/g) || []).length, 6, 'all TEST page/data routes require owner auth');
  assert.equal((route.match(/requireSameOrigin/g) || []).length, 4, 'all TEST bridge calls require same origin');
  for (const forbidden of [
    'tableQuotes', 'tableOrders', 'tableOrderItems', 'tableCustomers',
    'quotationImageRuntime', 'Airtable', 'publicToken', 'quoteToken',
  ]) assert.ok(!route.includes(forbidden), `TEST handshake route must not access ${forbidden}`);

  const productionWorker = source.slice(end, source.indexOf('type AirtableMetadataField', end));
  assert.ok(productionWorker.includes("app.get('/quotation-image/browser-bridge', requireAdmin,"));
  assert.ok(productionWorker.includes('browserQuotationImageClientHtml(QUOTATION_IMAGE_RENDERER_URL, {'));
  assert.ok(productionWorker.includes('deferRendererLoadUntilListener: true'));
  assert.ok(productionWorker.includes("app.get('/quotation-image/browser-bridge/next'"));
  assert.ok(productionWorker.includes('scheduleLatestRetryableQuotationImage'));
  assert.ok(productionWorker.includes('tableQuotes.select'));
  assert.ok(productionWorker.includes('BROWSER_QUOTATION_IMAGE_BRIDGE.complete'));
  assert.ok(!productionWorker.includes('QUOTATION_IMAGE_READY_HANDSHAKE_PATH'));
});

test('service APIs remain bearer-protected and confirmed', () => {
  const serviceRoutes = [
    '/api/quote-pilot/preview', '/api/quote-pilot/create', '/api/quote-pilot/lookup',
    '/api/production-maintenance/delete-preview', '/api/production-maintenance/delete-confirm',
    '/api/production-maintenance/edit-preview', '/api/production-maintenance/edit-confirm',
    '/api/production-maintenance/cancel-preview', '/api/production-maintenance/cancel-confirm',
  ];
  for (const route of serviceRoutes) {
    assert.match(source, new RegExp(`app\\.post\\('${route.replaceAll('/', '\\/')}', requireQuotePilotApi,`));
  }
});

test('driver settlement route cannot write P&L or Business Expenses', () => {
  const start = source.indexOf("app.post('/admin/china-shipments/:shipmentId/driver-payments'");
  const end = source.indexOf("app.get('/admin/costs'", start);
  assert.ok(start >= 0 && end > start, 'driver settlement route must exist');
  const route = source.slice(start, end);
  assert.ok(route.includes("safeEqual(String(req.body.csrf || ''), getOwnerFormToken())"));
  assert.ok(route.includes('tableChinaShipments.update'));
  for (const forbidden of ['tableBusinessExpenses.update', 'tableBusinessExpenses.create', 'tableMonthlyFinance.update', 'syncMonthlyFinance(']) {
    assert.ok(!route.includes(forbidden), `driver settlement must not call ${forbidden}`);
  }
});

test('Receipt creation route requires no payment evidence and remains CSRF-protected, idempotent and full-total atomic', () => {
  const start = source.indexOf("app.post('/admin/invoice/:token/mark-paid'");
  const end = source.indexOf("app.get(['/receipt/:token'", start);
  assert.ok(start >= 0 && end > start, 'customer payment route must exist');
  const route = source.slice(start, end);
  for (const required of [
    "safeEqual(String(req.body.csrf || ''), getOwnerFormToken())",
    'validateOrderPaymentRequestId',
    "receiptSequenceLock.run('receipt-sequence'",
    'orderPaymentLock.run',
    'planFullReceipt',
    'paymentLogHasRequest',
    'syncMonthlyFinance(orderMonth)',
  ]) assert.ok(route.includes(required), `payment route missing ${required}`);
  for (const forbidden of ['Payment Evidence', 'payment-evidence', 'Dropbox', 'dropbox']) {
    assert.ok(!route.includes(forbidden), `Receipt creation must not depend on ${forbidden}`);
  }
  assert.ok(!route.includes('req.body.amount_received'), 'Receipt creation must not accept a second payment amount');
  for (const field of ["'Receipt Number'", "'Receipt Public Token'", "'Pay Date'", "'Status'"]) {
    assert.ok(route.includes(field), `atomic Receipt update missing ${field}`);
  }
});

test('Receipt dashboard has one full-settlement action and signed Quote images fetch eagerly', () => {
  assert.ok(source.includes('建立收據＝確認全數收款'));
  assert.ok(!source.includes('placeholder="今次實收HK$"'));
  assert.ok(!source.includes('>記錄實收</button>'));
  assert.ok(source.includes('loading="eager" fetchpriority="high"'));
  assert.ok(!source.includes('loading="lazy"'));
  assert.ok(source.includes("paidInFull: isEnglish ? 'Paid in full' : '已全數付款'"));
  assert.ok(!source.includes("paidInFull: isEnglish ? '${R.paidInFull}'"));
});

test('public document routes validate native aliases and legacy tokens before Airtable lookup', () => {
  assert.equal((source.match(/if \(!acceptedPublicToken\(token\)\) return publicDocumentNotFound\(res\);/g) || []).length, 7);
  assert.ok(!source.includes('/^[a-f0-9]{32}$/'));
});

test('short customer paths are native aliases and long paths remain backward compatible', () => {
  for (const route of [
    "app.get(['/quote/:token', '/q/:token']",
    "app.get(['/invoice/:token', '/i/:token']",
    "app.get(['/receipt/:token', '/r/:token']",
    "app.get(['/quote/:token/customer-info', '/q/:token/info']",
    "app.post(['/quote/:token/customer-info', '/q/:token/info']",
  ]) assert.ok(source.includes(route), `missing short path alias: ${route}`);
  assert.ok(source.includes('`${PUBLIC_BASE_URL}${publicQuotePath(publicToken)}`'));
  assert.ok(source.includes('`${PUBLIC_BASE_URL}${publicCustomerInfoPath(publicToken)}`'));
});

test('Quote creation maps bilingual item labels to the locked Inquiry select options', () => {
  assert.ok(source.includes("'Product Interest': mapQuoteItemTypeToInquiryProductInterest(firstItem.itemType)"));
  assert.ok(!source.includes("'Product Interest': firstItem.itemType"));
});

test('owner dashboard exposes auditable Order cost breakdown without calling provisional profit final', () => {
  for (const label of [
    '實付小糖貨款',
    '每張 Order 成本及盈利明細',
    '報價手動Profit',
    '全單優惠',
    '報價中國運費預留',
    '報價香港送貨預留',
    '實付中國運費',
    '香港運費應付',
    '實付香港運費',
    '截至目前現金毛利',
    '預計／權責毛利（上限）',
    'blank／0顯示未付款',
  ]) assert.ok(source.includes(label), `missing cost breakdown label: ${label}`);
});

test('new Quote persistence links a purchase-cycle Inquiry on the first write', () => {
  const start = source.indexOf('// Attribution belongs to the first customer inquiry');
  const end = source.indexOf('const publicLink =', start);
  assert.ok(start >= 0 && end > start, 'Quote creation block must exist');
  const route = source.slice(start, end);
  const inquiryCreate = route.indexOf('tableInquiries.create');
  const quoteCreate = route.indexOf('tableQuotes.create');
  assert.ok(inquiryCreate >= 0 && quoteCreate > inquiryCreate, 'new Inquiry must exist before first Quote write');
  assert.ok(route.includes("...(canonicalInquiryRecordId ? { 'Inquiry': [canonicalInquiryRecordId] } : {})"));
  assert.ok(!route.includes("tableQuotes.update([{\n          id: createdQuoteRecordId,\n          fields: { 'Inquiry'"), 'linkage must not depend on a second Quote write');
});

test('server-wide privacy headers, HTML noindex, crawlable robots, and dead sitemaps are present', () => {
  for (const value of [
    "X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet",
    "Cache-Control', 'private, no-store, max-age=0, must-revalidate",
    '<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">',
    "app.get('/robots.txt'",
    "Allow: /",
    "app.all(['/sitemap.xml', '/sitemap_index.xml']",
  ]) assert.ok(source.includes(value), `missing security directive: ${value}`);
});

test('same-origin writes support the active Railway/custom-domain request origin and browser fetch metadata', () => {
  assert.ok(source.includes("req.headers['sec-fetch-site']"));
  assert.ok(source.includes("`${req.protocol}://${requestHost}`"));
});
