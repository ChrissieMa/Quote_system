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
    "app.get('/admin/dashboard', requireAdmin,",
    "app.post('/admin/china-shipments/:shipmentId/driver-payments', requireAdmin, requireSameOrigin,",
    "app.get('/admin/costs', requireAdmin,",
    "app.post('/admin/china-shipments', requireAdmin, requireSameOrigin,",
    "app.post('/admin/costs', requireAdmin, requireSameOrigin,",
    "app.post('/admin/finance/sync', requireAdmin, requireSameOrigin,",
  ];
  for (const route of protectedRoutes) assert.ok(source.includes(route), `missing protection: ${route}`);
  assert.ok(!/ADMIN_PASSWORD\s*\|\|\s*['"][^'"]+/.test(source), 'admin password must never have a default');
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
