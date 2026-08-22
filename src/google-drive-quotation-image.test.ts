import assert from 'node:assert/strict';
import express from 'express';
import test from 'node:test';
import {
  GOOGLE_DRIVE_QUOTATION_IMAGE_OAUTH_SCOPE,
  GoogleDriveQuotationImageProxy,
  GoogleDriveQuotationImageStorage,
  GoogleOAuthRefreshTokenProvider,
  createGoogleDriveQuotationImageProviderFromEnvironment,
  registerGoogleDriveQuotationImageProxy,
  type GoogleDriveAccessTokenProvider,
} from './google-drive-quotation-image';
import {
  FixtureQuotationImageRenderer,
  QuotationImageCoordinator,
} from './quotation-image';

const DIGEST = 'a'.repeat(64);
const ASSET_KEY = `quotation-images/${DIGEST}.png`;
const IDEMPOTENCY_KEY = `sha256:${DIGEST}`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const FILE_ID = 'drive_file_12345678';

class StaticTokenProvider implements GoogleDriveAccessTokenProvider {
  invalidations = 0;
  async getAccessToken(): Promise<string> { return 'mock-access-token'; }
  invalidateAccessToken(): void { this.invalidations += 1; }
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const privateFile = () => ({
  id: FILE_ID,
  name: `quotation-image-${DIGEST}.png`,
  mimeType: 'image/png',
  trashed: false,
  appProperties: {
    lks_contract: 'quotation-image-v1',
    lks_asset_digest: DIGEST,
  },
  permissions: [{ type: 'user', role: 'owner' }],
});

test('personal My Drive adapter creates one private, sanitized file for concurrent duplicate writes', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.includes('/drive/v3/files?') && init.method === 'GET') return json({ files: [] });
    if (url.includes('/upload/drive/v3/files') && init.method === 'POST') return json({ id: FILE_ID });
    if (url.includes(`/drive/v3/files/${FILE_ID}?fields=`) && init.method === 'GET') return json(privateFile());
    throw new Error(`Unexpected mock Drive request: ${init.method} ${url}`);
  };
  const storage = new GoogleDriveQuotationImageStorage({
    accessTokenProvider: new StaticTokenProvider(),
    fetch: fetchMock,
    retryDelay: async () => {},
  });
  const input = { assetKey: ASSET_KEY, idempotencyKey: IDEMPOTENCY_KEY, bytes: PNG, mimeType: 'image/png' as const };
  const [first, duplicate] = await Promise.all([storage.put(input), storage.put(input)]);
  assert.deepEqual(first, { assetKey: ASSET_KEY });
  assert.deepEqual(duplicate, first);
  assert.equal(requests.filter(request => request.url.includes('/upload/drive/v3/files')).length, 1);

  const upload = requests.find(request => request.url.includes('/upload/drive/v3/files'))!;
  const uploadText = Buffer.from(upload.init.body as Uint8Array).toString('latin1');
  assert.match(uploadText, new RegExp(`quotation-image-${DIGEST}\\.png`));
  assert.match(uploadText, /"lks_contract":"quotation-image-v1"/);
  assert.match(uploadText, new RegExp(`"lks_asset_digest":"${DIGEST}"`));
  assert.doesNotMatch(uploadText, /permissions|anyone|customer|phone|email|address|quote.?token|public.?token|price|amount|payment/i);
  assert.ok(requests.every(request => String(new Headers(request.init.headers).get('Authorization')) === 'Bearer mock-access-token'));
  assert.ok(requests.every(request => !request.url.includes('/permissions')));
});

test('existing deterministic Drive file is reused and private content is read through the proxy', async () => {
  let now = 1_000_000;
  let uploadCalls = 0;
  const fetchMock: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('/drive/v3/files?') && init.method === 'GET') return json({ files: [{ id: FILE_ID }] });
    if (url.includes(`/drive/v3/files/${FILE_ID}?fields=`)) return json(privateFile());
    if (url.includes(`/drive/v3/files/${FILE_ID}?alt=media`)) {
      return new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } });
    }
    if (url.includes('/upload/drive/v3/files')) uploadCalls += 1;
    throw new Error(`Unexpected mock Drive request: ${init.method} ${url}`);
  };
  const storage = new GoogleDriveQuotationImageStorage({
    accessTokenProvider: new StaticTokenProvider(),
    fetch: fetchMock,
    retryDelay: async () => {},
  });
  assert.deepEqual(await storage.put({
    assetKey: ASSET_KEY,
    idempotencyKey: IDEMPOTENCY_KEY,
    bytes: PNG,
    mimeType: 'image/png',
  }), { assetKey: ASSET_KEY });
  assert.equal(uploadCalls, 0);

  const proxy = new GoogleDriveQuotationImageProxy(storage, {
    signingSecret: 'mock-only-signing-secret-with-at-least-32-bytes',
    ttlSeconds: 60,
    now: () => now,
  });
  const presentation = await proxy.presentationResolver.resolve(ASSET_KEY, { itemId: 'unused' });
  assert.match(presentation.src, /^\/quotation-images\/google-drive\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(presentation.src.includes(FILE_ID), false);
  assert.deepEqual(Buffer.from(await proxy.read(presentation.src.split('/').pop()!)), PNG);

  const [encoded, signature] = presentation.src.split('/').pop()!.split('.');
  await assert.rejects(proxy.read(`${encoded}.${signature.slice(0, -1)}A`), /invalid/);
  now += 61_000;
  await assert.rejects(proxy.read(`${encoded}.${signature}`), /expired/);
});

