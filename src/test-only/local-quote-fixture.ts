import crypto from 'crypto';
import fs from 'fs';
import type { FieldSet } from 'airtable';
import { formatDeterministicPublicToken } from '../security';
import {
  FixtureQuotationImageRenderer,
  LocalTestQuotationImageStorage,
  QuotationImageCoordinator,
  quotationImageAssetKey,
  quotationImageIdempotencyKey,
  sanitizeQuotationRenderRequest,
  type QuotationImagePresentationResolver,
  type QuotationImageRuntimeAdapters,
  type QuotationImageStorage,
} from '../quotation-image';
import {
  LocalBrowserQuotationImageBridge,
  localBrowserQuotationImageClientHtml,
} from './local-browser-quotation-image-bridge';

type FixtureRecord = {
  id: string;
  fields: FieldSet;
  get(field: string): unknown;
};

type FixtureTable = {
  select(options?: Record<string, unknown>): {
    all(): Promise<FixtureRecord[]>;
    firstPage(): Promise<FixtureRecord[]>;
  };
  find(id: string): Promise<FixtureRecord>;
  create(records: Array<{ fields: FieldSet }>): Promise<FixtureRecord[]>;
  update(records: Array<{ id: string; fields: FieldSet }>): Promise<FixtureRecord[]>;
  destroy(ids: string[]): Promise<FixtureRecord[]>;
};

export const localQuoteFixtureEnabled = (): boolean => {
  const publicBaseUrl = String(process.env.PUBLIC_BASE_URL || '').trim();
  const loopbackOnly = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/?$/i.test(publicBaseUrl);
  return process.env.NODE_ENV === 'test'
    && process.env.LKS_LOCAL_QUOTE_FIXTURE === '1'
    && loopbackOnly;
};

const fixtureToken = (label: string): string => formatDeterministicPublicToken(
  Date.now(),
  crypto.createHash('sha256').update(`lks-local-quote-fixture:${label}`).digest(),
);

export const LOCAL_QUOTE_TOKEN = fixtureToken('quote');
export const LOCAL_INVOICE_TOKEN = fixtureToken('invoice');
export const LOCAL_ITEM_ID = '9e4f6e72-d31a-4d1a-8d15-730282c1b102';

const record = (id: string, fields: FieldSet): FixtureRecord => ({
  id,
  fields,
  get(field: string): unknown {
    return this.fields[field];
  },
});

