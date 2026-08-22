import express, { type Express } from 'express';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  FakeQuotationImageRenderer,
  FixtureQuotationImageRenderer,
  LocalTestQuotationImageStorage,
  QuotationImageCoordinator,
  QuotationImageError,
  buildQuotationRenderRequestFromQuoteItem,
  prepareNewQuoteItemsWithQuotationImages,
  resolveQuotationImagePresentation,
  type QuotationImagePresentation,
  type QuotationImagePresentationResolver,
  type QuoteItemWithQuotationImage,
  type RenderRequestV1,
} from './quotation-image';

export const LOCAL_QUOTE_ITEM_ID = '80eac55e-53a2-4d2e-b5d7-329329e2e4e9';

type LocalPreviewEvidence = {
  quoteItem: QuoteItemWithQuotationImage;
  presentation: QuotationImagePresentation;
  renderRequest: RenderRequestV1;
  rendererCalls: number;
  storedAssets: number;
  failOpen: {
    state: string;
    priceBefore: number;
    priceAfter: number;
    presentationSuppressed: boolean;
  };
};

const fixtureQuoteItem = (): QuoteItemWithQuotationImage => ({
  item_id: LOCAL_QUOTE_ITEM_ID,
  itemType: 'Display box 展示盒',
  forWhat: 'FICTIONAL LOCAL FIXTURE',
  interL: '28',
  interD: '18',
  interH: '21',
  outerL: '30',
  outerD: '20',
  outerH: '22',
  accessories: ['背板鏡面'],
  accessoryQty: { '背板鏡面': 1 },
  description: 'Test-only quotation image integration fixture',
  qty: 1,
  amount: 4280,
  freight: 0,
  hongKongDelivery: 0,
  profit: 0,
});

const htmlEscape = (value: unknown): string => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

const pngDimensions = (bytes: Buffer): { width: number; height: number } => {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature) || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('Local fixture must be a valid PNG with an IHDR header.');
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
};

const forbiddenRendererPayloadKey = (key: string): boolean => {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalized === 'showprice') return false;
  return ['customer', 'phone', 'email', 'address', 'token', 'price', 'amount', 'total', 'profit', 'freight']
    .some(part => normalized.includes(part));
};

const assertRendererPayloadSafe = (value: unknown): void => {
  if (Array.isArray(value)) return value.forEach(assertRendererPayloadSafe);
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (forbiddenRendererPayloadKey(key)) throw new Error(`Renderer payload contains forbidden key: ${key}`);
    assertRendererPayloadSafe(nested);
  }
};

