import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { performance } from 'node:perf_hooks';
import type { AttributionRequest, AttributionTouch } from './attribution-validation';

type SqlValue = string | number | null;
type Statement = {
  get(...values: SqlValue[]): Record<string, SqlValue> | undefined;
  run(...values: SqlValue[]): { changes: number | bigint };
};
type Database = {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
};

export type AttributionSnapshot = {
  contractVersion: '1.0.0';
  attributionId: string;
  shortCode: string;
  firstTouch: AttributionTouch;
  lastTouch: AttributionTouch;
  entrySurface: AttributionRequest['entrySurface'];
  consent: AttributionRequest['consent'];
  createdAt: string;
  expiresAt: string;
};

export type ProjectionWork = {
  kind: 'inquiry' | 'quote' | 'order';
  entityId: string;
  version: number;
  first: AttributionSnapshot | null;
  snapshot: AttributionSnapshot | null;
};

export type PinnedAttribution = { snapshot: AttributionSnapshot | null; reason: string | null };

type Receipt = { outcome: 'created' | 'replayed'; shortCode: string; expiresAt: string; revocationProof: string };
type Result = Receipt | { outcome: 'conflict' | 'revoked' };
const ttl = 7 * 24 * 60 * 60 * 1000;
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const codeFromBytes = (bytes: Buffer): string => {
  let value = BigInt(`0x${bytes.toString('hex')}`);
  let code = '';
  for (let i = 0; i < 16; i += 1) {
    code = alphabet[Number(value & 31n)] + code;
    value >>= 5n;
  }
  return `LKS-${code}`;
};

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
};
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const secureDigestEqual = (left: string, right: string): boolean => {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === 32 && b.length === 32 && timingSafeEqual(a, b);
};

const initializeWal = (db: Database): void => {
  const deadline = performance.now() + 10000;
  const sleep = new Int32Array(new SharedArrayBuffer(4));
  let delay = 10;
  db.exec('PRAGMA busy_timeout = 100;');
  for (;;) {
    try {
      db.exec('PRAGMA journal_mode = WAL;');
      break;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ERR_SQLITE_ERROR'
          || !('errcode' in error) || typeof error.errcode !== 'number' || (error.errcode & 255) !== 5) throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw error;
      Atomics.wait(sleep, 0, 0, Math.min(delay, remaining));
      delay = Math.min(delay * 2, 100);
    }
  }
  db.exec('PRAGMA busy_timeout = 10000; PRAGMA synchronous = FULL;');
};

/**
 * Development adapter. Its file path and stable proof key must be explicitly
 * injected; neither is sourced from process configuration by this module.
 */
export class LocalAttributionStore {
  private readonly db: Database;
  private readonly proofKey: Buffer;
  private readonly mintCode: () => string;

