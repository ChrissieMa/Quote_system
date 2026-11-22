import { AttributionSnapshot, LocalAttributionStore, ProjectionWork } from './attribution-store';
import type { SerializedAirtableProjectionTransport } from './attribution-airtable';

export type ProjectionValue = string | number | null | string[];
export type ProjectionRecord = { id: string; version: string; fields: Record<string, unknown> };

export type AttributionProjectionTransport = {
  start(): void;
  finish(): void;
  read(table: string, id: string): Promise<ProjectionRecord>;
  findOrCreate(table: string, field: string, value: string, fields: Record<string, ProjectionValue>): Promise<ProjectionRecord>;
  updateIfUnchanged(table: string, id: string, version: string, fields: Record<string, ProjectionValue>): Promise<boolean>;
};

export type AttributionProjectionMapping = {
  tables: { attributions: string; inquiries: string; quotes: string; orders: string };
  attribution: {
    code: string; attributionId: string; contractVersion: string; entrySurface: string;
    firstAt: string; firstChannel: string; firstSource: string; firstMedium: string; firstCampaign: string;
    firstPath: string; firstEvidence: string; firstConfidence: string;
    lastAt: string; lastChannel: string; lastSource: string; lastMedium: string; lastCampaign: string;
    lastPath: string; lastEvidence: string; lastConfidence: string;
    consent: string; createdAt: string; expiresAt: string;
  };
  inquiry: { first: string; latest: string; revision: string };
  quote: { snapshot: string };
  order: { snapshot: string };
  surfaces: { wordpress: string; configurator: string };
  campaigns: ReadonlyMap<string, { source: string; recordId: string }>;
};

const oneLink = (value: unknown): string | null => {
  if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) return null;
  if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== 'string' || !value[0]) {
    throw new Error('Invalid projection link.');
  }
  return value[0];
};

export class AttributionProjector {
  private running = false;
  private requested = false;

