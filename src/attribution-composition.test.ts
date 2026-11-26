import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AddressInfo } from 'node:net';
import { createQuoteApp } from './index';
import {
  AttributionCompositionInput,
  attributionConfigurationFailure,
  composeAttribution,
  isDistinctMountDevice,
  loadApprovedAttributionDeploymentFile,
  readAttributionProofKeyFile,
} from './attribution-composition';
import { LocalAttributionStore } from './attribution-store';
import { createLocalQuoteFixtureWithOptions } from './test-only/local-quote-fixture';
import { SyntheticAirtableClient, syntheticProjectionMapping } from './test-only/attribution-projection-fixture';

const webOrigin = 'https://lksdisplaybox.online';
const touch = {
  observedAt: '2026-01-01T00:00:00Z', channel: 'direct', source: '(direct)', medium: '(none)',
  campaignKey: null, landingPath: '/', evidence: 'direct_observed', confidence: 'signal_limited',
};
const handoff = {
  contractVersion: '1.0.0', requestId: `ar_v1_${'a'.repeat(32)}`, attributionId: `aid_v1_${'b'.repeat(32)}`,
  firstTouch: touch, lastTouch: touch, entrySurface: 'wordpress',
  consent: { ad_storage: 'granted', analytics_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted' },
};
const attributionTable = 'Attr Attributions';
const mapping = () => ({
  ...syntheticProjectionMapping(),
  tables: {
    attributions: attributionTable, inquiries: 'Inquiries', quotes: 'Quotes', orders: 'Order_2026',
  },
  campaigns: new Map<string, { source: string; recordId: string }>(),
});

const harness = async (t: test.TestContext) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lks-attribution-composition-')));
  const png = path.join(dir, 'fixture.png');
  const json = path.join(dir, 'fixture.json');
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  fs.writeFileSync(json, JSON.stringify({
    width: 1280, height: 1280, stateRestored: true,
    request: {
      purpose: 'quotation', product_type: 'display_box',
      dimensions: {
        unit: 'mm', inner: { length: 280, depth: 180, height: 210 },
        outer: { length: 300, depth: 200, height: 220 }, actual: { length: 300, depth: 200, height: 220 },
      },
      cabinet_layers: [], accessories: [], colours: { body: 'clear_acrylic', background: 'light_blue_gray' },
      camera_preset: 'quotation_square_three_quarter_v2', output: { width: 1280, height: 1280, background: 'configured' },
      branding: { enabled: false, style: 'none' }, show_dimensions: true, show_price: false,
    },
  }));
  const fixture = createLocalQuoteFixtureWithOptions({ pngPath: png, metadataPath: json });
  const synthetic = new SyntheticAirtableClient();
  const base = Object.assign(
    (name: string) => name === attributionTable ? synthetic.table(name) : fixture.base(name),
    { _tables: fixture.base._tables },
  );
  const runtime = createQuoteApp({
    environment: {
      NODE_ENV: 'test', PUBLIC_BASE_URL: 'http://127.0.0.1', QUOTATION_IMAGE_ENABLED: '0',
      ADMIN_USERNAME: 'lks', ADMIN_PASSWORD: 'test-password', SESSION_SECRET: 's'.repeat(64),
    },
    localFixture: { ...fixture, base } as typeof fixture,
  });
  const server = runtime.app.listen(0, '127.0.0.1');
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const reports: string[] = [];
  const input = (overrides: Partial<AttributionCompositionInput> = {}): Omit<AttributionCompositionInput, 'tables'> => ({
    enabled: true,
    storePath: path.join(dir, 'attribution.sqlite'),
    pathPolicy: { kind: 'test', directory: dir },
    exclusiveWriterConfirmed: true,
    proofKey: () => Buffer.alloc(32, 7),
    mapping: mapping(),
    publicPaths: ['/'],
    campaignKeys: [],
    nodeVersion: process.version,
    now: () => Date.parse('2026-01-01T00:00:00Z'),
    report: message => reports.push(message),
    ...overrides,
  });
  return { dir, runtime, origin, reports, input, synthetic };
};

