import {
  isImmutableItemId,
  quotationImageAssetKey,
  type QuotationImageMetadata,
  type QuotationImageMetadataWriter,
  type QuoteItemWithQuotationImage,
} from './quotation-image';

type QuoteRecord = { id: string; fields: Record<string, unknown> };
type QuoteTable = {
  find(id: string): Promise<QuoteRecord>;
  update(records: Array<{ id: string; fields: Record<string, unknown> }>): Promise<unknown>;
};

const parseItems = (raw: unknown): QuoteItemWithQuotationImage[] => {
  if (Array.isArray(raw)) return raw as QuoteItemWithQuotationImage[];
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('Quote Items JSON is unavailable.');
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error('Quote Items JSON must contain an array.');
  return parsed as QuoteItemWithQuotationImage[];
};

const assertMetadata = (item: QuoteItemWithQuotationImage, metadata: QuotationImageMetadata): void => {
  if (!isImmutableItemId(item.item_id)) throw new Error('Quotation-image item identity is invalid.');
  if (item.quotation_image?.idempotency_key !== metadata.idempotency_key) {
    throw new Error('Quotation-image metadata idempotency mismatch.');
  }
  const expectedAssetKey = quotationImageAssetKey(metadata.idempotency_key);
  if (metadata.asset_key && metadata.asset_key !== expectedAssetKey) {
    throw new Error('Quotation-image metadata asset identity mismatch.');
  }
  if (!['ready', 'failed'].includes(metadata.state)) {
    throw new Error('Quotation-image metadata transition is invalid.');
  }
};

export class AirtableQuotationImageMetadataWriter implements QuotationImageMetadataWriter {
  constructor(
    private readonly table: QuoteTable,
    private readonly lock: InProcessQuoteItemsLock = new InProcessQuoteItemsLock(),
  ) {}

  async update(input: {
    quoteRecordId: string;
    itemId: string;
    metadata: QuotationImageMetadata;
  }): Promise<void> {
    return this.lock.run(input.quoteRecordId, async () => {
      if (!input.quoteRecordId || !isImmutableItemId(input.itemId)) {
        throw new Error('Quotation-image metadata target is invalid.');
      }
      const quote = await this.table.find(input.quoteRecordId);
      const items = parseItems(quote.fields['Quote Items JSON']);
      const matchingIndexes = items.flatMap((item, index) => (
        String(item.item_id || '').toLowerCase() === input.itemId.toLowerCase() ? [index] : []
      ));
      if (matchingIndexes.length !== 1) throw new Error('Quotation-image item identity is not unique.');
      const index = matchingIndexes[0];
      assertMetadata(items[index], input.metadata);
      const nextItems = items.map((item, itemIndex) => itemIndex === index
        ? { ...item, quotation_image: { ...input.metadata } }
        : item);
      await this.table.update([{
        id: input.quoteRecordId,
        fields: { 'Quote Items JSON': JSON.stringify(nextItems) },
      }]);
    });
  }
}

export class InProcessQuoteItemsLock {
  private readonly locks = new Map<string, Promise<void>>();

  async run<T>(quoteRecordId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(quoteRecordId) || Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.locks.set(quoteRecordId, current);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release?.();
      if (this.locks.get(quoteRecordId) === current) this.locks.delete(quoteRecordId);
    }
  }
}