  constructor(path: string, proofKey: Buffer, mintCode = () => codeFromBytes(randomBytes(10))) {
    if (proofKey.length < 32) throw new Error('A stable proof key of at least 32 bytes is required.');
    // node:sqlite is only loaded when explicitly constructing this optional adapter.
    const sqlite = require('node:sqlite') as { DatabaseSync: new (filename: string) => Database };
    this.db = new sqlite.DatabaseSync(path);
    this.proofKey = Buffer.from(proofKey);
    this.mintCode = mintCode;
    try {
      initializeWal(this.db);
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS attribution_acceptance_journal (
        run_id TEXT PRIMARY KEY, body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attribution_acceptance_retired_codes (
        code TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS attribution_codes (
        code TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS attribution_handoffs (
        request_id TEXT PRIMARY KEY,
        body_digest TEXT NOT NULL,
        attribution_id TEXT NOT NULL,
        code TEXT NOT NULL UNIQUE,
        proof_digest TEXT NOT NULL,
        proof_nonce TEXT NOT NULL,
        snapshot TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0,
        bound INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS attribution_inquiries (
        entity_id TEXT PRIMARY KEY, first_snapshot TEXT NOT NULL,
        latest_snapshot TEXT NOT NULL, version INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attribution_quotes (
        entity_id TEXT PRIMARY KEY, inquiry_id TEXT NOT NULL,
        snapshot TEXT, reason TEXT
      );
      CREATE TABLE IF NOT EXISTS attribution_orders (
        entity_id TEXT PRIMARY KEY, quote_id TEXT NOT NULL,
        snapshot TEXT, reason TEXT
      );
      CREATE TABLE IF NOT EXISTS attribution_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
        entity_id TEXT NOT NULL, version INTEGER NOT NULL, pending INTEGER NOT NULL,
        UNIQUE(kind, entity_id)
      );
      CREATE TABLE IF NOT EXISTS attribution_projection_writer (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        state TEXT NOT NULL, owner TEXT, inflight INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO attribution_projection_writer VALUES (1, 'idle', NULL, 0);
      CREATE TABLE IF NOT EXISTS attribution_projection_records (
        code TEXT PRIMARY KEY, record_id TEXT NOT NULL UNIQUE
      );
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void { this.db.close(); }

  private proof(requestId: string, nonce: string): string {
    return `rv_v1_${createHmac('sha256', this.proofKey).update(requestId).update(':').update(nonce).digest('hex')}`;
  }

  private transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  hasConflict(request: AttributionRequest, now: number): boolean {
    const row = this.db.prepare('SELECT body_digest FROM attribution_handoffs WHERE request_id = ? AND expires_at > ?').get(request.requestId, now);
    return Boolean(row && row.body_digest !== digest(canonical(request)));
  }

  create(request: AttributionRequest, now: number): Result {
    const bodyDigest = digest(canonical(request));
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM attribution_handoffs WHERE request_id = ?').get(request.requestId);
      if (existing && Number(existing.expires_at) > now) {
        if (existing.body_digest !== bodyDigest) return { outcome: 'conflict' };
        if (existing.revoked) return { outcome: 'revoked' };
        const proof = this.proof(request.requestId, String(existing.proof_nonce));
        if (!secureDigestEqual(String(existing.proof_digest), digest(proof))) throw new Error('Proof key does not match the stored receipt.');
        return { outcome: 'replayed', shortCode: String(existing.code), expiresAt: new Date(Number(existing.expires_at)).toISOString(), revocationProof: proof };
      }
      if (existing) this.db.prepare('DELETE FROM attribution_handoffs WHERE request_id = ?').run(request.requestId);
      const expiresAt = now + ttl;
      const insert = this.db.prepare(`INSERT INTO attribution_handoffs
        (request_id, body_digest, attribution_id, code, proof_digest, proof_nonce, snapshot, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      const reserve = this.db.prepare('INSERT INTO attribution_codes (code) VALUES (?)');
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const code = this.mintCode();
        if (!/^LKS-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{16}$/.test(code)) throw new Error('Invalid generated code.');
        try {
          reserve.run(code);
        } catch (error) {
          if (this.db.prepare('SELECT code FROM attribution_codes WHERE code = ?').get(code)) continue;
          throw error;
        }
        const nonce = randomBytes(16).toString('hex');
        const proof = this.proof(request.requestId, nonce);
        const snapshot: AttributionSnapshot = {
          contractVersion: '1.0.0', attributionId: request.attributionId, shortCode: code,
          firstTouch: request.firstTouch, lastTouch: request.lastTouch, entrySurface: request.entrySurface,
          consent: request.consent, createdAt: new Date(now).toISOString(), expiresAt: new Date(expiresAt).toISOString(),
        };
        insert.run(request.requestId, bodyDigest, request.attributionId, code, digest(proof), nonce, JSON.stringify(snapshot), expiresAt);
        return { outcome: 'created', shortCode: code, expiresAt: snapshot.expiresAt, revocationProof: proof };
      }
      throw new Error('Unable to allocate a unique attribution code.');
    });
  }

  resolve(code: string, now: number): AttributionSnapshot | null {
    const row = this.db.prepare('SELECT snapshot FROM attribution_handoffs WHERE code = ? AND revoked = 0 AND expires_at > ? AND code NOT IN (SELECT code FROM attribution_acceptance_retired_codes)').get(code, now);
    return row ? JSON.parse(String(row.snapshot)) as AttributionSnapshot : null;
  }

  bind(code: string, now: number): AttributionSnapshot | null {
    return this.transaction(() => {
      const snapshot = this.resolve(code, now);
      if (!snapshot) return null;
      this.markBound(snapshot);
      return snapshot;
    });
  }

  private enqueue(kind: ProjectionWork['kind'], entityId: string, version: number): void {
    this.db.prepare(`INSERT INTO attribution_outbox (kind, entity_id, version, pending) VALUES (?, ?, ?, 1)
      ON CONFLICT(kind, entity_id) DO UPDATE SET version = excluded.version, pending = 1`)
      .run(kind, entityId, version);
  }

  private attachInquiry(inquiryId: string, snapshot: AttributionSnapshot): void {
    const row = this.db.prepare('SELECT * FROM attribution_inquiries WHERE entity_id = ?').get(inquiryId);
    const serialized = JSON.stringify(snapshot);
    if (!row) {
      this.db.prepare('INSERT INTO attribution_inquiries VALUES (?, ?, ?, 1)').run(inquiryId, serialized, serialized);
      this.enqueue('inquiry', inquiryId, 1);
    } else if (row.latest_snapshot !== serialized) {
      const version = Number(row.version) + 1;
      this.db.prepare('UPDATE attribution_inquiries SET latest_snapshot = ?, version = ? WHERE entity_id = ?')
        .run(serialized, version, inquiryId);
      this.enqueue('inquiry', inquiryId, version);
    }
  }

  private markBound(snapshot: AttributionSnapshot): void {
    this.db.prepare('UPDATE attribution_handoffs SET bound = 1 WHERE code = ?').run(snapshot.shortCode);
  }

  bindInquiry(code: string, inquiryId: string, now: number): AttributionSnapshot | null {
    return this.transaction(() => {
      const snapshot = this.resolve(code, now);
      if (!snapshot) return null;
      this.attachInquiry(inquiryId, snapshot);
      this.markBound(snapshot);
      return snapshot;
    });
  }

  pinQuote(code: string | null, inquiryId: string, quoteId: string, now: number, missingReason: string): PinnedAttribution {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT snapshot, reason FROM attribution_quotes WHERE entity_id = ?').get(quoteId);
      if (existing) return {
        snapshot: existing.snapshot ? JSON.parse(String(existing.snapshot)) as AttributionSnapshot : null,
        reason: existing.reason === null ? null : String(existing.reason),
      };
      const snapshot = code ? this.resolve(code, now) : null;
      const reason = snapshot ? null : code ? 'not_found' : missingReason;
      this.db.prepare('INSERT INTO attribution_quotes VALUES (?, ?, ?, ?)')
        .run(quoteId, inquiryId, snapshot ? JSON.stringify(snapshot) : null, reason);
      if (snapshot) {
        if (inquiryId) this.attachInquiry(inquiryId, snapshot);
        this.markBound(snapshot);
      }
      this.enqueue('quote', quoteId, 1);
      return { snapshot, reason };
    });
  }

  pinOrder(quoteId: string, orderId: string): PinnedAttribution {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT snapshot, reason FROM attribution_orders WHERE entity_id = ?').get(orderId);
      if (existing) return {
        snapshot: existing.snapshot ? JSON.parse(String(existing.snapshot)) as AttributionSnapshot : null,
        reason: existing.reason === null ? null : String(existing.reason),
      };
      const quote = this.db.prepare('SELECT snapshot, reason FROM attribution_quotes WHERE entity_id = ?').get(quoteId);
      const raw = quote?.snapshot ? String(quote.snapshot) : null;
      const reason = raw ? null : String(quote?.reason || 'missing');
      this.db.prepare('INSERT INTO attribution_orders VALUES (?, ?, ?, ?)').run(orderId, quoteId, raw, reason);
      this.enqueue('order', orderId, 1);
      return { snapshot: raw ? JSON.parse(raw) as AttributionSnapshot : null, reason };
    });
  }

  nextProjection(): ProjectionWork | null {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT kind, entity_id, version FROM attribution_outbox WHERE pending = 1 ORDER BY id LIMIT 1').get();
      if (!row) return null;
      const kind = String(row.kind) as ProjectionWork['kind'];
      const entityId = String(row.entity_id);
      const version = Number(row.version);
      if (kind === 'inquiry') {
        const inquiry = this.db.prepare('SELECT first_snapshot, latest_snapshot FROM attribution_inquiries WHERE entity_id = ?').get(entityId);
        if (!inquiry) throw new Error('Missing local inquiry binding.');
        return { kind, entityId, version, first: JSON.parse(String(inquiry.first_snapshot)) as AttributionSnapshot, snapshot: JSON.parse(String(inquiry.latest_snapshot)) as AttributionSnapshot };
      }
      if (kind !== 'quote' && kind !== 'order') throw new Error('Invalid projection type.');
      const statement = kind === 'quote' ? 'SELECT snapshot FROM attribution_quotes WHERE entity_id = ?' : 'SELECT snapshot FROM attribution_orders WHERE entity_id = ?';
      const record = this.db.prepare(statement).get(entityId);
      if (!record) throw new Error('Missing local business binding.');
      return { kind, entityId, version, first: null, snapshot: record.snapshot ? JSON.parse(String(record.snapshot)) as AttributionSnapshot : null };
    });
  }

  completeProjection(work: ProjectionWork): boolean {
    return Number(this.db.prepare('UPDATE attribution_outbox SET pending = 0 WHERE kind = ? AND entity_id = ? AND version = ? AND pending = 1')
      .run(work.kind, work.entityId, work.version).changes) === 1;
  }

  acquireProjectionWriter(): string {
    return this.transaction(() => {
      const owner = randomBytes(16).toString('hex');
      const result = this.db.prepare(`UPDATE attribution_projection_writer SET state = 'active', owner = ?, inflight = 0
        WHERE singleton = 1 AND state = 'idle'`).run(owner);
      if (Number(result.changes) !== 1) throw new Error('Projection writer requires recovery or is already active.');
      return owner;
    });
  }

  projectionWriterStatus(): { state: string; owner: string | null; inflight: boolean } {
    const row = this.db.prepare('SELECT state, owner, inflight FROM attribution_projection_writer WHERE singleton = 1').get();
    if (!row) throw new Error('Projection writer state is missing.');
    return { state: String(row.state), owner: row.owner === null ? null : String(row.owner), inflight: Boolean(row.inflight) };
  }

  beginProjectionWrite(owner: string): void {
    const result = this.db.prepare(`UPDATE attribution_projection_writer SET inflight = 1
      WHERE singleton = 1 AND state = 'active' AND owner = ? AND inflight = 0`).run(owner);
    if (Number(result.changes) !== 1) throw new Error('Projection writer is not available.');
  }

  finishProjectionWrite(owner: string): void {
    const result = this.db.prepare(`UPDATE attribution_projection_writer SET inflight = 0
      WHERE singleton = 1 AND state = 'active' AND owner = ? AND inflight = 1`).run(owner);
    if (Number(result.changes) !== 1) throw new Error('Projection writer state changed.');
  }

  markProjectionUncertain(owner: string): void {
    const result = this.db.prepare(`UPDATE attribution_projection_writer SET state = 'uncertain'
      WHERE singleton = 1 AND owner = ? AND state = 'active'`).run(owner);
    if (Number(result.changes) !== 1) throw new Error('Projection writer state changed.');
  }

  releaseProjectionWriter(owner: string): void {
    const status = this.projectionWriterStatus();
    if (status.owner !== owner) throw new Error('Projection writer ownership changed.');
    if (status.state === 'uncertain') return;
    if (status.state !== 'active' || status.inflight) throw new Error('Projection writer has an unresolved write.');
    const result = this.db.prepare("UPDATE attribution_projection_writer SET state = 'idle', owner = NULL WHERE singleton = 1 AND owner = ? AND state = 'active' AND inflight = 0").run(owner);
    if (Number(result.changes) !== 1) throw new Error('Projection writer state changed.');
  }

  projectionRecord(code: string): string | null {
    const row = this.db.prepare('SELECT record_id FROM attribution_projection_records WHERE code = ?').get(code);
    return row ? String(row.record_id) : null;
  }

  rememberProjectionRecord(code: string, recordId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO attribution_projection_records (code, record_id) VALUES (?, ?)').run(code, recordId);
    if (this.projectionRecord(code) !== recordId) throw new Error('Attribution projection record conflicts.');
  }

  recoverProjectionWriter(
    owner: string,
    confirmation: 'external-writes-settled-and-reconciled',
    records: Array<{ code: string; recordId: string }>,
  ): void {
    if (confirmation !== 'external-writes-settled-and-reconciled') throw new Error('Explicit recovery confirmation is required.');
    this.transaction(() => {
      const status = this.projectionWriterStatus();
      if (status.owner !== owner || status.state === 'idle') throw new Error('Projection recovery ownership does not match.');
      for (const record of records) {
        if (!/^LKS-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{16}$/.test(record.code) || !record.recordId) throw new Error('Invalid recovery record.');
        this.rememberProjectionRecord(record.code, record.recordId);
      }
      this.db.prepare("UPDATE attribution_projection_writer SET state = 'idle', owner = NULL, inflight = 0 WHERE singleton = 1 AND owner = ?").run(owner);
    });
  }

  acceptanceCodeUnused(code: string): boolean {
    return Boolean(this.db.prepare('SELECT code FROM attribution_handoffs WHERE code = ? AND bound = 0 AND revoked = 0').get(code));
  }

  acceptanceJournal(runId: string): string | null {
    if (!/^attrtest_[a-z0-9]{16,48}$/.test(runId)) throw new Error('Invalid synthetic run.');
    const row = this.db.prepare('SELECT body FROM attribution_acceptance_journal WHERE run_id = ?').get(runId);
    return row ? String(row.body) : null;
  }

  saveAcceptanceJournal(runId: string, body: string): void {
    if (!/^attrtest_[a-z0-9]{16,48}$/.test(runId) || body.length > 40000) throw new Error('Invalid synthetic journal.');
    JSON.parse(body);
    this.transaction(() => { this.db.prepare('INSERT INTO attribution_acceptance_journal (run_id, body) VALUES (?, ?) ON CONFLICT(run_id) DO UPDATE SET body = excluded.body').run(runId, body); });
  }

  retireAcceptanceCodes(codes: readonly string[]): void {
    if (codes.length !== 5 || new Set(codes).size !== 5 || codes.some(code => !/^LKS-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{16}$/.test(code))) throw new Error('Invalid synthetic retirement.');
    this.transaction(() => { for (const code of codes) this.db.prepare('INSERT OR IGNORE INTO attribution_acceptance_retired_codes (code) VALUES (?)').run(code); });
  }

  revoke(attributionId: string, proof: string, now: number): void {
    if (!/^aid_v1_[0-9a-f]{32}$/.test(attributionId) || !/^rv_v1_[0-9a-f]{64}$/.test(proof)) return;
    this.transaction(() => {
      const row = this.db.prepare('SELECT proof_digest FROM attribution_handoffs WHERE attribution_id = ? AND proof_digest = ? AND expires_at > ?').get(attributionId, digest(proof), now);
      if (row && secureDigestEqual(String(row.proof_digest), digest(proof))) {
        this.db.prepare('UPDATE attribution_handoffs SET revoked = 1 WHERE attribution_id = ? AND bound = 0').run(attributionId);
      }
    });
  }
}