const quotedValue = (formula: string, field: string): string | null => {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = formula.match(new RegExp(`\\{${escaped}\\}\\s*=\\s*'((?:\\\\'|[^'])*)'`));
  return match ? match[1].replace(/\\'/g, "'") : null;
};

const matchesFormula = (fixtureRecord: FixtureRecord, formula: unknown): boolean => {
  const text = String(formula || '').trim();
  if (!text) return true;
  const equalityFields = [
    'Public Token', 'Invoice Public Token', 'Quote Number', 'Source Quote Ref',
    'Phone', 'Customer Phone', 'Campaign Name',
  ];
  for (const field of equalityFields) {
    const expected = quotedValue(text, field);
    if (expected !== null && String(fixtureRecord.fields[field] || '') !== expected) return false;
  }
  return true;
};

const createTable = (
  name: string,
  seed: FixtureRecord[],
  onCreate: (fields: FieldSet) => FieldSet = fields => fields,
): FixtureTable => {
  const records = seed;
  let nextId = records.length + 1;
  const selected = (options: Record<string, any> = {}): FixtureRecord[] => {
    let result = records.filter(item => matchesFormula(item, options.filterByFormula));
    const sort = Array.isArray(options.sort) ? options.sort : [];
    for (const entry of [...sort].reverse()) {
      const direction = entry.direction === 'desc' ? -1 : 1;
      result = [...result].sort((left, right) =>
        String(left.fields[entry.field] || '').localeCompare(String(right.fields[entry.field] || '')) * direction,
      );
    }
    const maxRecords = Number(options.maxRecords || 0);
    return maxRecords > 0 ? result.slice(0, maxRecords) : [...result];
  };
  return {
    select(options = {}) {
      return {
        all: async () => selected(options),
        firstPage: async () => selected(options),
      };
    },
    async find(id: string) {
      const found = records.find(item => item.id === id);
      if (!found) throw Object.assign(new Error(`${name} fixture record not found`), { statusCode: 404 });
      return found;
    },
    async create(inputs) {
      return inputs.map(input => {
        const created = record(
          `rec_local_${name.replace(/[^a-z0-9]/gi, '_')}_${nextId++}`,
          onCreate({ ...input.fields }),
        );
        records.push(created);
        return created;
      });
    },
    async update(inputs) {
      return inputs.map(input => {
        const found = records.find(item => item.id === input.id);
        if (!found) throw Object.assign(new Error(`${name} fixture record not found`), { statusCode: 404 });
        found.fields = { ...found.fields, ...input.fields } as FieldSet;
        return found;
      });
    },
    async destroy(ids) {
      return ids.flatMap(id => {
        const index = records.findIndex(item => item.id === id);
        return index < 0 ? [] : records.splice(index, 1);
      });
    },
  };
};

const requireFixtureFiles = (): { png: Buffer; request: unknown } => {
  const pngPath = String(process.env.LKS_QUOTATION_IMAGE_FIXTURE_PNG || '').trim();
  const metadataPath = String(process.env.LKS_QUOTATION_IMAGE_FIXTURE_JSON || '').trim();
  if (!pngPath || !metadataPath) throw new Error('Local Quote fixture paths are required.');
  const png = fs.readFileSync(pngPath);
  if (!png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error('Local Quote fixture must be a PNG.');
  }
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as Record<string, unknown>;
  if (metadata.width !== 1280 || metadata.height !== 1280 || metadata.stateRestored !== true) {
    throw new Error('Local Quote fixture evidence is not an accepted 1280 x 1280 restored-state render.');
  }
  return { png, request: sanitizeQuotationRenderRequest(metadata.request) };
};

export const createLocalQuoteFixture = (): {
  base: ((tableName: string) => FixtureTable) & { _tables: Map<string, FixtureTable> };
  metadataTables: Array<Record<string, unknown>>;
  installQuotationImageRuntime(runtime: QuotationImageRuntimeAdapters, options?: {
    storage?: QuotationImageStorage;
    presentationResolver?: QuotationImagePresentationResolver;
  }): void;
  assetStore: {
    pathPrefix: string;
    resolve(digest: string): Uint8Array | undefined;
  };
  browserBridge?: {
    rendererOrigin: string;
    clientHtml: string;
    renderer: LocalBrowserQuotationImageBridge;
  };
  urls: { create: string; share: string; invoice: string };
} => {
  const { png, request } = requireFixtureFiles();
  const automaticQuotationImage = process.env.LKS_LOCAL_QUOTE_FIXTURE_AUTO_IMAGE === '1';
  const idempotencyKey = quotationImageIdempotencyKey(LOCAL_ITEM_ID, request);
  const assetKey = quotationImageAssetKey(idempotencyKey);
  const browserTransportEnabled = process.env.LKS_LOCAL_3D_BROWSER_TRANSPORT === '1';
  const publicPreviewEnabled = process.env.LKS_LOCAL_PUBLIC_PREVIEW === '1';
  const rendererOrigin = String(process.env.LKS_LOCAL_3D_RENDERER_ORIGIN || '').trim();
  const browserRenderer = browserTransportEnabled
    ? new LocalBrowserQuotationImageBridge()
    : undefined;
  const browserBridge = browserRenderer ? {
    rendererOrigin: new URL(rendererOrigin).origin,
    clientHtml: localBrowserQuotationImageClientHtml(rendererOrigin, {
      allowExactHttpsPreview: publicPreviewEnabled,
    }),
    renderer: browserRenderer,
  } : undefined;
  let localStorage: LocalTestQuotationImageStorage | undefined;
  const item = {
    item_id: LOCAL_ITEM_ID,
    itemType: 'Display box 展示盒',
    forWhat: 'TEST-ONLY 3D fixture',
    interL: '28', interD: '18', interH: '21',
    outerL: '30', outerD: '20', outerH: '22',
    noOfLevels: null,
    levelHeights: '',
    accessories: ['背板鏡面'],
    description: 'TEST-ONLY quotation image acceptance fixture',
    qty: 1,
    amount: 1280,
    ...(automaticQuotationImage ? {} : {
      quotation_image: {
        contract: 'quotation-image-v1',
        state: 'ready',
        idempotency_key: idempotencyKey,
        asset_key: assetKey,
        attempts: 1,
        updated_at: '2026-08-22T07:09:36.022Z',
      },
    }),
    order_item_identity: { item_id: LOCAL_ITEM_ID, record_id: 'rec_local_order_item_1' },
  };
  const quoteFields: FieldSet = {
    'Quote Number': 'QT-2026-9001',
    'Quote Date': '2026-08-22',
    'Public Token': LOCAL_QUOTE_TOKEN,
    'Quote Language': 'English',
    'Valid Until': '2026-09-21',
    'Contact Name': 'TEST-ONLY FICTIONAL CUSTOMER',
    'Phone': '00000000',
    'Contact Method': 'Fixture',
    'Contact Handle / Reference': 'NO PRODUCTION DATA',
    'Sub Total': 1280,
    'Discount': 1,
    'Total': 1280,
    'Discount Value HKD': 0,
    'Delivery Charge Mode': '已包本地送貨',
    'Delivery Display Text': 'Local fixture only',
    'Quote Items JSON': JSON.stringify([item]),
    'Description Summary': 'TEST-ONLY quotation image acceptance fixture',
    // Non-empty test-only values exercise the genuine conditional sections.
    // English Quote rendering intentionally uses the application's canonical
    // DEFAULT_QUOTE_NOTES_EN and DEFAULT_TERMS_EN text when these fields exist.
    'Notes': 'TEST-ONLY: render the original Quote notes section.',
    'Terms and Conditions': 'TEST-ONLY: render the original Quote terms section.',
    'Status': 'Draft',
    'Order Ref': 'rec_local_order_1',
    'Invoice Public Token': LOCAL_INVOICE_TOKEN,
  };
  const orderFields: FieldSet = {
    'Internal Order No': 'ORD-2026-9001',
    'Internal 1 Order No': 'AUG2699',
    'Invoice Number': 'INV-2026-9001',
    'Invoice Public Token': LOCAL_INVOICE_TOKEN,
    'Invoice Date': '2026-08-22',
    'Status': 'Unpaid',
    'Customer': ['rec_local_customer_1'],
    'Product Amount': 1280,
    'Discount': 1,
    'Final Amount': 1280,
    'Discount Value HKD': 0,
    'Delivery Charge Mode': '已包本地送貨',
    'Delivery Display Text': 'Local fixture only',
    'Payment Method': 'Bank Transfer',
    'Notes': 'TEST-ONLY LOCAL FIXTURE — NO PRODUCTION DATA',
    'Terms and Conditions': 'TEST-ONLY: preserve the original Invoice presentation.',
    'Source Quote Ref': 'QT-2026-9001',
    'Quote Language': 'English',
  };

  const tables = new Map<string, FixtureTable>();
  const register = (
    names: string[],
    seed: FixtureRecord[] = [],
    onCreate?: (fields: FieldSet) => FieldSet,
  ) => {
    const table = createTable(names[0], seed, onCreate);
    names.forEach(name => tables.set(name, table));
  };
  const quoteRecords = [record('rec_local_quote_1', quoteFields)];
  register(['Quotes'], quoteRecords);
  register(['Customers'], [record('rec_local_customer_1', {
    'Customer ID': 'L9001',
    'Customer Name': 'TEST-ONLY FICTIONAL CUSTOMER',
    'Phone': '00000000',
    'Email': 'fixture.invalid',
    'Address': 'NO PRODUCTION DATA',
  })]);
  register(['Customers (Active)']);
  register(['Order_2026'], [record('rec_local_order_1', orderFields)], fields => {
    // Production's Final Amount is a computed Airtable field and therefore is
    // intentionally absent from the real write payload. The local adapter has
    // no formula engine, so preserve the already-authoritative source Quote
    // Total instead of independently rounding it a second time.
    const sourceQuoteNumber = String(fields['Source Quote Ref'] || '');
    const sourceQuote = quoteRecords.find(item => item.fields['Quote Number'] === sourceQuoteNumber);
    return sourceQuote
      ? { ...fields, 'Final Amount': sourceQuote.fields['Total'] }
      : fields;
  });
  register(['Order Items'], [record('rec_local_order_item_1', {
    'Item No': 'AUG2699-A',
    'Order': ['rec_local_order_1'],
    'Description': item.description,
    'QTY': 1,
    'Product Amount': 1280,
    'Item Type': item.itemType,
    'For What': item.forWhat,
    'Inter L': item.interL,
    'Inter D': item.interD,
    'Inter H': item.interH,
    'Outer L': item.outerL,
    'Outer D': item.outerD,
    'Outer H': item.outerH,
    'Accessories': item.accessories,
  })]);
  [
    'China Shipments', 'Inquiries', 'Monthly Performance', 'Campaigns', 'Business Expenses',
    'Expense Checklist', 'Monthly Finance', 'Marketing Spend',
  ].forEach(name => register([name]));

  const base = Object.assign(
    (tableName: string) => {
      const table = tables.get(tableName);
      if (!table) {
        const created = createTable(tableName, []);
        tables.set(tableName, created);
        return created;
      }
      return table;
    },
    { _tables: tables },
  );

  const choices = (name: string, values: string[]) => ({
    name,
    type: 'singleSelect',
    options: { choices: values.map(value => ({ name: value })) },
  });
  const sharedFields = [
    choices('Promotion / Offer Type', ['首次落單優惠', '舊客戶優惠']),
    choices('Delivery Offer Reason', ['首次落單優惠', '加碼優惠']),
  ];
  const metadataTables = [
    { id: 'tbl_local_quotes', name: 'Quotes', fields: sharedFields },
    { id: 'tbl_local_orders', name: 'Order_2026', fields: sharedFields },
    { id: 'tbl_local_items', name: 'Order Items', fields: [] },
    { id: 'tbl_local_customers', name: 'Customers', fields: [] },
  ];

  return {
    base,
    metadataTables,
    installQuotationImageRuntime(runtime, options = {}) {
      localStorage = options.storage ? undefined : new LocalTestQuotationImageStorage();
      const selectedStorage = options.storage || localStorage!;
      const renderer = browserRenderer || new FixtureQuotationImageRenderer({
        bytes: png,
        mimeType: 'image/png',
        width: 1280,
        height: 1280,
      });
      runtime.coordinator = new QuotationImageCoordinator(renderer, selectedStorage, {
        timeoutMs: browserRenderer ? 30_000 : 2_000,
        maxAttempts: 2,
      });
      runtime.jobScheduler = {
        enqueue(task) {
          queueMicrotask(() => { void task(); });
        },
      };
      runtime.metadataWriter = {
        async update(input) {
          const quoteTable = tables.get('Quotes');
          if (!quoteTable) throw new Error('Local Quote fixture table is missing.');
          const quote = await quoteTable.find(input.quoteRecordId);
          const items = JSON.parse(String(quote.fields['Quote Items JSON'] || '[]')) as Array<Record<string, unknown>>;
          const updated = items.map(storedItem => storedItem.item_id === input.itemId
            ? { ...storedItem, quotation_image: input.metadata }
            : storedItem);
          await quoteTable.update([{ id: quote.id, fields: { 'Quote Items JSON': JSON.stringify(updated) } }]);
        },
      };
      runtime.presentationResolver = options.presentationResolver || {
        async resolve(resolvedAssetKey) {
          const match = resolvedAssetKey.match(/^quotation-images\/([a-f0-9]{64})\.png$/);
          if (!match) throw new Error('Unexpected local fixture asset key.');
          return {
            src: `/__test-only/quotation-images/${match[1]}.png`,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          };
        },
      };
    },
    assetStore: {
      pathPrefix: '/__test-only/quotation-images/',
      resolve(digest) {
        if (!/^[a-f0-9]{64}$/.test(digest)) return undefined;
        const resolvedAssetKey = `quotation-images/${digest}.png`;
        const dynamic = localStorage?.get(resolvedAssetKey);
        if (dynamic) return dynamic;
        return resolvedAssetKey === assetKey ? new Uint8Array(png) : undefined;
      },
    },
    ...(browserBridge ? { browserBridge } : {}),
    urls: {
      create: '/quote/create',
      share: `/quote/${LOCAL_QUOTE_TOKEN}`,
      invoice: `/invoice/${LOCAL_INVOICE_TOKEN}`,
    },
  };
};
