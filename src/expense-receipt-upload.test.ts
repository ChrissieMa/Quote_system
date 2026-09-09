import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectExpenseReceiptFile,
  expenseReceiptSha256,
  safeExpenseReceiptFilename,
  safeExpenseReceiptNote,
  uploadExpenseReceiptToAirtable,
  validateExpenseReceiptUploadId,
  validateReceiptPaymentMethod,
} from './expense-receipt-upload';

test('expense receipt validation accepts real signatures and rejects disguised files', () => {
  assert.equal(detectExpenseReceiptFile(Buffer.from('%PDF-1.7\nfixture')).contentType, 'application/pdf');
  assert.equal(detectExpenseReceiptFile(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).contentType, 'image/png');
  assert.equal(detectExpenseReceiptFile(Buffer.from([0xff, 0xd8, 0xff, 0xdb])).contentType, 'image/jpeg');
  assert.equal(detectExpenseReceiptFile(Buffer.from('0000ftypheic000000000000', 'ascii')).contentType, 'image/heic');
  assert.throws(() => detectExpenseReceiptFile(Buffer.from('<script>bad</script>')), /file-type-invalid/);
});

test('Receipt payment method accepts only the four Owner-approved choices', () => {
  for (const method of ['銀行轉帳', 'FPS', 'PayMe', '支票']) assert.equal(validateReceiptPaymentMethod(method), method);
  for (const invalid of ['', 'Cash', 'Bank Transfer', '付款證明']) {
    assert.throws(() => validateReceiptPaymentMethod(invalid), /payment-method-invalid/);
  }
});

test('expense receipt identifiers, names, notes and digest are normalized', () => {
  assert.equal(validateExpenseReceiptUploadId(`exp_${'a'.repeat(32)}`), `exp_${'a'.repeat(32)}`);
  assert.throws(() => validateExpenseReceiptUploadId('../bad'), /upload-id-invalid/);
  assert.equal(safeExpenseReceiptFilename('../../七月 單據.exe', '.pdf'), '七月 單據.pdf');
  assert.equal(safeExpenseReceiptNote('  公司\n單據\u0000  '), '公司 單據');
  assert.equal(expenseReceiptSha256(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('direct Airtable attachment upload sends base64 bytes without public storage', async () => {
  let seenUrl = '';
  let seenBody: any;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(url);
    seenBody = JSON.parse(String(init?.body));
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer secret');
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  await uploadExpenseReceiptToAirtable({
    apiKey: 'secret', baseId: 'appFixture', recordId: 'recFixture', attachmentFieldId: 'fldFixture',
    filename: 'receipt.pdf', contentType: 'application/pdf', bytes: Buffer.from('fixture'), fetchImpl,
  });
  assert.match(seenUrl, /^https:\/\/content\.airtable\.com\/v0\//);
  assert.equal(seenBody.file, Buffer.from('fixture').toString('base64'));
  assert.equal(seenBody.filename, 'receipt.pdf');
});

test('direct Airtable attachment upload fails closed on provider error', async () => {
  const fetchImpl = (async () => new Response('{}', { status: 422 })) as typeof fetch;
  await assert.rejects(uploadExpenseReceiptToAirtable({
    apiKey: 'secret', baseId: 'appFixture', recordId: 'recFixture', attachmentFieldId: 'fldFixture',
    filename: 'receipt.pdf', contentType: 'application/pdf', bytes: Buffer.from('fixture'), fetchImpl,
  }), /failed-422/);
});
