import crypto from 'crypto';

export const QUOTATION_IMAGE_CONTRACT = 'quotation-image-v1' as const;
export const RENDER_CONTRACT = '3d-render-v1' as const;
export const QUOTATION_IMAGE_SIZE = 1280;

export type DimensionSet = { length: number; depth: number; height: number };

export type RenderRequestV1 = {
  purpose: 'quotation';
  product_type: string;
  configuration_id?: string;
  dimensions: {
    unit: 'mm' | 'cm';
    inner: DimensionSet;
    outer: DimensionSet;
    actual: DimensionSet;
  };
  cabinet_layers: Array<{ layer_id: string; position: number; actual_height: number }>;
  accessories: Array<{ accessory_type: string; quantity: number; colour?: string }>;
  colours: { body: string; accent?: string; background: string };
  engraving?: { enabled: boolean; artwork_asset_reference?: string };
  model_preview?: { enabled: boolean; preset?: string };
  camera_preset: string;
  output: { width: 1280; height: 1280; background: 'white' | 'transparent' | 'configured' };
  branding: { enabled: boolean; style: 'none' | 'subtle_lks' };
  show_dimensions: boolean;
  show_price: false;
};

export type QuotationImageState = 'pending' | 'ready' | 'failed';
export type QuotationImageErrorClass = 'temporary' | 'terminal' | 'timeout';

export type QuotationImageMetadata = {
  contract: typeof QUOTATION_IMAGE_CONTRACT;
  state: QuotationImageState;
  idempotency_key: string;
  asset_key?: string;
  attempts: number;
  error_class?: QuotationImageErrorClass;
  updated_at: string;
};

export type QuoteItemWithQuotationImage = Record<string, unknown> & {
  item_id?: string;
  quotation_image?: QuotationImageMetadata;
};

export type RenderedQuotationImage = {
  bytes: Buffer;
  mimeType: 'image/png';
  width: 1280;
  height: 1280;
};

export interface QuotationImageRenderer {
  render(request: RenderRequestV1, context: { idempotencyKey: string; signal: AbortSignal }): Promise<RenderedQuotationImage>;
}

export interface QuotationImageStorage {
  put(input: { idempotencyKey: string; bytes: Buffer; mimeType: 'image/png' }): Promise<{ assetKey: string }>;
}

export interface QuotationImagePresentationResolver {
  resolve(assetKey: string): Promise<{ src: string; expiresAt: string }>;
}

export type QuotationImagePresentation = {
  src: string;
  alt: string;
};

const ITEM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ASSET_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

const exactKeys = (value: Record<string, unknown>, allowed: readonly string[], label: string): void => {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} contains forbidden field: ${unknown[0]}`);
};

const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is required.`);
  return value.trim();
};

