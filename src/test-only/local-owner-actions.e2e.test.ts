import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const waitForServer = async (url: string, child: ChildProcess): Promise<void> => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`local fixture exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/robots.txt`);
      if (response.ok) return;
    } catch { /* still starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('local fixture did not start');
};

const capture = (html: string, pattern: RegExp, label: string): string => {
  const value = html.match(pattern)?.[1];
  assert.ok(value, `missing ${label}`);
  return value;
};

test('owner can choose a payment method and upload one idempotent expense receipt', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lks-owner-actions-'));
  const pngPath = path.join(dir, 'fixture.png');
  const jsonPath = path.join(dir, 'fixture.json');
  fs.writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  fs.writeFileSync(jsonPath, JSON.stringify({
    width: 1280, height: 1280, stateRestored: true,
    request: {
      purpose: 'quotation', product_type: 'display_box',
      dimensions: {
        unit: 'mm',
        inner: { length: 280, depth: 180, height: 210 },
        outer: { length: 300, depth: 200, height: 220 },
        actual: { length: 300, depth: 200, height: 220 },
      },
      cabinet_layers: [], accessories: [],
      colours: { body: 'clear_acrylic', background: 'light_blue_gray' },
      camera_preset: 'quotation_square_three_quarter_v2',
      output: { width: 1280, height: 1280, background: 'configured' },
      branding: { enabled: false, style: 'none' }, show_dimensions: true, show_price: false,
    },
  }));
  const port = 32000 + Math.floor(Math.random() * 5000);
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['-r', 'ts-node/register', 'src/index.ts'], {
    cwd: path.resolve(__dirname, '../..'),
    env: {
      ...process.env,
      NODE_ENV: 'test', PORT: String(port), PUBLIC_BASE_URL: origin,
      LKS_LOCAL_QUOTE_FIXTURE: '1', QUOTATION_IMAGE_ENABLED: '0',
      LKS_QUOTATION_IMAGE_FIXTURE_PNG: pngPath,
      LKS_QUOTATION_IMAGE_FIXTURE_JSON: jsonPath,
      ADMIN_USERNAME: 'lks', ADMIN_PASSWORD: 'test-password', SESSION_SECRET: 's'.repeat(64),
    },
    stdio: 'ignore',
  });
  t.after(() => {
    child.kill('SIGTERM');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await waitForServer(origin, child);

  const login = await fetch(`${origin}/login`, {
    method: 'POST', redirect: 'manual', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'lks', password: 'test-password', next: '/quotes' }),
  });
  assert.equal(login.status, 303);
  const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie.includes('='));

  const boundaryBefore = await (await fetch(`${origin}/__test-only/order-boundary`)).json() as any;
  assert.equal(boundaryBefore.orders, 1);
  assert.equal(boundaryBefore.orderItems, 1);
  assert.equal(boundaryBefore.pendingQuote.invoiceToken, '');
  assert.equal(boundaryBefore.pendingQuote.orderRef, '');

  const quotesHtml = await (await fetch(`${origin}/quotes`, { headers: { Cookie: cookie } })).text();
  for (const method of ['銀行轉帳', 'FPS', 'PayMe', '支票']) assert.ok(quotesHtml.includes(`value="${method}"`));
  const receiptAction = capture(quotesHtml, /action="([^"]+\/mark-paid)"/, 'Receipt action');
  const csrf = capture(quotesHtml, /name="csrf" value="([a-f0-9]{64})"/, 'csrf');
  const paymentRequestId = capture(quotesHtml, /name="payment_request_id" value="(recv_[a-f0-9]{32})"/, 'payment request id');
  const paid = await fetch(`${origin}${receiptAction}`, {
    method: 'POST', redirect: 'manual',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, payment_request_id: paymentRequestId, payment_method: 'FPS' }),
  });
  assert.equal(paid.status, 302);
  const paidHtml = await (await fetch(`${origin}/quotes`, { headers: { Cookie: cookie } })).text();
  assert.ok(!paidHtml.includes('建立收據＝確認全數收款'));
  const receiptPath = capture(paidHtml, /href="([^"]+)"[^>]*>View Receipt/, 'Receipt link');
  const receiptHtml = await (await fetch(`${origin}${receiptPath}`)).text();
  assert.ok(receiptHtml.includes('FPS'));

  const dashboardHtml = await (await fetch(`${origin}/admin/dashboard?month=2026-09`, { headers: { Cookie: cookie } })).text();
  for (const label of [
    '本月營運盈利',
    '本月營運現金流出',
    '每月營運開支／實付現金',
    '計入本月營運盈利',
  ]) assert.ok(dashboardHtml.includes(label), `dashboard is missing ${label}`);
  const uploadId = capture(dashboardHtml, /name="upload_request_id" value="(exp_[a-f0-9]{32})"/, 'upload id');
  const uploadCsrf = capture(dashboardHtml, /name="csrf" value="([a-f0-9]{64})"/, 'upload csrf');
  const form = new FormData();
  form.set('csrf', uploadCsrf);
  form.set('month', '2026-09');
  form.set('upload_request_id', uploadId);
  form.set('receipt_note', 'TEST-ONLY office receipt');
  form.set('receipt_file', new Blob([Buffer.from('%PDF-1.7\nTEST-ONLY')], { type: 'application/pdf' }), 'fixture-receipt.pdf');
  const uploaded = await fetch(`${origin}/admin/expenses/receipts`, {
    method: 'POST', redirect: 'manual', headers: { Origin: origin, Cookie: cookie }, body: form,
  });
  assert.equal(uploaded.status, 303);
  assert.match(String(uploaded.headers.get('location')), /expenseReceipt=saved/);

  const duplicateForm = new FormData();
  duplicateForm.set('csrf', uploadCsrf);
  duplicateForm.set('month', '2026-09');
  duplicateForm.set('upload_request_id', `exp_${'b'.repeat(32)}`);
  duplicateForm.set('receipt_file', new Blob([Buffer.from('%PDF-1.7\nTEST-ONLY')], { type: 'application/pdf' }), 'same-file.pdf');
  const duplicate = await fetch(`${origin}/admin/expenses/receipts`, {
    method: 'POST', redirect: 'manual', headers: { Origin: origin, Cookie: cookie }, body: duplicateForm,
  });
  assert.equal(duplicate.status, 303);
  assert.match(String(duplicate.headers.get('location')), /expenseReceipt=duplicate/);

  // Converting a Quote now issues only an unpaid Invoice. No Order or Order
  // Item may exist until the owner confirms full payment and creates Receipt.
  const convertAction = capture(quotesHtml, /action="([^\"]+\/convert)"/, 'Convert action');
  const converted = await fetch(`${origin}${convertAction}`, {
    method: 'POST', redirect: 'manual',
    headers: { Origin: origin, Cookie: cookie },
  });
  assert.equal(converted.status, 302);
  assert.match(String(converted.headers.get('location')), /converted=INV-2026-/);

  const boundaryAfterInvoice = await (await fetch(`${origin}/__test-only/order-boundary`)).json() as any;
  assert.equal(boundaryAfterInvoice.orders, 1);
  assert.equal(boundaryAfterInvoice.orderItems, 1);
  assert.ok(boundaryAfterInvoice.pendingQuote.invoiceToken);
  assert.ok(boundaryAfterInvoice.pendingQuote.invoiceNumber);
  assert.equal(boundaryAfterInvoice.pendingQuote.orderRef, '');

  const unpaidInvoice = await fetch(`${origin}/invoice/${boundaryAfterInvoice.pendingQuote.invoiceToken}`);
  assert.equal(unpaidInvoice.status, 200);
  const unpaidInvoiceHtml = await unpaidInvoice.text();
  assert.ok(unpaidInvoiceHtml.includes(boundaryAfterInvoice.pendingQuote.invoiceNumber));

  const convertedQuotesHtml = await (await fetch(`${origin}/quotes`, { headers: { Cookie: cookie } })).text();
  assert.ok(!convertedQuotesHtml.includes(`action="${convertAction}"`));
  const pendingReceiptAction = `/admin/invoice/${boundaryAfterInvoice.pendingQuote.invoiceToken}/mark-paid`;
  assert.ok(convertedQuotesHtml.includes(`action="${pendingReceiptAction}"`));
  const pendingFormStart = convertedQuotesHtml.indexOf(`action="${pendingReceiptAction}"`);
  const pendingFormHtml = convertedQuotesHtml.slice(pendingFormStart, pendingFormStart + 1400);
  const pendingCsrf = capture(pendingFormHtml, /name="csrf" value="([a-f0-9]{64})"/, 'pending csrf');
  const pendingRequestId = capture(pendingFormHtml, /name="payment_request_id" value="(recv_[a-f0-9]{32})"/, 'pending payment request id');
  const confirmPaid = await fetch(`${origin}${pendingReceiptAction}`, {
    method: 'POST', redirect: 'manual',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: pendingCsrf, payment_request_id: pendingRequestId, payment_method: '銀行轉帳' }),
  });
  assert.equal(confirmPaid.status, 302);

  const boundaryAfterPayment = await (await fetch(`${origin}/__test-only/order-boundary`)).json() as any;
  assert.equal(boundaryAfterPayment.orders, 2);
  assert.equal(boundaryAfterPayment.orderItems, 2);
  assert.ok(boundaryAfterPayment.pendingQuote.orderRef);

  const replay = await fetch(`${origin}${pendingReceiptAction}`, {
    method: 'POST', redirect: 'manual',
    headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: pendingCsrf, payment_request_id: pendingRequestId, payment_method: '銀行轉帳' }),
  });
  assert.equal(replay.status, 302);
  const boundaryAfterReplay = await (await fetch(`${origin}/__test-only/order-boundary`)).json() as any;
  assert.equal(boundaryAfterReplay.orders, 2);
  assert.equal(boundaryAfterReplay.orderItems, 2);
});