  constructor(
    private readonly store: LocalAttributionStore,
    private readonly transport: SerializedAirtableProjectionTransport,
    private readonly mapping: AttributionProjectionMapping,
    private readonly reportError: (message: string) => void,
  ) {
    if (!transport.usesStore(store)) throw new Error('Projection transport must use the binding store.');
    for (const fields of [mapping.tables, mapping.attribution, mapping.inquiry, mapping.quote, mapping.order]) {
      const values = Object.values(fields);
      if (values.some(value => typeof value !== 'string' || !value.trim()) || new Set(values).size !== values.length) {
        throw new Error('Invalid attribution projection mapping.');
      }
    }
    if (!mapping.surfaces.wordpress || !mapping.surfaces.configurator) throw new Error('Invalid surface mapping.');
    for (const [key, campaign] of mapping.campaigns) {
      if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(key) || !campaign.source || !campaign.recordId) {
        throw new Error('Invalid campaign mapping.');
      }
    }
  }

  private fields(snapshot: AttributionSnapshot): Record<string, ProjectionValue> {
    const f = this.mapping.attribution;
    const campaign = (key: string | null, source: string): string[] => {
      const match = key ? this.mapping.campaigns.get(key) : undefined;
      return match && match.source === source ? [match.recordId] : [];
    };
    const first = snapshot.firstTouch;
    const last = snapshot.lastTouch;
    return {
      [f.code]: snapshot.shortCode, [f.attributionId]: snapshot.attributionId,
      [f.contractVersion]: snapshot.contractVersion, [f.entrySurface]: this.mapping.surfaces[snapshot.entrySurface],
      [f.firstAt]: first.observedAt, [f.firstChannel]: first.channel, [f.firstSource]: first.source,
      [f.firstMedium]: first.medium, [f.firstCampaign]: campaign(first.campaignKey, first.source),
      [f.firstPath]: first.landingPath, [f.firstEvidence]: first.evidence, [f.firstConfidence]: first.confidence,
      [f.lastAt]: last.observedAt, [f.lastChannel]: last.channel, [f.lastSource]: last.source,
      [f.lastMedium]: last.medium, [f.lastCampaign]: campaign(last.campaignKey, last.source),
      [f.lastPath]: last.landingPath, [f.lastEvidence]: last.evidence, [f.lastConfidence]: last.confidence,
      [f.consent]: JSON.stringify(snapshot.consent), [f.createdAt]: snapshot.createdAt, [f.expiresAt]: snapshot.expiresAt,
    };
  }

  private async ensureSnapshot(snapshot: AttributionSnapshot): Promise<string> {
    const fields = this.fields(snapshot);
    const record = await this.transport.findOrCreate(this.mapping.tables.attributions, this.mapping.attribution.code, snapshot.shortCode, fields);
    for (const [key, value] of Object.entries(fields)) {
      const actual = record.fields[key];
      // Airtable omits empty fields when reading records.
      if ((value === null || (Array.isArray(value) && value.length === 0))
          && (actual === undefined || actual === null || (Array.isArray(actual) && actual.length === 0))) continue;
      if (JSON.stringify(actual) !== JSON.stringify(value)) throw new Error('Attribution projection conflicts with an existing record.');
    }
    if (!record.id) throw new Error('Projection returned no record ID.');
    return record.id;
  }

  private async project(work: ProjectionWork): Promise<void> {
    if (work.kind === 'inquiry') {
      if (!work.first || !work.snapshot) throw new Error('Missing inquiry attribution.');
      const first = await this.ensureSnapshot(work.first);
      const latest = await this.ensureSnapshot(work.snapshot);
      const { first: firstField, latest: latestField, revision: revisionField } = this.mapping.inquiry;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const record = await this.transport.read(this.mapping.tables.inquiries, work.entityId);
        const existingFirst = oneLink(record.fields[firstField]);
        if (existingFirst && existingFirst !== first) throw new Error('Inquiry first attribution conflicts.');
        const rawRevision = record.fields[revisionField];
        const revision = rawRevision === undefined || rawRevision === null ? 0 : rawRevision;
        if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid inquiry projection revision.');
        if (revision > work.version) {
          if (!existingFirst) throw new Error('Newer inquiry projection lacks first attribution.');
          return;
        }
        if (revision === work.version && existingFirst === first && oneLink(record.fields[latestField]) === latest) return;
        if (revision === work.version) throw new Error('Inquiry projection revision conflicts.');
        if (await this.transport.updateIfUnchanged(this.mapping.tables.inquiries, work.entityId, record.version, {
          [firstField]: [first], [latestField]: [latest], [revisionField]: work.version,
        })) return;
      }
      throw new Error('Inquiry projection contention.');
    }
    const table = work.kind === 'quote' ? this.mapping.tables.quotes : this.mapping.tables.orders;
    const field = work.kind === 'quote' ? this.mapping.quote.snapshot : this.mapping.order.snapshot;
    const wanted = work.snapshot ? await this.ensureSnapshot(work.snapshot) : null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const record = await this.transport.read(table, work.entityId);
      const existing = oneLink(record.fields[field]);
      if (existing === wanted) return;
      if (existing) throw new Error('Pinned attribution conflicts with an existing link.');
      if (wanted && await this.transport.updateIfUnchanged(table, work.entityId, record.version, { [field]: [wanted] })) return;
    }
    throw new Error('Pinned attribution projection contention.');
  }

  requestFlush(): void {
    if (this.running || this.requested) return;
    this.requested = true;
    void Promise.resolve().then(async () => {
      try {
        if (this.running) return;
        const result = await this.flush();
        if (result.pending && !result.failed) this.reportError('Attribution projection pending; retry is required.');
      } catch {
        this.reportError('Attribution projection unavailable; retry is required.');
      } finally {
        this.requested = false;
      }
    });
  }

  async flush(maxItems = 100): Promise<{ attempted: number; completed: number; pending: boolean; failed: boolean }> {
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 100) throw new Error('Invalid projection batch size.');
    if (this.running) throw new Error('Projection is already running.');
    this.running = true;
    let attempted = 0;
    let completed = 0;
    let started = false;
    try {
      this.transport.start();
      started = true;
      while (attempted < maxItems) {
        const work = this.store.nextProjection();
        if (!work) return { attempted, completed, pending: false, failed: false };
        attempted += 1;
        await this.project(work);
        if (this.store.completeProjection(work)) completed += 1;
      }
      return { attempted, completed, pending: Boolean(this.store.nextProjection()), failed: false };
    } catch {
      this.reportError('Attribution projection unavailable; retry is required.');
      return { attempted, completed, pending: true, failed: true };
    } finally {
      try { if (started) this.transport.finish(); }
      finally { this.running = false; }
    }
  }
}
