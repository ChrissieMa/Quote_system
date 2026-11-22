import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
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
    this.db.exec('PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    this.db.exec(`
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
    `);
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
    const row = this.db.prepare('SELECT snapshot FROM attribution_handoffs WHERE code = ? AND revoked = 0 AND expires_at > ?').get(code, now);
    return row ? JSON.parse(String(row.snapshot)) as AttributionSnapshot : null;
  }

  bind(code: string, now: number): AttributionSnapshot | null {
    return this.bindWith(code, now, () => {});
  }

  bindWith(code: string, now: number, apply: (snapshot: AttributionSnapshot) => void): AttributionSnapshot | null {
    return this.transaction(() => {
      const snapshot = this.resolve(code, now);
      if (!snapshot) return null;
      apply(snapshot);
      this.db.prepare('UPDATE attribution_handoffs SET bound = 1 WHERE code = ?').run(code);
      return snapshot;
    });
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
