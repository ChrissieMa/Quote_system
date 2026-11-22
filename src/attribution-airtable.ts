import { createHash } from 'crypto';
import type Airtable from 'airtable';
import type { FieldSet } from 'airtable';
import { AttributionProjectionTransport, ProjectionRecord, ProjectionValue } from './attribution-projection';
import { LocalAttributionStore } from './attribution-store';

type AirtableRecord = { id: string; fields: FieldSet };
export type AirtableTableClient = {
  find(id: string): Promise<AirtableRecord>;
  select(options: { filterByFormula: string; maxRecords: number; pageSize: number }): { firstPage(): Promise<readonly AirtableRecord[]> };
  create(records: Array<{ fields: FieldSet }>): Promise<readonly AirtableRecord[]>;
  update(records: Array<{ id: string; fields: FieldSet }>): Promise<readonly AirtableRecord[]>;
};

const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
};

const toFields = (values: Record<string, ProjectionValue>): FieldSet => {
  const fields: FieldSet = {};
  for (const [key, value] of Object.entries(values)) if (value !== null) fields[key] = value;
  return fields;
};

const normalize = (record: AirtableRecord): ProjectionRecord => ({
  id: record.id,
  fields: record.fields,
  version: createHash('sha256').update(canonical(record.fields)).digest('hex'),
});

/**
 * Requires an externally verified exclusive writer. Airtable does not provide
 * native uniqueness or compare-and-set guarantees.
 */
export class SerializedAirtableProjectionTransport implements AttributionProjectionTransport {
  private owner: string | null = null;

  constructor(
    private readonly store: LocalAttributionStore,
    private readonly table: (name: string) => AirtableTableClient,
    exclusiveWriterConfirmed: true,
  ) {
    if (exclusiveWriterConfirmed !== true) throw new Error('Exclusive projection writer preflight is required.');
  }

  usesStore(store: LocalAttributionStore): boolean { return this.store === store; }

  start(): void {
    if (this.owner) throw new Error('Projection transport is already active.');
    this.owner = this.store.acquireProjectionWriter();
  }

  finish(): void {
    if (!this.owner) throw new Error('Projection transport is not active.');
    const owner = this.owner;
    this.owner = null;
    this.store.releaseProjectionWriter(owner);
  }

  private async write<T>(action: () => Promise<T>): Promise<T> {
    if (!this.owner) throw new Error('Projection writer is not active.');
    const owner = this.owner;
    this.store.beginProjectionWrite(owner);
    try {
      const result = await action();
      this.store.finishProjectionWrite(owner);
      return result;
    } catch (error) {
      this.store.markProjectionUncertain(owner);
      throw error;
    }
  }

  async read(table: string, id: string): Promise<ProjectionRecord> {
    if (!this.owner) throw new Error('Projection writer is not active.');
    return normalize(await this.table(table).find(id));
  }

  async findOrCreate(table: string, field: string, value: string, fields: Record<string, ProjectionValue>): Promise<ProjectionRecord> {
    if (!this.owner) throw new Error('Projection writer is not active.');
    if (!/^[A-Za-z0-9 _/-]+$/.test(field) || !/^LKS-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{16}$/.test(value)) {
      throw new Error('Invalid attribution lookup.');
    }
    const storedId = this.store.projectionRecord(value);
    if (storedId) return this.read(table, storedId);
    const matches = await this.table(table).select({
      filterByFormula: `{${field}} = '${value}'`, maxRecords: 2, pageSize: 2,
    }).firstPage();
    if (matches.length > 1) throw new Error('Attribution lookup is ambiguous.');
    if (matches.length === 1) {
      this.store.rememberProjectionRecord(value, matches[0].id);
      return normalize(matches[0]);
    }
    return this.write(async () => {
      const created = await this.table(table).create([{ fields: toFields(fields) }]);
      if (created.length !== 1 || !created[0].id) throw new Error('Attribution creation was not confirmed.');
      this.store.rememberProjectionRecord(value, created[0].id);
      return normalize(created[0]);
    });
  }

  async updateIfUnchanged(table: string, id: string, version: string, fields: Record<string, ProjectionValue>): Promise<boolean> {
    const current = await this.read(table, id);
    if (current.version !== version) return false;
    return this.write(async () => {
      const updated = await this.table(table).update([{ id, fields: toFields(fields) }]);
      if (updated.length !== 1 || updated[0].id !== id) throw new Error('Projection update was not confirmed.');
      for (const [key, value] of Object.entries(fields)) {
        if (JSON.stringify(updated[0].fields[key]) !== JSON.stringify(value)) throw new Error('Projection update did not match.');
      }
      return true;
    });
  }
}

export const createAirtableProjectionTransport = (
  store: LocalAttributionStore,
  base: Airtable.Base,
  exclusiveWriterConfirmed: true,
): SerializedAirtableProjectionTransport =>
  new SerializedAirtableProjectionTransport(store, name => base(name), exclusiveWriterConfirmed);