const login = async (origin: string) => {
  const response = await fetch(`${origin}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'lks', password: 'test-password', next: '/quotes' }),
  });
  assert.equal(response.status, 303);
  const cookie = String(response.headers.get('set-cookie') || '').split(';')[0];
  const html = await (await fetch(`${origin}/quotes`, { headers: { Cookie: cookie } })).text();
  const csrf = html.match(/name="csrf" value="([a-f0-9]{64})"/)?.[1];
  assert.ok(csrf);
  return { cookie, csrf };
};

const create = (origin: string, body: unknown = handoff, from = webOrigin) => fetch(`${origin}/api/attribution/v1/handoffs`, {
  method: 'POST',
  headers: { Origin: from, 'Content-Type': 'application/json', 'Idempotency-Key': (body as { requestId: string }).requestId },
  body: JSON.stringify(body),
});

const deploymentDocument = (dir: string) => {
  const value = mapping();
  return {
    schemaVersion: 'attribution-deployment-v1',
    requiredNodeVersion: process.version,
    storePath: path.join(dir, 'attribution.sqlite'),
    mountPath: dir,
    exclusiveWriterConfirmed: true,
    writerMode: 'single-process',
    publicPaths: ['/'],
    campaignKeys: [],
    mapping: { ...value, campaigns: Object.fromEntries(value.campaigns) },
  };
};

test('disabled composition touches no provider, key, path, store or route', async t => {
  const { dir, runtime, origin, reports, input } = await harness(t);
  const forbidden = () => { throw new Error('must not be called'); };
  const result = runtime.activateAttribution(input({
    enabled: false, proofKey: forbidden, storePath: '/never/opened.sqlite', mapping: null,
    now: forbidden, publicPaths: forbidden as unknown as string[],
  }));
  assert.equal(result, null);
  assert.deepEqual(reports, []);
  assert.deepEqual(fs.readdirSync(dir).filter(name =>
    name.endsWith('.sqlite') && fs.lstatSync(path.join(dir, name)).isFile()), []);
  assert.equal((await create(origin)).status, 404);
  assert.equal((await fetch(`${origin}/admin/attribution/v1/resolve`, { method: 'POST' })).status, 404);
  assert.equal(composeAttribution({ ...input({ enabled: false }), tables: forbidden }), null);
});

test('enabled composition mounts the real router, binds through owner flow and keeps owner protections', async t => {
  const { dir, runtime, origin, reports, input, synthetic } = await harness(t);
  const projector = runtime.activateAttribution(input());
  assert.ok(projector);
  assert.deepEqual(reports, []);
  const created = await create(origin);
  assert.equal(created.status, 201);
  const receipt = await created.json() as { shortCode: string };
  assert.match(receipt.shortCode, /^LKS-[0-9A-Z]{16}$/);
  assert.equal((await create(origin)).status, 200);
  assert.equal((await create(origin, { ...handoff, entrySurface: 'configurator' })).status, 409);
  assert.equal((await create(origin, handoff, 'https://evil.example.test')).status, 403);

  const resolveBody = JSON.stringify({ contractVersion: '1.0.0', shortCode: receipt.shortCode });
  const { cookie, csrf } = await login(origin);
  const resolve = (headers: Record<string, string>) => fetch(`${origin}/admin/attribution/v1/resolve`, {
    method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', ...headers }, body: resolveBody,
  });
  assert.notEqual((await resolve({})).status, 200);
  assert.equal((await resolve({ Cookie: cookie, Origin: 'https://evil.example.test', 'X-CSRF-Token': csrf })).status, 403);
  assert.equal((await resolve({ Cookie: cookie, Origin: origin, 'X-CSRF-Token': 'invalid' })).status, 403);
  const resolved = await resolve({ Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf });
  assert.equal(resolved.status, 200);
  assert.equal(((await resolved.json()) as { outcome: string }).outcome, 'matched');

  const inquiry = await fetch(`${origin}/inquiry/create`, {
    method: 'POST', redirect: 'manual',
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      phone: '91234567', channel: 'Website', attributionCode: `[${receipt.shortCode}]`, forceNew: '1',
    }),
  });
  assert.equal(inquiry.status, 200);
  assert.match(await inquiry.text(), /Automated attribution: matched/);
  const flushed = await projector.flush();
  assert.equal(flushed.failed, false);
  assert.equal(flushed.pending, false);
  assert.ok(synthetic.writes.create >= 1);
  assert.deepEqual(reports, []);
  assert.ok(fs.existsSync(path.join(dir, 'attribution.sqlite')));
});

test('cross-table equal field names are valid but same-object duplicates fail closed', async t => {
  const { dir, runtime, origin, reports, input } = await harness(t);
  const valid = mapping();
  assert.equal(valid.quote.snapshot, valid.order.snapshot);
  const projector = runtime.activateAttribution(input({ mapping: valid }));
  assert.ok(projector);
  assert.equal((await create(origin)).status, 201);

  const duplicate = mapping();
  duplicate.attribution = { ...duplicate.attribution, attributionId: duplicate.attribution.code };
  assert.equal(runtime.activateAttribution(input({
    mapping: duplicate,
    storePath: path.join(dir, 'duplicate.sqlite'),
  })), null);
  assert.deepEqual(reports, [attributionConfigurationFailure]);
});

test('every enabled-configuration failure keeps attribution closed with static text and owner routes working', async t => {
  const { dir, runtime, origin, reports, input } = await harness(t);
  const badMapping = mapping();
  badMapping.attribution = { ...badMapping.attribution, code: '' };
  const duplicate = mapping();
  duplicate.attribution = { ...duplicate.attribution, attributionId: duplicate.attribution.code };
  const link = path.join(dir, 'linked');
  fs.mkdirSync(path.join(dir, 'real'));
  fs.symlinkSync(path.join(dir, 'real'), link);
  const redirectedStore = path.join(dir, 'redirected.sqlite');
  const danglingStore = path.join(dir, 'dangling.sqlite');
  const redirectedWalStore = path.join(dir, 'redirected-wal.sqlite');
  const redirectedShmStore = path.join(dir, 'redirected-shm.sqlite');
  const harmlessFile = path.join(dir, 'harmless');
  fs.writeFileSync(harmlessFile, 'synthetic');
  fs.symlinkSync(harmlessFile, redirectedStore);
  fs.symlinkSync(path.join(dir, 'missing-target'), danglingStore);
  fs.symlinkSync(harmlessFile, `${redirectedWalStore}-wal`);
  fs.symlinkSync(harmlessFile, `${redirectedShmStore}-shm`);
  const cases: Array<Partial<AttributionCompositionInput>> = [
    { mapping: null },
    { mapping: badMapping },
    { mapping: duplicate },
    { mapping: { ...mapping(), surfaces: { wordpress: '', configurator: '3D' } } },
    { campaignKeys: ['unmapped-key'] },
    { publicPaths: [] },
    { publicPaths: ['https://example.test/'] },
    { proofKey: () => Buffer.alloc(31, 1) },
    { proofKey: () => { throw new Error('key-provider-secret'); } },
    { storePath: 'relative.sqlite' },
    { storePath: path.join(dir, 'missing-directory', 'x.sqlite') },
    { storePath: path.join(link, 'x.sqlite'), pathPolicy: { kind: 'test', directory: dir } },
    { storePath: redirectedStore },
    { storePath: danglingStore },
    { storePath: redirectedWalStore },
    { storePath: redirectedShmStore },
    { storePath: path.join(dir, 'x.sqlite'), pathPolicy: { kind: 'production' } },
    { storePath: path.join(dir, 'x.sqlite'), pathPolicy: { kind: 'test', directory: path.join(dir, 'real') } },
    { nodeVersion: 'v22.12.0' },
    { nodeVersion: 'unknown' },
    { limit: { maxRequests: 0, windowMs: 60_000, maxClients: 10 } },
    { limit: { maxRequests: 30, windowMs: 120_000, maxClients: 10 } },
    { exclusiveWriterConfirmed: false },
  ];
  for (const overrides of cases) assert.equal(runtime.activateAttribution(input(overrides)), null);
  assert.equal(reports.length, cases.length);
  assert.ok(reports.every(message => message === attributionConfigurationFailure));
  assert.deepEqual(fs.readdirSync(dir).filter(name =>
    name.endsWith('.sqlite') && fs.lstatSync(path.join(dir, name)).isFile()), []);
  assert.equal((await create(origin)).status, 404);
  const { csrf } = await login(origin);
  assert.ok(csrf);
});

test('production mount guard requires a distinct mounted device and fails closed on missing metadata', () => {
  const devices = new Map<string, number>([['/data', 1], ['/data/lks-attribution', 2]]);
  const deviceOf = (value: string) => {
    const device = devices.get(value);
    if (device === undefined) throw new Error('missing');
    return device;
  };
  assert.equal(isDistinctMountDevice('/data/lks-attribution', deviceOf), true);
  devices.set('/data/lks-attribution', 1);
  assert.equal(isDistinctMountDevice('/data/lks-attribution', deviceOf), false);
  devices.delete('/data/lks-attribution');
  assert.equal(isDistinctMountDevice('/data/lks-attribution', deviceOf), false);
});

test('deployment loader accepts exact private template and rejects schema, runtime, writer and mapping drift', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lks-attribution-deployment-')));
  try {
    const config = path.join(dir, 'deployment.json');
    const original = deploymentDocument(dir);
    fs.writeFileSync(config, JSON.stringify(original), { mode: 0o600 });
    const loaded = loadApprovedAttributionDeploymentFile(config, process.version, { kind: 'test', directory: dir });
    assert.equal(loaded.storePath, original.storePath);
    assert.equal(loaded.mapping.quote.snapshot, loaded.mapping.order.snapshot);
    assert.deepEqual(loaded.campaignKeys, []);

    const invalid = [
      { ...original, unexpected: true },
      { ...original, requiredNodeVersion: 'v22.12.0' },
      { ...original, exclusiveWriterConfirmed: false },
      { ...original, writerMode: 'lease' },
      { ...original, storePath: path.join(dir, 'wrong.db') },
      {
        ...original,
        mapping: {
          ...original.mapping,
          attribution: { ...original.mapping.attribution, attributionId: original.mapping.attribution.code },
        },
      },
    ];
    for (const value of invalid) {
      fs.writeFileSync(config, JSON.stringify(value), { mode: 0o600 });
      assert.throws(() => loadApprovedAttributionDeploymentFile(config, process.version, { kind: 'test', directory: dir }));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writer already uncertain is never recovered and does not block local receipt or binding', async t => {
  const { dir, runtime, origin, reports, input, synthetic } = await harness(t);
  const storePath = path.join(dir, 'attribution.sqlite');
  const prior = new LocalAttributionStore(storePath, Buffer.alloc(32, 7));
  const owner = prior.acquireProjectionWriter();
  prior.markProjectionUncertain(owner);
  prior.close();
  const projector = runtime.activateAttribution(input({ storePath }));
  assert.ok(projector);
  const created = await create(origin);
  assert.equal(created.status, 201);
  const { cookie } = await login(origin);
  const code = ((await created.json()) as { shortCode: string }).shortCode;
  const inquiry = await fetch(`${origin}/inquiry/create`, {
    method: 'POST', redirect: 'manual',
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ phone: '91234568', channel: 'Website', attributionCode: code, forceNew: '1' }),
  });
  assert.equal(inquiry.status, 200);
  assert.match(await inquiry.text(), /Automated attribution: matched/);
  const flushed = await projector.flush();
  assert.equal(flushed.failed, true);
  assert.deepEqual(synthetic.writes, { create: 0, update: 0 });
  assert.ok(reports.every(message => !/secret|LKS-|aid_v1|ar_v1/.test(message)));
  const reopened = new LocalAttributionStore(storePath, Buffer.alloc(32, 7));
  assert.equal(reopened.projectionWriterStatus().state, 'uncertain');
  reopened.close();
});

test('proof-key reader refuses symlinks, wide modes, nonregular and unbounded input', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lks-synthetic-key-'));
  try {
    const key = path.join(dir, 'key.hex');
    fs.writeFileSync(key, `${'ab'.repeat(32)}\n`, { mode: 0o600 });
    assert.equal(readAttributionProofKeyFile(key).length, 32);
    const link = path.join(dir, 'link.hex');
    fs.symlinkSync(key, link);
    assert.throws(() => readAttributionProofKeyFile(link));
    assert.throws(() => readAttributionProofKeyFile(dir));
    assert.throws(() => readAttributionProofKeyFile('key.hex'));
    const wide = path.join(dir, 'wide.hex');
    fs.writeFileSync(wide, 'ab'.repeat(32), { mode: 0o644 });
    fs.chmodSync(wide, 0o644);
    assert.throws(() => readAttributionProofKeyFile(wide));
    const large = path.join(dir, 'large.hex');
    fs.writeFileSync(large, 'ab'.repeat(200), { mode: 0o600 });
    assert.throws(() => readAttributionProofKeyFile(large));
    const bad = path.join(dir, 'bad.hex');
    fs.writeFileSync(bad, 'zz'.repeat(32), { mode: 0o600 });
    assert.throws(() => readAttributionProofKeyFile(bad));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('activation candidate has the exact reviewed two-gate boolean variant and loads durable inputs only inside the gate', () => {
  const source = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8');
  const start = source.indexOf('if (require.main === module)');
  const cli = source.slice(start);
  const normalized = source.replace('const ATTRIBUTION_ACTIVATION_ENABLED = true;', 'const ATTRIBUTION_ACTIVATION_ENABLED = false;').replace('const ATTRIBUTION_SYNTHETIC_ACCEPTANCE_ENABLED = true;', 'const ATTRIBUTION_SYNTHETIC_ACCEPTANCE_ENABLED = false;');
  assert.ok(cli.includes('const ATTRIBUTION_ACTIVATION_ENABLED = true;'));
  assert.equal(createHash('sha256').update(normalized).digest('hex'), '5ebee354f4df55252e3978b47643498e2a511af0ae51c9485a552374299d3ebb');
  assert.ok(cli.includes('if (ATTRIBUTION_ACTIVATION_ENABLED) {'));
  assert.ok(cli.indexOf('loadApprovedAttributionDeploymentFile(') > cli.indexOf('if (ATTRIBUTION_ACTIVATION_ENABLED)'));
  assert.ok(cli.indexOf('runtime.activateAttribution({') > cli.indexOf('loadApprovedAttributionDeploymentFile('));
  assert.ok(cli.indexOf('runtime.activateAttribution({') < cli.indexOf('runtime.start()'));
  for (const required of [
    "pathPolicy: { kind: 'production' }",
    'attributionDeploymentConfigPath',
    'readAttributionProofKeyFile(attributionProofKeyPath)',
    'exclusiveWriterConfirmed: approvedDeployment.exclusiveWriterConfirmed',
  ]) assert.ok(cli.includes(required), required);
  assert.ok(source.includes('composeAttribution({'));
  assert.ok(source.includes('tables: name => base(name)'));
  assert.ok(!/process\.env[^;]*ATTRIBUTION/i.test(source));
});
