import crypto from 'crypto';

export const QUOTATION_IMAGE_CONTRACT = 'quotation-image-v1' as const;
export const RENDER_CONTRACT = '3d-render-v1' as const;
export const QUOTATION_IMAGE_SIZE = 1280;

export type DimensionSet = { length: number; depth: number; height: number };

export type RenderRequestV1 = {
  purpose: 'quotation' | 'social' | 'website';
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
  output: { width: number; height: number; background: 'white' | 'transparent' | 'configured' };
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
  order_item_identity?: { item_id: string; record_id: string };
};

export type RenderedQuotationImage = {
  bytes: Uint8Array;
  mimeType: 'image/png';
  width: 1280;
  height: 1280;
};

export interface QuotationImageRenderer {
  render(request: RenderRequestV1, context: { idempotencyKey: string; signal: AbortSignal }): Promise<RenderedQuotationImage>;
}

export interface QuotationImageStorage {
  put(input: { assetKey: string; idempotencyKey: string; bytes: Uint8Array; mimeType: 'image/png' }): Promise<{ assetKey: string }>;
}

export interface QuotationImagePresentationResolver {
  resolve(assetKey: string, context: { itemId: string }): Promise<{ src: string; expiresAt: string }>;
}

export type QuotationImageRuntimeAdapters = {
  coordinator?: QuotationImageCoordinator;
  storage?: QuotationImageStorage;
  jobScheduler?: QuotationImageJobScheduler;
  metadataWriter?: QuotationImageMetadataWriter;
  presentationResolver?: QuotationImagePresentationResolver;
};

export interface QuotationImageJobScheduler {
  enqueue(task: () => Promise<void>): void;
}

export interface QuotationImageMetadataWriter {
  update(input: { quoteRecordId: string; itemId: string; metadata: QuotationImageMetadata }): Promise<void>;
}

export type PreparedQuotationImageJob = {
  itemId: string;
  request: RenderRequestV1 & { purpose: 'quotation' };
};

// Deliberately empty in this development PR. An approved composition module
// can install provider adapters on this module singleton without changing the
// Quote persistence/presentation flows. No Production provider or credential
// is selected here.
export const quotationImageRuntime: QuotationImageRuntimeAdapters = {};

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
  if (!['quotation', 'social', 'website'].includes(String(raw.purpose))) throw new Error('Render purpose is invalid.');
  if (!isRecord(raw.dimensions)) throw new Error('dimensions must be an object.');
  exactKeys(raw.dimensions, ['unit', 'inner', 'outer', 'actual'], 'dimensions');
  if (raw.dimensions.unit !== 'mm' && raw.dimensions.unit !== 'cm') throw new Error('dimensions.unit is invalid.');
  if (!Array.isArray(raw.cabinet_layers)) throw new Error('cabinet_layers must be an array.');
  if (!Array.isArray(raw.accessories)) throw new Error('accessories must be an array.');
  if (!isRecord(raw.colours)) throw new Error('colours must be an object.');
  exactKeys(raw.colours, ['body', 'accent', 'background'], 'colours');
  if (!isRecord(raw.output)) throw new Error('output must be an object.');
  exactKeys(raw.output, ['width', 'height', 'background'], 'output');
  const outputWidth = integer(raw.output.width, 'output.width', 1);
  const outputHeight = integer(raw.output.height, 'output.height', 1);
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
    purpose: raw.purpose as RenderRequestV1['purpose'],
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
      width: outputWidth,
      height: outputHeight,
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