test('same-origin proxy route returns only private no-store PNG responses', async t => {
  const storage = { read: async () => new Uint8Array(PNG) } as unknown as GoogleDriveQuotationImageStorage;
  const proxy = new GoogleDriveQuotationImageProxy(storage, {
    signingSecret: 'mock-only-signing-secret-with-at-least-32-bytes',
    ttlSeconds: 60,
    now: () => 1_000_000,
  });
  const app = express();
  registerGoogleDriveQuotationImageProxy(app, proxy);
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const presentation = await proxy.presentationResolver.resolve(ASSET_KEY, { itemId: 'unused' });
  const response = await fetch(`http://127.0.0.1:${address.port}${presentation.src}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(response.headers.get('content-disposition'), 'inline; filename="quotation-image.png"');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  const rejected = await fetch(`http://127.0.0.1:${address.port}/quotation-images/google-drive/tampered`);
  assert.equal(rejected.status, 404);
});

test('Drive adapter rejects shared files and retries only temporary responses within the bound', async () => {
  let calls = 0;
  const tokenProvider = new StaticTokenProvider();
  const fetchMock: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    calls += 1;
    if (calls === 1) return json({ error: 'temporary' }, 503);
    if (url.includes('/drive/v3/files?')) return json({ files: [{ id: FILE_ID }] });
    if (url.includes(`/drive/v3/files/${FILE_ID}?fields=`)) {
      return json({ ...privateFile(), permissions: [{ type: 'anyone', role: 'reader' }] });
    }
    throw new Error(`Unexpected mock Drive request: ${init.method} ${url}`);
  };
  const storage = new GoogleDriveQuotationImageStorage({
    accessTokenProvider: tokenProvider,
    fetch: fetchMock,
    maxAttempts: 3,
    retryDelay: async () => {},
  });
  await assert.rejects(storage.read(ASSET_KEY), /not a private quotation image/);
  assert.equal(calls, 3);
});

test('exhausted Drive failures remain fail-open through the quotation coordinator', async () => {
  const fetchMock: typeof fetch = async () => json({ error: 'temporary' }, 503);
  const storage = new GoogleDriveQuotationImageStorage({
    accessTokenProvider: new StaticTokenProvider(),
    fetch: fetchMock,
    maxAttempts: 2,
    retryDelay: async () => {},
  });
  const coordinator = new QuotationImageCoordinator(
    new FixtureQuotationImageRenderer({ bytes: PNG, mimeType: 'image/png', width: 1280, height: 1280 }),
    storage,
    { maxAttempts: 1 },
  );
  const metadata = await coordinator.process('9e4f6e72-d31a-4d1a-8d15-730282c1b102', {
    purpose: 'quotation',
    product_type: 'display_box',
    dimensions: {
      unit: 'cm',
      inner: { length: 28, depth: 18, height: 21 },
      outer: { length: 30, depth: 20, height: 22 },
      actual: { length: 30, depth: 20, height: 22 },
    },
    cabinet_layers: [],
    accessories: [],
    colours: { body: 'clear_acrylic', background: 'light_blue_gray' },
    camera_preset: 'quotation_square_three_quarter_v2',
    output: { width: 1280, height: 1280, background: 'configured' },
    branding: { enabled: false, style: 'none' },
    show_dimensions: true,
    show_price: false,
  });
  assert.equal(metadata.state, 'failed');
  assert.equal(metadata.error_class, 'temporary');
});

test('OAuth user refresh token provider caches short-lived access tokens without exposing credentials', async () => {
  let calls = 0;
  const bodies: string[] = [];
  const fetchMock: typeof fetch = async (_input, init = {}) => {
    calls += 1;
    bodies.push(String(init.body));
    return json({ access_token: 'mock-short-lived-access-token', expires_in: 3600 });
  };
  const provider = new GoogleOAuthRefreshTokenProvider({
    clientId: 'mock-client-id',
    clientSecret: 'mock-client-secret',
    refreshToken: 'mock-refresh-token',
    fetch: fetchMock,
    now: () => 1_000_000,
  });
  assert.equal(await provider.getAccessToken(), 'mock-short-lived-access-token');
  assert.equal(await provider.getAccessToken(), 'mock-short-lived-access-token');
  assert.equal(calls, 1);
  assert.match(bodies[0], /grant_type=refresh_token/);
  assert.equal(GOOGLE_DRIVE_QUOTATION_IMAGE_OAUTH_SCOPE, 'https://www.googleapis.com/auth/drive.file');
});

test('Google Drive provider stays disabled by default and fails closed on incomplete credential env', () => {
  assert.equal(createGoogleDriveQuotationImageProviderFromEnvironment({}), null);
  assert.throws(() => createGoogleDriveQuotationImageProviderFromEnvironment({
    QUOTATION_IMAGE_STORAGE_PROVIDER: 'google_drive',
  }), /GOOGLE_DRIVE_OAUTH_CLIENT_ID/);
  const configured = createGoogleDriveQuotationImageProviderFromEnvironment({
    QUOTATION_IMAGE_STORAGE_PROVIDER: 'google_drive',
    GOOGLE_DRIVE_OAUTH_CLIENT_ID: 'mock-client-id',
    GOOGLE_DRIVE_OAUTH_CLIENT_SECRET: 'mock-client-secret',
    GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN: 'mock-refresh-token',
    QUOTATION_IMAGE_PROXY_SIGNING_SECRET: 'mock-only-signing-secret-with-at-least-32-bytes',
  });
  assert.ok(configured?.storage);
  assert.ok(configured?.proxy);
});