const positive = (value: unknown, label: string): number => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be greater than 0.`);
  return number;
};

const integer = (value: unknown, label: string, minimum: number): number => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum) throw new Error(`${label} must be an integer >= ${minimum}.`);
  return number;
};

const dimensionSet = (value: unknown, label: string): DimensionSet => {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  exactKeys(value, ['length', 'depth', 'height'], label);
  return {
    length: positive(value.length, `${label}.length`),
    depth: positive(value.depth, `${label}.depth`),
    height: positive(value.height, `${label}.height`),
  };
};

const forbiddenKey = (key: string): boolean => {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalized === 'showprice') return false;
  return [
    'customer', 'client', 'phone', 'email', 'address', 'name', 'quotetoken', 'publictoken',
    'token', 'credential', 'password', 'secret', 'apikey', 'payment', 'card', 'price',
    'amount', 'total', 'profit', 'freight',
  ].some(part => normalized.includes(part));
};

const rejectForbiddenFields = (value: unknown, path = '$'): void => {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectForbiddenFields(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (forbiddenKey(key)) throw new Error(`Render request contains forbidden field at ${path}.${key}`);
    rejectForbiddenFields(item, `${path}.${key}`);
  }
};

export const sanitizeRenderRequest = (raw: unknown): RenderRequestV1 => {
  if (!isRecord(raw)) throw new Error('Render request must be an object.');
  rejectForbiddenFields(raw);
  exactKeys(raw, [
    'purpose', 'product_type', 'configuration_id', 'dimensions', 'cabinet_layers', 'accessories',
    'colours', 'engraving', 'model_preview', 'camera_preset', 'output', 'branding',
    'show_dimensions', 'show_price',
  ], 'Render request');
  if (raw.purpose !== 'quotation') throw new Error('Render purpose must be quotation.');
  if (!isRecord(raw.dimensions)) throw new Error('dimensions must be an object.');
  exactKeys(raw.dimensions, ['unit', 'inner', 'outer', 'actual'], 'dimensions');
  if (raw.dimensions.unit !== 'mm' && raw.dimensions.unit !== 'cm') throw new Error('dimensions.unit is invalid.');
  if (!Array.isArray(raw.cabinet_layers)) throw new Error('cabinet_layers must be an array.');
  if (!Array.isArray(raw.accessories)) throw new Error('accessories must be an array.');
  if (!isRecord(raw.colours)) throw new Error('colours must be an object.');
  exactKeys(raw.colours, ['body', 'accent', 'background'], 'colours');
  if (!isRecord(raw.output)) throw new Error('output must be an object.');
  exactKeys(raw.output, ['width', 'height', 'background'], 'output');
  if (raw.output.width !== QUOTATION_IMAGE_SIZE || raw.output.height !== QUOTATION_IMAGE_SIZE) {
    throw new Error('Quotation output must be 1280 x 1280.');
  }
  if (!['white', 'transparent', 'configured'].includes(String(raw.output.background))) {
    throw new Error('output.background is invalid.');
  }
  if (!isRecord(raw.branding)) throw new Error('branding must be an object.');
  exactKeys(raw.branding, ['enabled', 'style'], 'branding');
  if (typeof raw.branding.enabled !== 'boolean' || !['none', 'subtle_lks'].includes(String(raw.branding.style))) {
    throw new Error('branding is invalid.');
  }
  if (typeof raw.show_dimensions !== 'boolean') throw new Error('show_dimensions must be boolean.');
  if (raw.show_price !== false) throw new Error('show_price must be false.');

  const cabinetLayers = raw.cabinet_layers.map((layer, index) => {
    if (!isRecord(layer)) throw new Error(`cabinet_layers[${index}] must be an object.`);
    exactKeys(layer, ['layer_id', 'position', 'actual_height'], `cabinet_layers[${index}]`);
    return {
      layer_id: text(layer.layer_id, `cabinet_layers[${index}].layer_id`),
      position: integer(layer.position, `cabinet_layers[${index}].position`, 1),
      actual_height: positive(layer.actual_height, `cabinet_layers[${index}].actual_height`),
    };
  });
  const accessories = raw.accessories.map((accessory, index) => {
    if (!isRecord(accessory)) throw new Error(`accessories[${index}] must be an object.`);
    exactKeys(accessory, ['accessory_type', 'quantity', 'colour'], `accessories[${index}]`);
    return {
      accessory_type: text(accessory.accessory_type, `accessories[${index}].accessory_type`),
      quantity: integer(accessory.quantity, `accessories[${index}].quantity`, 0),
      ...(accessory.colour === undefined ? {} : { colour: String(accessory.colour) }),
    };
  });
  const engraving = raw.engraving === undefined ? undefined : (() => {
    if (!isRecord(raw.engraving)) throw new Error('engraving must be an object.');
    exactKeys(raw.engraving, ['enabled', 'artwork_asset_reference'], 'engraving');
    if (typeof raw.engraving.enabled !== 'boolean') throw new Error('engraving.enabled must be boolean.');
    return {
      enabled: raw.engraving.enabled,
      ...(raw.engraving.artwork_asset_reference === undefined
        ? {}
        : { artwork_asset_reference: String(raw.engraving.artwork_asset_reference) }),
    };
  })();
  const modelPreview = raw.model_preview === undefined ? undefined : (() => {
    if (!isRecord(raw.model_preview)) throw new Error('model_preview must be an object.');
    exactKeys(raw.model_preview, ['enabled', 'preset'], 'model_preview');
    if (typeof raw.model_preview.enabled !== 'boolean') throw new Error('model_preview.enabled must be boolean.');
    return {
      enabled: raw.model_preview.enabled,
      ...(raw.model_preview.preset === undefined ? {} : { preset: String(raw.model_preview.preset) }),
    };
  })();

  return {
    purpose: 'quotation',
    product_type: text(raw.product_type, 'product_type'),
    ...(raw.configuration_id === undefined ? {} : { configuration_id: text(raw.configuration_id, 'configuration_id') }),
    dimensions: {
      unit: raw.dimensions.unit,
      inner: dimensionSet(raw.dimensions.inner, 'dimensions.inner'),
      outer: dimensionSet(raw.dimensions.outer, 'dimensions.outer'),
      actual: dimensionSet(raw.dimensions.actual, 'dimensions.actual'),
    },
    cabinet_layers: cabinetLayers,
    accessories,
    colours: {
      body: text(raw.colours.body, 'colours.body'),
      ...(raw.colours.accent === undefined ? {} : { accent: String(raw.colours.accent) }),
      background: text(raw.colours.background, 'colours.background'),
    },
    ...(engraving ? { engraving } : {}),
    ...(modelPreview ? { model_preview: modelPreview } : {}),
    camera_preset: text(raw.camera_preset, 'camera_preset'),
    output: {
      width: QUOTATION_IMAGE_SIZE,
      height: QUOTATION_IMAGE_SIZE,
      background: raw.output.background as RenderRequestV1['output']['background'],
    },
    branding: {
      enabled: raw.branding.enabled,
      style: raw.branding.style as RenderRequestV1['branding']['style'],
    },
    show_dimensions: raw.show_dimensions,
    show_price: false,
  };
};

export const createImmutableItemId = (uuid: string = crypto.randomUUID()): string => {
  if (!ITEM_ID_PATTERN.test(uuid)) throw new Error('Item ID factory must return a UUID.');
  return uuid.toLowerCase();
};

export const isImmutableItemId = (value: unknown): value is string =>
  typeof value === 'string' && ITEM_ID_PATTERN.test(value);

export const ensureImmutableItemIds = <T extends Record<string, unknown>>(
  items: T[],
  options: { preserveExisting?: boolean; createId?: () => string } = {},
): Array<T & { item_id: string }> => {
  const seen = new Set<string>();
  return items.map(item => {
    const supplied = options.preserveExisting && isImmutableItemId(item.item_id)
      ? String(item.item_id).toLowerCase()
      : '';
    const itemId = supplied || createImmutableItemId((options.createId || crypto.randomUUID)());
    if (seen.has(itemId)) throw new Error('Duplicate item_id is not allowed.');
    seen.add(itemId);
    return { ...item, item_id: itemId };
  });
};

export const quotationImageIdempotencyKey = (itemId: string, rawRequest: unknown): string => {
  if (!isImmutableItemId(itemId)) throw new Error('A valid immutable item_id is required.');
  const request = sanitizeRenderRequest(rawRequest);
  const digest = crypto.createHash('sha256')
    .update(stableStringify({ contract: QUOTATION_IMAGE_CONTRACT, item_id: itemId, request }))
    .digest('hex');
  return `sha256:${digest}`;
};

export const pendingQuotationImageMetadata = (
  itemId: string,
  rawRequest: unknown,
  now = new Date().toISOString(),
): QuotationImageMetadata => ({
  contract: QUOTATION_IMAGE_CONTRACT,
  state: 'pending',
  idempotency_key: quotationImageIdempotencyKey(itemId, rawRequest),
  attempts: 0,
  updated_at: now,
});

export const quotationImageEnabled = (value: unknown): boolean =>
  typeof value === 'string' && /^(1|true|enabled)$/i.test(value.trim());

export class QuotationImageError extends Error {
  constructor(message: string, readonly classification: 'temporary' | 'terminal') {
    super(message);
  }
}

export class FakeQuotationImageRenderer implements QuotationImageRenderer {
  calls = 0;

  constructor(
    private readonly handler: (
      request: RenderRequestV1,
      context: { idempotencyKey: string; signal: AbortSignal },
    ) => Promise<RenderedQuotationImage>,
  ) {}

  async render(
    request: RenderRequestV1,
    context: { idempotencyKey: string; signal: AbortSignal },
  ): Promise<RenderedQuotationImage> {
    this.calls += 1;
    return this.handler(request, context);
  }
}

export class FixtureQuotationImageRenderer implements QuotationImageRenderer {
  calls = 0;

  constructor(private readonly result: RenderedQuotationImage) {}

  async render(_request: RenderRequestV1, context: { signal: AbortSignal }): Promise<RenderedQuotationImage> {
    this.calls += 1;
    if (context.signal.aborted) throw new QuotationImageError('Render aborted.', 'temporary');
    return this.result;
  }
}

export class LocalTestQuotationImageStorage implements QuotationImageStorage {
  private readonly assets = new Map<string, Buffer>();

  async put(input: { idempotencyKey: string; bytes: Buffer; mimeType: 'image/png' }): Promise<{ assetKey: string }> {
    if (input.mimeType !== 'image/png') throw new QuotationImageError('Only PNG is supported.', 'terminal');
    const digest = crypto.createHash('sha256').update(input.idempotencyKey).digest('hex');
    const assetKey = `test-only/quotation-images/${digest}.png`;
    if (!this.assets.has(assetKey)) this.assets.set(assetKey, Buffer.from(input.bytes));
    return { assetKey };
  }

  get(assetKey: string): Buffer | undefined {
    const value = this.assets.get(assetKey);
    return value ? Buffer.from(value) : undefined;
  }

  get size(): number {
    return this.assets.size;
  }
}

export class QuotationImageCoordinator {
  private readonly inFlight = new Map<string, Promise<QuotationImageMetadata>>();
  private readonly completed = new Map<string, QuotationImageMetadata>();

  constructor(
    private readonly renderer: QuotationImageRenderer,
    private readonly storage: QuotationImageStorage,
    private readonly options: {
      timeoutMs?: number;
      maxAttempts?: number;
      now?: () => string;
      retryDelay?: (attempt: number) => Promise<void>;
    } = {},
  ) {}

  async process(itemId: string, rawRequest: unknown): Promise<QuotationImageMetadata> {
    const request = sanitizeRenderRequest(rawRequest);
    const idempotencyKey = quotationImageIdempotencyKey(itemId, request);
    const completed = this.completed.get(idempotencyKey);
    if (completed) return { ...completed };
    const current = this.inFlight.get(idempotencyKey);
    if (current) return { ...(await current) };
    const operation = this.execute(request, idempotencyKey);
    this.inFlight.set(idempotencyKey, operation);
    try {
      const result = await operation;
      this.completed.set(idempotencyKey, result);
      return { ...result };
    } finally {
      this.inFlight.delete(idempotencyKey);
    }
  }

  private async execute(request: RenderRequestV1, idempotencyKey: string): Promise<QuotationImageMetadata> {
    const maxAttempts = Math.max(1, Math.min(5, this.options.maxAttempts || 3));
    const timeoutMs = Math.max(1, this.options.timeoutMs || 10_000);
    let lastClass: QuotationImageErrorClass = 'terminal';
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      try {
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new QuotationImageError('Quotation image render timed out.', 'temporary'));
          }, timeoutMs);
        });
        const rendered = await Promise.race([
          this.renderer.render(request, { idempotencyKey, signal: controller.signal }),
          timeout,
        ]);
        if (rendered.mimeType !== 'image/png'
          || rendered.width !== QUOTATION_IMAGE_SIZE
          || rendered.height !== QUOTATION_IMAGE_SIZE
          || rendered.bytes.length < PNG_SIGNATURE.length
          || !rendered.bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
          throw new QuotationImageError('Renderer returned an invalid quotation PNG.', 'terminal');
        }
        const stored = await this.storage.put({
          idempotencyKey,
          bytes: rendered.bytes,
          mimeType: rendered.mimeType,
        });
        if (!ASSET_KEY_PATTERN.test(stored.assetKey) || stored.assetKey.includes('..')) {
          throw new QuotationImageError('Storage returned an invalid asset_key.', 'terminal');
        }
        return {
          contract: QUOTATION_IMAGE_CONTRACT,
          state: 'ready',
          idempotency_key: idempotencyKey,
          asset_key: stored.assetKey,
          attempts: attempt,
          updated_at: (this.options.now || (() => new Date().toISOString()))(),
        };
      } catch (error) {
        const temporary = error instanceof QuotationImageError && error.classification === 'temporary';
        lastClass = /timed out/i.test(String((error as Error)?.message || error)) ? 'timeout' : temporary ? 'temporary' : 'terminal';
        if (!temporary || attempt === maxAttempts) {
          return {
            contract: QUOTATION_IMAGE_CONTRACT,
            state: 'failed',
            idempotency_key: idempotencyKey,
            attempts: attempt,
            error_class: lastClass,
            updated_at: (this.options.now || (() => new Date().toISOString()))(),
          };
        }
        await (this.options.retryDelay || (async () => undefined))(attempt);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw new Error('Unreachable quotation image state.');
  }
}

export const quotationImagePresentation = (
  item: QuoteItemWithQuotationImage,
  resolvedSrc?: string,
): QuotationImagePresentation | null => {
  const metadata = item.quotation_image;
  if (!metadata || metadata.state !== 'ready' || !metadata.asset_key || !resolvedSrc) return null;
  const safeSource = resolvedSrc.startsWith('/') || /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\//.test(resolvedSrc);
  if (!safeSource || resolvedSrc.startsWith('//')) return null;
  return {
    src: resolvedSrc,
    alt: 'Quotation product preview',
  };
};