export const sanitizeQuotationRenderRequest = (raw: unknown): RenderRequestV1 & { purpose: 'quotation' } => {
  const request = sanitizeRenderRequest(raw);
  if (request.purpose !== 'quotation') throw new Error('Quotation render purpose must be quotation.');
  if (request.output.width !== QUOTATION_IMAGE_SIZE || request.output.height !== QUOTATION_IMAGE_SIZE) {
    throw new Error('Quotation output must be 1280 x 1280.');
  }
  return request as RenderRequestV1 & { purpose: 'quotation' };
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

export const linkQuoteItemsToOrderItemRecords = <T extends QuoteItemWithQuotationImage>(
  items: T[],
  records: ReadonlyArray<{ id: string }>,
): Array<T & { order_item_identity?: { item_id: string; record_id: string } }> => items.map((item, index) => {
  const record = records[index];
  if (!record || !record.id || !isImmutableItemId(item.item_id)) return item;
  return {
    ...item,
    order_item_identity: {
      item_id: item.item_id,
      record_id: record.id,
    },
  };
});

export const overlayConfirmedOrderItemsByIdentity = <
  T extends QuoteItemWithQuotationImage,
  R extends { id: string },
  U extends T,
>(
  baseItems: T[],
  linkedRecords: ReadonlyArray<R>,
  overlay: (baseItem: T, linkedRecord: R) => U,
): U[] => {
  const recordItemId = (record: R): string | null => {
    const direct = (record as R & { item_id?: unknown }).item_id;
    return isImmutableItemId(direct) ? direct.toLowerCase() : null;
  };
  const fullyLegacy = baseItems.every(item => !isImmutableItemId(item.item_id))
    && linkedRecords.every(record => !recordItemId(record));
  if (fullyLegacy) {
    return linkedRecords.map((record, index) => overlay((baseItems[index] || {}) as T, record));
  }
  const recordsById = new Map(linkedRecords.map(record => [record.id, record]));
  const recordsByItemId = new Map(
    linkedRecords.map(record => [recordItemId(record), record] as const).filter(([itemId]) => itemId),
  );
  return baseItems.map(item => {
    if (!isImmutableItemId(item.item_id)) return item as U;
    const directRecord = recordsByItemId.get(item.item_id.toLowerCase());
    if (directRecord) return overlay(item, directRecord);
    const identity = item.order_item_identity;
    if (!identity || identity.item_id !== item.item_id || !identity.record_id) return item as U;
    const record = recordsById.get(identity.record_id);
    return record ? overlay(item, record) : item as U;
  });
};

export const quotationImageIdempotencyKey = (itemId: string, rawRequest: unknown): string => {
  if (!isImmutableItemId(itemId)) throw new Error('A valid immutable item_id is required.');
  const request = sanitizeQuotationRenderRequest(rawRequest);
  const digest = crypto.createHash('sha256')
    .update(stableStringify({ contract: QUOTATION_IMAGE_CONTRACT, item_id: itemId, request }))
    .digest('hex');
  return `sha256:${digest}`;
};

export const pendingQuotationImageMetadata = (
  itemId: string,
  rawRequest: unknown,
  now = new Date().toISOString(),
): QuotationImageMetadata => {
  const idempotencyKey = quotationImageIdempotencyKey(itemId, rawRequest);
  return {
    contract: QUOTATION_IMAGE_CONTRACT,
    state: 'pending',
    idempotency_key: idempotencyKey,
    asset_key: quotationImageAssetKey(idempotencyKey),
    attempts: 0,
    updated_at: now,
  };
};

export const quotationImageAssetKey = (idempotencyKey: string): string => {
  const match = String(idempotencyKey).match(/^sha256:([a-f0-9]{64})$/);
  if (!match) throw new Error('A valid quotation image idempotency key is required.');
  return `quotation-images/${match[1]}.png`;
};

export const quotationImageEnabled = (value: unknown): boolean =>
  typeof value === 'string' && /^(1|true|enabled)$/i.test(value.trim());

const storedNumber = (value: unknown): number | null => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

type StoredAccessory = { name: string; quantity: number };
type CanonicalAccessory = RenderRequestV1['accessories'][number];

const whiteRing = (position: 'top' | 'bottom', ring: 'outer' | 'middle' | 'inner'): CanonicalAccessory => ({
  accessory_type: `light_${position}_${ring}_ring`,
  quantity: 1,
  colour: 'white',
});

const lightBoard = (
  mode: 'top_independent' | 'bottom_independent' | 'both_independent' | 'both_standard',
  positions: Array<'top' | 'bottom'>,
): CanonicalAccessory[] => [
  { accessory_type: `light_board_${mode}`, quantity: 1 },
  ...positions.flatMap(position => (
    ['outer', 'middle', 'inner'] as const
  ).map(ring => whiteRing(position, ring))),
];

// This is an explicit Quote -> 3D applicator allowlist. It intentionally does
// not include Quote engraving or panel-image accessories: the 3D applicator
// requires an approved asset provider for those and rejects them otherwise.
// Light rings/background entries mirror the 3D exporter output so the browser
// applicator can verify the materialized configuration exactly.
export const QUOTE_TO_3D_ACCESSORIES: Readonly<Record<string, readonly CanonicalAccessory[]>> = Object.freeze({
  '趟門': [{ accessory_type: 'door_sliding', quantity: 1 }],
  '磁石門': [{ accessory_type: 'door_magnetic', quantity: 1 }],
  '黑底板': [{ accessory_type: 'bottom_base_black', quantity: 1 }],
  '透明底板': [{ accessory_type: 'bottom_base_clear', quantity: 1 }],
  '獨立燈板 - 上燈': lightBoard('top_independent', ['top']),
  '獨立燈板 - 下燈': lightBoard('bottom_independent', ['bottom']),
  '獨立燈板 - 上下燈': lightBoard('both_independent', ['top', 'bottom']),
  '上下燈': lightBoard('both_standard', ['top', 'bottom']),
  '背燈': [
    { accessory_type: 'back_light', quantity: 1, colour: 'white' },
    { accessory_type: 'background_back', quantity: 1 },
  ],
  '左板鏡面': [{ accessory_type: 'mirror_left', quantity: 1 }],
  '右板鏡面': [{ accessory_type: 'mirror_right', quantity: 1 }],
  '底板鏡面': [{ accessory_type: 'mirror_bottom', quantity: 1 }],
  '頂板鏡面': [{ accessory_type: 'mirror_top', quantity: 1 }],
  '背板鏡面': [{ accessory_type: 'mirror_back', quantity: 1 }],
});

const parseStoredAccessories = (item: QuoteItemWithQuotationImage): StoredAccessory[] | null => {
  if (isRecord(item.accessoryQty)) {
    return Object.entries(item.accessoryQty).map(([name, value]) => ({
      name: name.trim(),
      quantity: Number(value),
    }));
  }
  if (!Array.isArray(item.accessories)) return [];
  return item.accessories.map(value => {
    const raw = String(value || '').trim();
    const match = raw.match(/^(.*?)\s+x(\d+)$/i);
    return {
      name: (match ? match[1] : raw).trim(),
      quantity: match ? Number(match[2]) : 1,
    };
  });
};

const storedAccessories = (item: QuoteItemWithQuotationImage): RenderRequestV1['accessories'] | null => {
  const stored = parseStoredAccessories(item);
  if (!stored) return null;
  if (stored.some(entry => !entry.name || entry.quantity !== 1 || !QUOTE_TO_3D_ACCESSORIES[entry.name])) {
    return null;
  }
  if (new Set(stored.map(entry => entry.name)).size !== stored.length) return null;

  const canonical = stored.flatMap(entry => QUOTE_TO_3D_ACCESSORIES[entry.name].map(accessory => ({ ...accessory })));
  const categoryCount = (prefix: string): number => canonical.filter(entry => entry.accessory_type.startsWith(prefix)).length;
  if (categoryCount('door_') > 1 || categoryCount('bottom_base_') > 1 || categoryCount('light_board_') > 1) {
    return null;
  }
  if (new Set(canonical.map(entry => entry.accessory_type)).size !== canonical.length) return null;
  return canonical;
};

const storedCabinetLayers = (item: QuoteItemWithQuotationImage): RenderRequestV1['cabinet_layers'] => {
  const count = Number(item.noOfLevels);
  if (!Number.isInteger(count) || count < 1 || !String(item.itemType || '').includes('Display Case')) return [];
  const segments = String(item.levelHeights || '')
    .split(/[|｜,，、;；/／\n]+/)
    .map(segment => (segment.match(/-?\d+(?:\.\d+)?/g) || []).map(Number).filter(Number.isFinite))
    .filter(values => values.length > 0)
    .map(values => values[values.length - 1]);
  const fallback = storedNumber(item.interH);
  const heights = segments.length === count
    ? segments
    : fallback
      ? Array.from({ length: count }, () => fallback)
      : [];
  if (heights.length !== count || heights.some(height => height <= 0)) return [];
  return heights.map((height, index) => ({
    layer_id: `layer-${index + 1}`,
    position: index + 1,
    actual_height: height,
  }));
};

// Quote currently stores product dimensions/accessories but not customer-safe
// colour selections. The approved quotation defaults below are presentation
// constants, not customer or business data. An incomplete item simply remains
// image-less so legacy and unsupported product types fail open.
export const buildQuotationRenderRequestFromQuoteItem = (
  item: QuoteItemWithQuotationImage,
): (RenderRequestV1 & { purpose: 'quotation' }) | null => {
  if (!isImmutableItemId(item.item_id)) return null;
  const productType = (() => {
    const stored = String(item.itemType || '').trim();
    if (stored === 'Display box 展示盒') return 'display_box';
    if (stored === 'Display Case 疊高展示櫃') return 'stacked_cabinet';
    return null;
  })();
  const inner = {
    length: storedNumber(item.interL),
    depth: storedNumber(item.interD),
    height: storedNumber(item.interH),
  };
  const outer = {
    length: storedNumber(item.outerL),
    depth: storedNumber(item.outerD),
    height: storedNumber(item.outerH),
  };
  if (!productType || Object.values(inner).some(value => value === null) || Object.values(outer).some(value => value === null)) {
    return null;
  }
  const accessories = storedAccessories(item);
  if (!accessories) return null;
  const request: RenderRequestV1 = {
    purpose: 'quotation',
    product_type: productType,
    configuration_id: item.item_id,
    dimensions: {
      unit: 'cm',
      inner: inner as DimensionSet,
      outer: outer as DimensionSet,
      actual: outer as DimensionSet,
    },
    cabinet_layers: storedCabinetLayers(item),
    accessories,
    colours: { body: 'clear_acrylic', background: 'light_blue_gray' },
    camera_preset: 'quotation_square_three_quarter_v2',
    output: { width: QUOTATION_IMAGE_SIZE, height: QUOTATION_IMAGE_SIZE, background: 'configured' },
    branding: { enabled: false, style: 'none' },
    show_dimensions: true,
    show_price: false,
  };
  return sanitizeQuotationRenderRequest(request);
};

export const prepareNewQuoteItemsWithQuotationImages = async <T extends QuoteItemWithQuotationImage>(
  items: T[],
  options: { enabled: boolean; coordinator?: QuotationImageCoordinator },
): Promise<Array<T & { quotation_image?: QuotationImageMetadata }>> => {
  if (!options.enabled || !options.coordinator) return items;
  const coordinator = options.coordinator;
  return Promise.all(items.map(async item => {
    const request = buildQuotationRenderRequestFromQuoteItem(item);
    if (!request || !item.item_id) return item;
    try {
      const metadata = await coordinator.process(item.item_id, request);
      return { ...item, quotation_image: metadata };
    } catch {
      // Unexpected adapter failures must never alter pricing or prevent the
      // authoritative Quote write. Expected failures are returned as metadata
      // by the coordinator and are persisted above.
      return item;
    }
  })) as Promise<Array<T & { quotation_image?: QuotationImageMetadata }>>;
};

export const prepareNewQuoteItemsForQuotationImageJobs = <T extends QuoteItemWithQuotationImage>(
  items: T[],
  options: { enabled: boolean; runtime: QuotationImageRuntimeAdapters; now?: string },
): { items: Array<T & { quotation_image?: QuotationImageMetadata }>; jobs: PreparedQuotationImageJob[] } => {
  const configured = options.runtime.coordinator
    && options.runtime.jobScheduler
    && options.runtime.metadataWriter;
  if (!options.enabled || !configured) return { items, jobs: [] };
  const jobs: PreparedQuotationImageJob[] = [];
  const prepared = items.map(item => {
    const request = buildQuotationRenderRequestFromQuoteItem(item);
    if (!request || !item.item_id) return item;
    jobs.push({ itemId: item.item_id, request });
    return {
      ...item,
      quotation_image: pendingQuotationImageMetadata(item.item_id, request, options.now),
    };
  });
  return { items: prepared, jobs };
};

export const scheduleQuotationImageJobsAfterWrite = (
  jobs: PreparedQuotationImageJob[],
  quoteRecordId: string,
  runtime: QuotationImageRuntimeAdapters,
): void => {
  const coordinator = runtime.coordinator;
  const scheduler = runtime.jobScheduler;
  const writer = runtime.metadataWriter;
  if (!coordinator || !scheduler || !writer || !quoteRecordId) return;
  for (const job of jobs) {
    try {
      scheduler.enqueue(async () => {
        try {
          const metadata = await coordinator.process(job.itemId, job.request);
          await writer.update({ quoteRecordId, itemId: job.itemId, metadata });
        } catch {
          // Renderer, storage and metadata-writer errors are isolated from the
          // already-completed authoritative Quote create response.
        }
      });
    } catch {
      // A scheduler refusing a job must likewise never change the create
      // response after the authoritative Quote write has succeeded.
    }
  }
};

export class InMemoryQuotationImageJobScheduler implements QuotationImageJobScheduler {
  private readonly tasks: Array<() => Promise<void>> = [];

  enqueue(task: () => Promise<void>): void {
    this.tasks.push(task);
  }

  get size(): number {
    return this.tasks.length;
  }

  async drain(): Promise<void> {
    while (this.tasks.length > 0) {
      const task = this.tasks.shift();
      if (task) await task();
    }
  }
}

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
  private readonly assets = new Map<string, Uint8Array>();

  async put(input: { assetKey: string; idempotencyKey: string; bytes: Uint8Array; mimeType: 'image/png' }): Promise<{ assetKey: string }> {
    if (input.mimeType !== 'image/png') throw new QuotationImageError('Only PNG is supported.', 'terminal');
    const assetKey = input.assetKey;
    if (!this.assets.has(assetKey)) this.assets.set(assetKey, Buffer.from(input.bytes));
    return { assetKey };
  }

  get(assetKey: string): Uint8Array | undefined {
    const value = this.assets.get(assetKey);
    return value ? new Uint8Array(value) : undefined;
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
    const request = sanitizeQuotationRenderRequest(rawRequest);
    const idempotencyKey = quotationImageIdempotencyKey(itemId, request);
    const completed = this.completed.get(idempotencyKey);
    if (completed) return { ...completed };
    const current = this.inFlight.get(idempotencyKey);
    if (current) return { ...(await current) };
    const operation = this.execute(request, idempotencyKey);
    this.inFlight.set(idempotencyKey, operation);
    try {
      const result = await operation;
      // Successful and terminal results are idempotent for this process.
      // Temporary/timeout results remain retryable on a later call while the
      // in-flight map still deduplicates concurrent callers.
      if (result.state === 'ready' || result.error_class === 'terminal') {
        this.completed.set(idempotencyKey, result);
      }
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
          || !Buffer.from(rendered.bytes.subarray(0, PNG_SIGNATURE.length)).equals(PNG_SIGNATURE)) {
          throw new QuotationImageError('Renderer returned an invalid quotation PNG.', 'terminal');
        }
        const stored = await this.storage.put({
          assetKey: quotationImageAssetKey(idempotencyKey),
          idempotencyKey,
          bytes: rendered.bytes,
          mimeType: rendered.mimeType,
        });
        const expectedAssetKey = quotationImageAssetKey(idempotencyKey);
        if (!ASSET_KEY_PATTERN.test(stored.assetKey) || stored.assetKey.includes('..')
          || stored.assetKey !== expectedAssetKey) {
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

export const resolveQuotationImagePresentation = async (
  item: QuoteItemWithQuotationImage,
  resolver?: QuotationImagePresentationResolver,
  now = Date.now(),
): Promise<QuotationImagePresentation | null> => {
  const metadata = item.quotation_image;
  if (!resolver || !isImmutableItemId(item.item_id) || !metadata
    || metadata.state !== 'ready' || !metadata.asset_key
    || !ASSET_KEY_PATTERN.test(metadata.asset_key) || metadata.asset_key.includes('..')) return null;
  try {
    const resolved = await resolver.resolve(metadata.asset_key, { itemId: item.item_id });
    const expiry = Date.parse(resolved.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= now) return null;
    return quotationImagePresentation(item, resolved.src);
  } catch {
    return null;
  }
};

export const resolveQuotationImagePresentations = async (
  items: QuoteItemWithQuotationImage[],
  options: { enabled: boolean; resolver?: QuotationImagePresentationResolver; now?: number },
): Promise<Map<string, QuotationImagePresentation>> => {
  const presentations = new Map<string, QuotationImagePresentation>();
  if (!options.enabled || !options.resolver) return presentations;
  await Promise.all(items.map(async item => {
    if (!isImmutableItemId(item.item_id)) return;
    const presentation = await resolveQuotationImagePresentation(item, options.resolver, options.now);
    if (presentation) presentations.set(item.item_id, presentation);
  }));
  return presentations;
};
