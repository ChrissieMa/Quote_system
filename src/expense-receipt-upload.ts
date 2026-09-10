import crypto from 'crypto';

export const EXPENSE_RECEIPT_MAX_BYTES = 5 * 1024 * 1024;
export const EXPENSE_RECEIPT_FIELD = 'Receipt / Invoice';
export const EXPENSE_RECEIPT_SHA_FIELD = 'Receipt SHA-256';
export const EXPENSE_RECEIPT_UPLOAD_ID_FIELD = 'Receipt Upload ID';
export const RECEIPT_PAYMENT_METHODS = ['銀行轉帳', 'FPS', 'PayMe', '支票'] as const;

export const validateReceiptPaymentMethod = (value: unknown): typeof RECEIPT_PAYMENT_METHODS[number] => {
  const normalized = String(value || '').trim();
  const matched = RECEIPT_PAYMENT_METHODS.find(method => method === normalized);
  if (!matched) throw new Error('receipt-payment-method-invalid');
  return matched;
};

export type ExpenseReceiptFile = {
  contentType: 'application/pdf' | 'image/png' | 'image/jpeg' | 'image/heic' | 'image/heif';
  extension: '.pdf' | '.png' | '.jpg' | '.heic' | '.heif';
};

const isPng = (bytes: Buffer): boolean =>
  bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

const isJpeg = (bytes: Buffer): boolean =>
  bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

const isPdf = (bytes: Buffer): boolean =>
  bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-';

const heifBrand = (bytes: Buffer): string =>
  bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp'
    ? bytes.subarray(8, Math.min(bytes.length, 32)).toString('ascii')
    : '';

export const detectExpenseReceiptFile = (bytes: Buffer): ExpenseReceiptFile => {
  if (!bytes.length || bytes.length > EXPENSE_RECEIPT_MAX_BYTES) throw new Error('expense-receipt-size-invalid');
  if (isPdf(bytes)) return { contentType: 'application/pdf', extension: '.pdf' };
  if (isPng(bytes)) return { contentType: 'image/png', extension: '.png' };
  if (isJpeg(bytes)) return { contentType: 'image/jpeg', extension: '.jpg' };
  const brand = heifBrand(bytes);
  if (/(heic|heix|hevc|hevx)/.test(brand)) return { contentType: 'image/heic', extension: '.heic' };
  if (/(mif1|msf1)/.test(brand)) return { contentType: 'image/heif', extension: '.heif' };
  throw new Error('expense-receipt-file-type-invalid');
};

export const validateExpenseReceiptUploadId = (value: unknown): string => {
  const normalized = String(value || '').trim();
  if (!/^exp_[a-f0-9]{32}$/.test(normalized)) throw new Error('expense-receipt-upload-id-invalid');
  return normalized;
};

const repairMultipartUtf8Filename = (value: string): string => {
  if (!/[\u00c2-\u00f4]/.test(value)) return value;
  const decoded = Buffer.from(value, 'latin1').toString('utf8');
  return decoded.includes('\ufffd') ? value : decoded;
};

export const safeExpenseReceiptFilename = (value: unknown, extension: ExpenseReceiptFile['extension']): string => {
  const stem = repairMultipartUtf8Filename(String(value || 'receipt'))
    .normalize('NFKC')
    .replace(/\.[^.]+$/, '')
    .replace(/[^\p{L}\p{N}._ -]+/gu, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. _-]+/, '')
    .slice(0, 90) || 'receipt';
  return `${stem}${extension}`;
};

export const expenseReceiptSha256 = (bytes: Buffer): string =>
  crypto.createHash('sha256').update(bytes).digest('hex');

export const safeExpenseReceiptNote = (value: unknown): string =>
  String(value || '').normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);

export const uploadExpenseReceiptToAirtable = async (input: {
  apiKey: string;
  baseId: string;
  recordId: string;
  attachmentFieldId: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
  fetchImpl?: typeof fetch;
}): Promise<void> => {
  const runFetch = input.fetchImpl || fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await runFetch(
      `https://content.airtable.com/v0/${encodeURIComponent(input.baseId)}/${encodeURIComponent(input.recordId)}/${encodeURIComponent(input.attachmentFieldId)}/uploadAttachment`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contentType: input.contentType,
          file: input.bytes.toString('base64'),
          filename: input.filename,
        }),
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new Error(`expense-receipt-airtable-upload-failed-${response.status}`);
  } finally {
    clearTimeout(timeout);
  }
};
