import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalAttributionStore } from './attribution-store';
import { validateAttributionRequest, AttributionRequest } from './attribution-validation';
import ts from 'typescript';

const now = Date.parse('2026-01-01T00:00:00Z');
const ttl = 7 * 24 * 60 * 60 * 1000;
const config = { publicPaths: new Set(['/']), campaignKeys: new Set(['demo-campaign']) };
const request = (): AttributionRequest => ({
  contractVersion: '1.0.0', attributionId: `aid_v1_${'a'.repeat(32)}`, requestId: `ar_v1_${'b'.repeat(32)}`,
  firstTouch: {
    observedAt: '2026-01-01T00:00:00Z', channel: 'direct', source: '(direct)', medium: '(none)',
    campaignKey: null, landingPath: '/', evidence: 'direct_observed', confidence: 'signal_limited',
  },
  lastTouch: {
    observedAt: '2026-01-01T00:00:00Z', channel: 'direct', source: '(direct)', medium: '(none)',
    campaignKey: null, landingPath: '/', evidence: 'direct_observed', confidence: 'signal_limited',
  },
  entrySurface: 'wordpress',
  consent: { ad_storage: 'granted', analytics_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted' },
});

const compileWorker = (dir: string): string => {
  const compiled = join(dir, 'worker');
  mkdirSync(join(compiled, 'test-only'), { recursive: true });
  for (const relative of ['attribution-store.ts', 'test-only/attribution-store-worker.ts']) {
    const source = readFileSync(join(__dirname, relative), 'utf8');
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    writeFileSync(join(compiled, relative.replace(/\.ts$/, '.js')), output);
  }
  return join(compiled, 'test-only/attribution-store-worker.js');
};

const barrierWorker = (workerPath: string, databasePath: string) => {
  const child = spawn(process.execPath, [workerPath, databasePath, 'open-barrier'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '';
  let errors = '';
  if (!child.stdout || !child.stderr) throw new Error('Worker output pipes are unavailable.');
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const ready = new Promise<void>((resolve, reject) => {
    child.once('message', () => resolve());
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Worker exited before ready: ${code}`)));
  });
  const result = new Promise<{ outcome: string; shortCode?: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(errors)));
  });
  return { ready, result, start: () => child.send('start') };
};

test('validation rejects extra data, unapproved values, bad chronology and missing consent', () => {
  assert.equal(validateAttributionRequest(request(), config, now).kind, 'valid');
  assert.equal(validateAttributionRequest({ ...request(), gclid: 'synthetic' }, config, now).kind, 'invalid');
  assert.equal(validateAttributionRequest({ ...request(), firstTouch: { ...request().firstTouch, landingPath: '/?query=x' } }, config, now).kind, 'invalid');
  assert.equal(validateAttributionRequest({ ...request(), firstTouch: { ...request().firstTouch, campaignKey: 'not-approved' } }, config, now).kind, 'invalid');
  assert.equal(validateAttributionRequest({ ...request(), firstTouch: { ...request().firstTouch, channel: ['direct'] } }, config, now).kind, 'invalid');
  assert.equal(validateAttributionRequest({ ...request(), firstTouch: { ...request().firstTouch, observedAt: '2026-01-01T00:00:01Z' } }, config, now).kind, 'invalid');
  assert.equal(validateAttributionRequest({ ...request(), firstTouch: { ...request().firstTouch, observedAt: '2026-01-01T00:05:01Z' }, lastTouch: { ...request().lastTouch, observedAt: '2026-01-01T00:05:01Z' } }, config, now).kind, 'invalid');
  assert.equal(validateAttributionRequest({ ...request(), consent: { ...request().consent, ad_storage: 'denied' } }, config, now).kind, 'consent_unavailable');
});

test('receipt reopens, conflicts, expires exactly and handles code collisions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'attribution-test-'));
  try {
    const path = join(dir, 'store.sqlite');
    let store = new LocalAttributionStore(path, Buffer.alloc(32, 7), () => 'LKS-0000000000000000');
    const first = store.create(request(), now);
    assert.equal(first.outcome, 'created');
    if (first.outcome !== 'created') throw new Error('Expected created receipt');
    assert.equal(first.expiresAt, new Date(now + ttl).toISOString());
    store.close();
    let calls = 0;
    store = new LocalAttributionStore(path, Buffer.alloc(32, 7), () => ++calls === 1 ? first.shortCode : 'LKS-1111111111111111');
    assert.deepEqual(store.create(request(), now + 1), { ...first, outcome: 'replayed' });
    assert.equal(store.create({ ...request(), entrySurface: 'configurator' }, now + 1).outcome, 'conflict');
    const second = store.create({ ...request(), requestId: `ar_v1_${'c'.repeat(32)}` }, now + 1);
    assert.equal(second.outcome, 'created');
    assert.equal(calls, 2);
    assert.ok(store.resolve(first.shortCode, now + ttl - 1));
    assert.equal(store.resolve(first.shortCode, now + ttl), null);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('proof invalidates only unbound handoffs for its journey', () => {
  const dir = mkdtempSync(join(tmpdir(), 'attribution-test-'));
  try {
    const store = new LocalAttributionStore(join(dir, 'store.sqlite'), Buffer.alloc(32, 7));
    const first = store.create(request(), now);
    const second = store.create({ ...request(), requestId: `ar_v1_${'c'.repeat(32)}` }, now);
    if (first.outcome !== 'created' || second.outcome !== 'created') throw new Error('Expected created receipts');
    assert.ok(store.bind(first.shortCode, now));
    store.revoke(request().attributionId, `rv_v1_${'0'.repeat(64)}`, now);
    assert.ok(store.resolve(second.shortCode, now));
    store.revoke(request().attributionId, first.revocationProof, now);
    assert.ok(store.resolve(first.shortCode, now));
    assert.equal(store.resolve(second.shortCode, now), null);
    assert.equal(store.create({ ...request(), requestId: `ar_v1_${'c'.repeat(32)}` }, now).outcome, 'revoked');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a renewed receipt never reuses an expired code or capability', () => {
  const dir = mkdtempSync(join(tmpdir(), 'attribution-test-'));
  try {
    let mints = 0;
    const store = new LocalAttributionStore(join(dir, 'store.sqlite'), Buffer.alloc(32, 7), () =>
      ++mints <= 2 ? 'LKS-0000000000000000' : 'LKS-1111111111111111');
    const first = store.create(request(), now);
    const renewed = store.create(request(), now + ttl);
    if (first.outcome !== 'created' || renewed.outcome !== 'created') throw new Error('Expected receipts.');
    assert.notEqual(first.shortCode, renewed.shortCode);
    assert.notEqual(first.revocationProof, renewed.revocationProof);
    assert.equal(store.resolve(first.shortCode, now + ttl), null);
    store.revoke(request().attributionId, first.revocationProof, now + ttl);
    assert.ok(store.resolve(renewed.shortCode, now + ttl));
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('independent processes atomically replay one durable receipt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'attribution-test-'));
  try {
    const path = join(dir, 'store.sqlite');
    const workerPath = compileWorker(dir);
    const worker = (databasePath: string, mode = 'original'): Promise<{ outcome: string; shortCode?: string }> => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [workerPath, databasePath, mode]);
      let output = '';
      let errors = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { errors += chunk; });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(errors)));
    });

    const results = await Promise.all(Array.from({ length: 5 }, () => worker(path)));
    assert.equal(results.filter(result => result.outcome === 'created').length, 1);
    assert.equal(results.filter(result => result.outcome === 'replayed').length, 4);
    assert.equal(new Set(results.map(result => result.shortCode)).size, 1);
    const store = new LocalAttributionStore(path, Buffer.alloc(32, 7));
    assert.equal(store.create(request(), now + 1).outcome, 'replayed');
    assert.equal(store.create({ ...request(), entrySurface: 'configurator' }, now + 1).outcome, 'conflict');
    store.close();
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (filename: string) => { prepare(sql: string): { get(): { total: number } }; close(): void };
    };
    const database = new DatabaseSync(path);
    assert.equal(database.prepare('SELECT COUNT(*) AS total FROM attribution_handoffs').get().total, 1);
    database.close();
    const racePath = join(dir, 'conflict.sqlite');
    const raced = await Promise.all(Array.from({ length: 4 }, (_, index) => worker(racePath, index % 2 === 1 ? 'alternate' : 'original')));
    assert.equal(raced.filter(result => result.outcome === 'created').length, 1);
    assert.equal(raced.filter(result => result.outcome === 'replayed').length, 1);
    assert.equal(raced.filter(result => result.outcome === 'conflict').length, 2);
    const collisionPath = join(dir, 'collision.sqlite');
    const collisions = await Promise.all([worker(collisionPath, 'collision-a'), worker(collisionPath, 'collision-b')]);
    assert.equal(collisions.filter(result => result.outcome === 'created').length, 2);
    assert.equal(new Set(collisions.map(result => result.shortCode)).size, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('simultaneous fresh opens initialize WAL and preserve a single receipt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'attribution-test-'));
  try {
    const workerPath = compileWorker(dir);
    for (let round = 0; round < 3; round += 1) {
      const workers = Array.from({ length: 6 }, () => barrierWorker(workerPath, join(dir, `fresh-${round}.sqlite`)));
      await Promise.all(workers.map(worker => worker.ready));
      workers.forEach(worker => worker.start());
      const results = await Promise.all(workers.map(worker => worker.result));
      assert.equal(results.filter(result => result.outcome === 'created').length, 1);
      assert.equal(results.filter(result => result.outcome === 'replayed').length, 5);
      assert.equal(new Set(results.map(result => result.shortCode)).size, 1);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('WAL initialization retries a temporary lock and rejects unrelated database errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'attribution-test-'));
  try {
    const path = join(dir, 'locked.sqlite');
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (filename: string) => { exec(sql: string): void; prepare(sql: string): { all(): unknown[] }; close(): void };
    };
    const holder = new DatabaseSync(path);
    holder.exec('PRAGMA journal_mode = DELETE; BEGIN;');
    holder.prepare('SELECT * FROM sqlite_schema').all();
    try {
      const worker = barrierWorker(compileWorker(dir), path);
      await worker.ready;
      worker.start();
      const state = await Promise.race([
        worker.result.then(() => 'finished'),
        new Promise<string>(resolve => setTimeout(() => resolve('waiting'), 400)),
      ]);
      assert.equal(state, 'waiting');
      holder.exec('COMMIT;');
      assert.equal((await worker.result).outcome, 'created');
    } finally { holder.close(); }
    const invalid = join(dir, 'invalid.sqlite');
    writeFileSync(invalid, 'not a sqlite database');
    assert.throws(() => new LocalAttributionStore(invalid, Buffer.alloc(32, 7)), (error: unknown) =>
      error instanceof Error && 'errcode' in error && error.errcode === 26);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