const pageShell = (title: string, active: string, body: string): string => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${htmlEscape(title)} · LKS Local Fixture</title>
  <style>
    :root { color-scheme: light; --ink:#172033; --muted:#64748b; --line:#dbe3ee; --brand:#d8833b; --ok:#087d55; --bg:#f3f6fa; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif; color:var(--ink); background:var(--bg); }
    header { background:#111827; color:white; padding:18px 28px; display:flex; align-items:center; justify-content:space-between; gap:20px; }
    header strong { letter-spacing:.04em; }
    header span { font-size:12px; color:#cbd5e1; }
    nav { display:flex; gap:8px; flex-wrap:wrap; }
    nav a { color:#334155; background:white; border:1px solid var(--line); border-radius:999px; text-decoration:none; padding:9px 14px; font-size:13px; }
    nav a[data-active="true"] { background:#172033; color:white; border-color:#172033; }
    main { width:min(1160px,calc(100% - 32px)); margin:24px auto 48px; }
    .topline { display:flex; align-items:flex-start; justify-content:space-between; gap:18px; margin-bottom:18px; }
    .eyebrow { color:var(--brand); font-size:12px; font-weight:800; letter-spacing:.12em; text-transform:uppercase; }
    h1 { margin:5px 0 4px; font-size:28px; }
    .muted { color:var(--muted); font-size:13px; }
    .badge { display:inline-flex; align-items:center; padding:7px 10px; border-radius:999px; background:#e7f7f0; color:var(--ok); font-size:12px; font-weight:750; white-space:nowrap; }
    .grid { display:grid; grid-template-columns:minmax(0,1.25fr) minmax(300px,.75fr); gap:20px; }
    .card { background:white; border:1px solid var(--line); border-radius:14px; box-shadow:0 8px 24px rgba(15,23,42,.055); overflow:hidden; }
    .card-head { padding:16px 18px; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:14px; align-items:center; }
    .card-body { padding:18px; }
    .image-wrap { background:linear-gradient(145deg,#f8fbff,#e8eef6); padding:18px; text-align:center; }
    .image-wrap img { display:block; width:min(100%,620px); aspect-ratio:1; object-fit:contain; margin:auto; border-radius:10px; background:white; }
    table { width:100%; border-collapse:collapse; font-size:13px; }
    th,td { text-align:left; padding:10px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
    th { color:var(--muted); font-weight:650; width:42%; }
    .total { font-size:24px; font-weight:850; text-align:right; margin-top:16px; }
    .checks { display:grid; gap:10px; }
    .check { border:1px solid var(--line); border-radius:10px; padding:12px; display:flex; gap:10px; align-items:flex-start; }
    .check b { color:var(--ok); }
    code { overflow-wrap:anywhere; font-size:11px; color:#475569; }
    .notice { margin-top:18px; padding:12px 14px; background:#fff7ed; border:1px solid #fed7aa; border-radius:10px; color:#9a3412; font-size:12px; }
    @media (max-width:800px) { .grid { grid-template-columns:1fr; } .topline { flex-direction:column; } }
  </style>
</head>
<body>
  <header><strong>LKS QUOTE · LOCAL TEST</strong><span>Fixture-only · No Airtable · No Production</span></header>
  <main>
    <nav>
      <a href="/internal/quote-create" data-active="${active === 'create'}">Quote creation</a>
      <a href="/share/test-only" data-active="${active === 'share'}">Customer share</a>
      <a href="/invoice/test-only" data-active="${active === 'invoice'}">Invoice</a>
    </nav>
    ${body}
  </main>
</body>
</html>`;

const imageAndItem = (evidence: LocalPreviewEvidence, mode: 'create' | 'share' | 'invoice'): string => {
  const item = evidence.quoteItem as Record<string, unknown>;
  const heading = mode === 'create' ? 'Quote creation preview' : mode === 'share' ? 'Quotation Q-LOCAL-0001' : 'Invoice INV-LOCAL-0001';
  const subheading = mode === 'create'
    ? 'Internal fixture review before any authoritative write'
    : mode === 'share'
      ? 'Customer-facing fixture presentation'
      : 'Converted invoice fixture using the same immutable item identity';
  return `
    <section class="topline">
      <div><div class="eyebrow">${mode === 'create' ? 'Internal' : mode === 'share' ? 'Public share model' : 'Invoice model'}</div><h1>${heading}</h1><div class="muted">${subheading}</div></div>
      <div class="badge">Image ready · 1280 × 1280 PNG</div>
    </section>
    <section class="grid">
      <article class="card">
        <div class="card-head"><strong>Display box 展示盒</strong><span class="muted">Item 1</span></div>
        <div class="image-wrap"><img src="${htmlEscape(evidence.presentation.src)}" alt="${htmlEscape(evidence.presentation.alt)}"></div>
        <div class="card-body">
          <table>
            <tr><th>Immutable item_id</th><td><code>${htmlEscape(item.item_id)}</code></td></tr>
            <tr><th>Internal dimensions</th><td>28 × 18 × 21 cm</td></tr>
            <tr><th>Outer dimensions</th><td>30 × 20 × 22 cm</td></tr>
            <tr><th>Accessories</th><td>背板鏡面</td></tr>
            <tr><th>Quantity</th><td>1</td></tr>
            <tr><th>Quotation image state</th><td>${htmlEscape(item.quotation_image && (item.quotation_image as Record<string, unknown>).state)}</td></tr>
          </table>
          <div class="total">HKD $4,280</div>
        </div>
      </article>
      <aside class="card">
        <div class="card-head"><strong>Local E2E evidence</strong></div>
        <div class="card-body checks">
          <div class="check"><b>✓</b><div><strong>Same item identity</strong><br><code>${htmlEscape(item.item_id)}</code></div></div>
          <div class="check"><b>✓</b><div><strong>Same durable asset key</strong><br><code>${htmlEscape((item.quotation_image as Record<string, unknown>).asset_key)}</code></div></div>
          <div class="check"><b>✓</b><div><strong>Renderer payload sanitised</strong><br><span class="muted">No customer data, token, price, amount, total, profit or freight.</span></div></div>
          <div class="check"><b>✓</b><div><strong>Price unchanged</strong><br><span class="muted">Before HKD $4,280 · After HKD $4,280</span></div></div>
          <div class="check"><b>✓</b><div><strong>Fail-open verified</strong><br><span class="muted">Failed render state does not block Quote and produces no broken image.</span></div></div>
        </div>
      </aside>
    </section>
    <div class="notice">LOCAL TEST FIXTURE ONLY — no customer data, no real Quote token, no Airtable write, no Production provider and no deployment.</div>`;
};

export const buildLocalQuotationImageEvidence = async (fixturePath: string): Promise<{
  evidence: LocalPreviewEvidence;
  storage: LocalTestQuotationImageStorage;
}> => {
  if (!path.isAbsolute(fixturePath)) throw new Error('Use an absolute --fixture path.');
  const bytes = readFileSync(fixturePath);
  const dimensions = pngDimensions(bytes);
  if (dimensions.width !== 1280 || dimensions.height !== 1280) {
    throw new Error(`Fixture must be 1280 x 1280; received ${dimensions.width} x ${dimensions.height}.`);
  }

  const original = fixtureQuoteItem();
  const renderRequest = buildQuotationRenderRequestFromQuoteItem(original);
  if (!renderRequest) throw new Error('Fixture Quote Item did not produce a render request.');
  assertRendererPayloadSafe(renderRequest);
  if (renderRequest.show_price !== false) throw new Error('Local render request must force show_price:false.');

  const renderer = new FixtureQuotationImageRenderer({
    bytes,
    mimeType: 'image/png',
    width: 1280,
    height: 1280,
  });
  const storage = new LocalTestQuotationImageStorage();
  const coordinator = new QuotationImageCoordinator(renderer, storage, {
    now: () => '2026-08-22T16:00:00.000Z',
  });
  const [quoteItem] = await prepareNewQuoteItemsWithQuotationImages([original], { enabled: true, coordinator });
  if (quoteItem.quotation_image?.state !== 'ready' || !quoteItem.quotation_image.asset_key) {
    throw new Error('Local fixture image did not reach ready state.');
  }

  const resolver: QuotationImagePresentationResolver = {
    async resolve(assetKey) {
      return { src: `/assets/${assetKey}`, expiresAt: '2099-01-01T00:00:00.000Z' };
    },
  };
  const presentation = await resolveQuotationImagePresentation(quoteItem, resolver);
  if (!presentation) throw new Error('Ready fixture image did not resolve to a safe presentation.');

  const failureRenderer = new FakeQuotationImageRenderer(async () => {
    throw new QuotationImageError('Deliberate local fixture failure.', 'temporary');
  });
  const failureCoordinator = new QuotationImageCoordinator(failureRenderer, new LocalTestQuotationImageStorage(), {
    maxAttempts: 1,
  });
  const [failedItem] = await prepareNewQuoteItemsWithQuotationImages([original], {
    enabled: true,
    coordinator: failureCoordinator,
  });
  const failedPresentation = await resolveQuotationImagePresentation(failedItem, resolver);
  const priceBefore = Number(original.amount);
  const priceAfter = Number(failedItem.amount);
  if (priceBefore !== priceAfter || failedPresentation !== null) throw new Error('Fail-open evidence failed.');

  return {
    storage,
    evidence: {
      quoteItem,
      presentation,
      renderRequest,
      rendererCalls: renderer.calls,
      storedAssets: storage.size,
      failOpen: {
        state: String(failedItem.quotation_image?.state || 'missing'),
        priceBefore,
        priceAfter,
        presentationSuppressed: failedPresentation === null,
      },
    },
  };
};

export const createLocalQuotationImagePreviewApp = async (fixturePath: string): Promise<{
  app: Express;
  evidence: LocalPreviewEvidence;
}> => {
  const { evidence, storage } = await buildLocalQuotationImageEvidence(fixturePath);
  const app = express();
  app.disable('x-powered-by');
  app.get('/', (_req, res) => res.redirect('/internal/quote-create'));
  app.get('/internal/quote-create', (_req, res) => res.type('html').send(pageShell(
    'Quote creation preview', 'create', imageAndItem(evidence, 'create'),
  )));
  app.get('/share/test-only', (_req, res) => res.type('html').send(pageShell(
    'Customer share', 'share', imageAndItem(evidence, 'share'),
  )));
  app.get('/invoice/test-only', (_req, res) => res.type('html').send(pageShell(
    'Invoice', 'invoice', imageAndItem(evidence, 'invoice'),
  )));
  app.get('/assets/quotation-images/:digest.png', (req, res) => {
    if (!/^[a-f0-9]{64}$/.test(req.params.digest)) return res.status(404).end();
    const bytes = storage.get(`quotation-images/${req.params.digest}.png`);
    if (!bytes) return res.status(404).end();
    res.setHeader('Cache-Control', 'no-store');
    return res.type('png').send(Buffer.from(bytes));
  });
  app.get('/evidence.json', (_req, res) => res.json({
    fixture_only: true,
    production: false,
    airtable_writes: 0,
    item_id: evidence.quoteItem.item_id,
    quotation_image: evidence.quoteItem.quotation_image,
    renderer_calls: evidence.rendererCalls,
    stored_assets: evidence.storedAssets,
    render_request: evidence.renderRequest,
    fail_open: evidence.failOpen,
  }));
  return { app, evidence };
};

const argument = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length);
};

if (require.main === module) {
  const fixturePath = argument('fixture');
  const port = Number(argument('port') || 4319);
  if (!fixturePath) throw new Error('Usage: npm run preview:quotation-image -- --fixture=/absolute/1280x1280.png [--port=4319]');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Local preview port is invalid.');
  createLocalQuotationImagePreviewApp(fixturePath).then(({ app, evidence }) => {
    app.listen(port, '127.0.0.1', () => {
      console.log(`LKS Quote local fixture preview: http://127.0.0.1:${port}/internal/quote-create`);
      console.log(`Item: ${evidence.quoteItem.item_id}`);
      console.log(`Image: ${evidence.quoteItem.quotation_image?.state} · ${evidence.quoteItem.quotation_image?.asset_key}`);
      console.log('Boundaries: fixture-only, no Airtable, no Production, no deployment.');
    });
  }).catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
