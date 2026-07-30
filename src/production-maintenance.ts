import crypto from 'crypto';

export const MAINTENANCE_CONFIRMATION_TTL_MS = 30 * 60 * 1000;

export type MaintenanceRecord = {
  tableId: string;
  tableName: string;
  id: string;
  fields: Record<string, unknown>;
};

export type QuoteDeletionSnapshot = {
  capturedAt: string;
  quote: MaintenanceRecord;
  schema: Array<{
    tableId: string;
    tableName: string;
    fields: Array<{
      name: string;
      type: string;
      linkedTableId?: string;
    }>;
  }>;
  convertedMarkers: Record<string, unknown>;
  dependencies: {
    orders: MaintenanceRecord[];
    orderItems: MaintenanceRecord[];
    receipts: MaintenanceRecord[];
    deliveries: MaintenanceRecord[];
    other: MaintenanceRecord[];
  };
  protectedNotDeleted: MaintenanceRecord[];
};

export type QuoteDeletionAnalysis = {
  quoteNo: string;
  status: string;
  isDraftOrTest: boolean;
  hasConvertedMarkers: boolean;
  dependencyCounts: Record<'orders' | 'orderItems' | 'receipts' | 'deliveries' | 'other', number>;
  canDelete: boolean;
  blockers: string[];
  willDelete: string[];
  willNotDelete: string[];
  productionWriteCountOnConfirm: 1;
};

const text = (value: unknown): string => String(value ?? '').trim();

export const stableMaintenanceStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableMaintenanceStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableMaintenanceStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

export const maintenanceSnapshotFingerprint = (snapshot: QuoteDeletionSnapshot): string => {
  const { capturedAt: _capturedAt, ...lockedState } = snapshot;
  return crypto.createHash('sha256').update(stableMaintenanceStringify(lockedState)).digest('hex');
};

export const analyzeQuoteDeletion = (snapshot: QuoteDeletionSnapshot): QuoteDeletionAnalysis => {
  const quoteNo = text(snapshot.quote.fields['Quote Number']);
  const status = text(snapshot.quote.fields.Status);
  const isDraftOrTest = /^(draft|test)$/i.test(status);
  const convertedValues = Object.values(snapshot.convertedMarkers).filter(value => {
    if (Array.isArray(value)) return value.length > 0;
    return text(value) !== '';
  });
  const hasConvertedMarkers = convertedValues.length > 0;
  const dependencyCounts = {
    orders: snapshot.dependencies.orders.length,
    orderItems: snapshot.dependencies.orderItems.length,
    receipts: snapshot.dependencies.receipts.length,
    deliveries: snapshot.dependencies.deliveries.length,
    other: snapshot.dependencies.other.length,
  };
  const blockers: string[] = [];
  if (!isDraftOrTest) blockers.push(`Status 是 ${status || '空白'}，不是 Draft／Test。`);
  if (hasConvertedMarkers) blockers.push('Quote 已有 Convert／Invoice／Order marker。');
  for (const [kind, count] of Object.entries(dependencyCounts)) {
    if (count > 0) blockers.push(`${kind} dependency：${count} 筆。`);
  }
  return {
    quoteNo,
    status,
    isDraftOrTest,
    hasConvertedMarkers,
    dependencyCounts,
    canDelete: blockers.length === 0,
    blockers,
    willDelete: [`Quotes.${quoteNo}（Airtable record ${snapshot.quote.id}）`],
    willNotDelete: [
      'Customer',
      'Order_2026',
      'Order Items',
      'Invoice／Receipt／Payment',
      'Delivery',
      '其他 Quote',
    ],
    productionWriteCountOnConfirm: 1,
  };
};

type DeleteConfirmationPayload = {
  v: 1;
  operation: 'deleteQuote';
  issuedAt: number;
  nonce: string;
  quoteNo: string;
  recordId: string;
  snapshotFingerprint: string;
};

export const issueDeleteConfirmation = (
  snapshot: QuoteDeletionSnapshot,
  secret: string,
  now = Date.now(),
  nonce = crypto.randomBytes(12).toString('hex'),
): string => {
  if (!secret) throw new Error('Maintenance confirmation secret is not configured.');
  const analysis = analyzeQuoteDeletion(snapshot);
  if (!analysis.canDelete) throw new Error('Quote is not eligible for deletion.');
  const data: DeleteConfirmationPayload = {
    v: 1,
    operation: 'deleteQuote',
    issuedAt: now,
    nonce,
    quoteNo: analysis.quoteNo,
    recordId: snapshot.quote.id,
    snapshotFingerprint: maintenanceSnapshotFingerprint(snapshot),
  };
  const payload = Buffer.from(stableMaintenanceStringify(data), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
};

export const verifyDeleteConfirmation = (
  confirmationId: string,
  secret: string,
  now = Date.now(),
): DeleteConfirmationPayload => {
  const [payload, signature, extra] = text(confirmationId).split('.');
  if (!payload || !signature || extra || !secret) throw new Error('Invalid delete confirmation ID.');
  const expected = crypto.createHmac('sha256', secret).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new Error('Invalid delete confirmation ID.');
  }
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as DeleteConfirmationPayload;
  if (
    decoded.v !== 1
    || decoded.operation !== 'deleteQuote'
    || !decoded.quoteNo
    || !decoded.recordId
    || !decoded.snapshotFingerprint
    || !Number.isFinite(decoded.issuedAt)
  ) {
    throw new Error('Invalid delete confirmation ID.');
  }
  if (decoded.issuedAt > now + 60_000 || now - decoded.issuedAt > MAINTENANCE_CONFIRMATION_TTL_MS) {
    throw new Error('Delete confirmation has expired. Generate a new dependency preview.');
  }
  return decoded;
};

export const requiredDeleteConfirmation = (quoteNo: string): string =>
  `確認刪除 ${text(quoteNo).toLocaleUpperCase()}`;
