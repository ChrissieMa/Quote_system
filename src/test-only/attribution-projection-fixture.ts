import type { FieldSet } from 'airtable';
import { AirtableTableClient } from '../attribution-airtable';
import { AttributionProjectionMapping } from '../attribution-projection';

export const syntheticProjectionMapping = (): AttributionProjectionMapping => ({
  tables: { attributions: 'Attributions', inquiries: 'Inquiries', quotes: 'Quotes', orders: 'Orders' },
  attribution: {
    code: 'Code', attributionId: 'ID', contractVersion: 'Version', entrySurface: 'Surface',
    firstAt: 'First At', firstChannel: 'First Channel', firstSource: 'First Source', firstMedium: 'First Medium',
    firstCampaign: 'First Campaign', firstPath: 'First Path', firstEvidence: 'First Evidence', firstConfidence: 'First Confidence',
    lastAt: 'Last At', lastChannel: 'Last Channel', lastSource: 'Last Source', lastMedium: 'Last Medium',
    lastCampaign: 'Last Campaign', lastPath: 'Last Path', lastEvidence: 'Last Evidence', lastConfidence: 'Last Confidence',
    consent: 'Consent', createdAt: 'Created', expiresAt: 'Expires',
  },
  inquiry: { first: 'First Attribution', latest: 'Latest Attribution', revision: 'Projection Revision' },
  quote: { snapshot: 'Attribution Snapshot' },
  order: { snapshot: 'Attribution Snapshot' },
  surfaces: { wordpress: 'WordPress', configurator: '3D' },
  campaigns: new Map([['demo-paid', { source: 'instagram', recordId: 'campaign-demo' }]]),
});

export class SyntheticAirtableClient {
  private readonly tables = new Map<string, Map<string, FieldSet>>();
  private nextId = 0;
  readonly writes = { create: 0, update: 0 };
  failure: { operation: 'find' | 'select' | 'create' | 'update'; after: boolean } | null = null;
  beforeUpdate: ((table: string, fields: FieldSet) => Promise<void>) | null = null;

  private records(name: string): Map<string, FieldSet> {
    let result = this.tables.get(name);
    if (!result) { result = new Map(); this.tables.set(name, result); }
    return result;
  }

  seed(table: string, id: string, fields: FieldSet = {}): void {
    this.records(table).set(id, structuredClone(fields));
  }

  private fail(operation: 'find' | 'select' | 'create' | 'update', after: boolean): void {
    if (this.failure?.operation === operation && this.failure.after === after) {
      this.failure = null;
      throw new Error('Synthetic transport failure.');
    }
  }

  table = (name: string): AirtableTableClient => ({
    find: async id => {
      this.fail('find', false);
      const fields = this.records(name).get(id);
      if (!fields) throw new Error('Synthetic record missing.');
      const result = { id, fields: structuredClone(fields) };
      this.fail('find', true);
      return result;
    },
    select: options => ({
      firstPage: async () => {
        this.fail('select', false);
        const exactId = /^RECORD_ID\(\) = '([A-Za-z0-9_-]+)'$/.exec(options.filterByFormula);
        if (exactId) {
          this.fail('find', false);
          const fields = this.records(name).get(exactId[1]);
          const result = fields ? [{ id: exactId[1], fields: structuredClone(fields) }] : [];
          this.fail('find', true);
          this.fail('select', true);
          return result;
        }
        const match = /^\{([A-Za-z0-9 _/-]+)\} = '(LKS-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{16})'$/.exec(options.filterByFormula);
        if (!match) throw new Error('Unexpected synthetic lookup.');
        const result = [...this.records(name)]
          .filter(([, fields]) => fields[match[1]] === match[2])
          .slice(0, options.maxRecords)
          .map(([id, fields]) => ({ id, fields: structuredClone(fields) }));
        this.fail('select', true);
        return result;
      },
    }),
    create: async records => {
      this.fail('create', false);
      this.writes.create += 1;
      const result = records.map(record => {
        const id = `attribution-${++this.nextId}`;
        this.seed(name, id, record.fields);
        return { id, fields: structuredClone(record.fields) };
      });
      this.fail('create', true);
      return result;
    },
    update: async records => {
      this.fail('update', false);
      this.writes.update += 1;
      const result = [];
      for (const record of records) {
        await this.beforeUpdate?.(name, record.fields);
        const existing = this.records(name).get(record.id);
        if (!existing) throw new Error('Synthetic record missing.');
        const fields = { ...existing, ...structuredClone(record.fields) };
        this.records(name).set(record.id, fields);
        result.push({ id: record.id, fields: structuredClone(fields) });
      }
      this.fail('update', true);
      return result;
    },
  });

  async read(table: string, id: string): Promise<{ id: string; fields: FieldSet }> {
    return this.table(table).find(id);
  }

  count(table: string): number { return this.records(table).size; }
}
