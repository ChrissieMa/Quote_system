import {
  BrowserQuotationImageBridge,
  browserQuotationImageClientHtml,
  quotationImageArtifactDigest,
} from '../browser-quotation-image';
import {
  QuotationImageCoordinator,
  type QuotationImageMetadata,
  type QuotationImageStorage,
  type RenderRequestV1,
} from '../quotation-image';

export const QUOTATION_IMAGE_READY_HANDSHAKE_PATH = '/test-only/quotation-image-ready-handshake';
export const QUOTATION_IMAGE_READY_HANDSHAKE_BRIDGE_PATH = `${QUOTATION_IMAGE_READY_HANDSHAKE_PATH}/bridge`;
export const QUOTATION_IMAGE_READY_HANDSHAKE_RENDERER_URL = 'https://lksdisplaybox.online/configurator-test/';

const SAFE_ITEM_ID = 'a44bce10-b278-4a90-97dd-52a73b01d59a';
const SAFE_RENDER_REQUEST: RenderRequestV1 = Object.freeze({
  purpose: 'quotation',
  product_type: 'display_box',
  dimensions: Object.freeze({
    unit: 'cm',
    inner: Object.freeze({ length: 40, depth: 30, height: 35 }),
    outer: Object.freeze({ length: 42, depth: 32, height: 36 }),
    actual: Object.freeze({ length: 42, depth: 32, height: 36 }),
  }),
  cabinet_layers: Object.freeze([]),
  accessories: Object.freeze([]),
  colours: Object.freeze({ body: 'clear_acrylic', background: 'light_blue_gray' }),
  camera_preset: 'quotation_square_three_quarter_v2',
  output: Object.freeze({ width: 1280, height: 1280, background: 'configured' }),
  branding: Object.freeze({ enabled: false, style: 'none' }),
  show_dimensions: true,
  show_price: false,
}) as unknown as RenderRequestV1;

export type QuotationImageReadyHandshakeEvidence = Readonly<{
  active: boolean;
  started_at: string | null;
  completed_at: string | null;
  complete: number;
  storage: number;
  attachment: number;
  writer: number;
  fail: number;
  png_bytes: number;
  png_sha256: string;
  request_identity: string;
}>;

type ActiveRun = {
  bridge: BrowserQuotationImageBridge;
  completeCount: number;
  storageCount: number;
  attachmentCount: number;
  writerCount: number;
  failCount: number;
  pngBytes: number;
  pngSha256: string;
  requestIdentity: string;
  startedAt: string;
  completedAt: string | null;
  completion: Promise<QuotationImageMetadata>;
};

const emptyEvidence = (): QuotationImageReadyHandshakeEvidence => Object.freeze({
  active: false,
  started_at: null,
  completed_at: null,
  complete: 0,
  storage: 0,
  attachment: 0,
  writer: 0,
  fail: 0,
  png_bytes: 0,
  png_sha256: '',
  request_identity: '',
});

export class QuotationImageReadyHandshakeFixture {
  private run: ActiveRun | null = null;

  constructor(private readonly options: { timeoutMs?: number } = {}) {}

  begin(now = new Date().toISOString()): void {
    const bridge = new BrowserQuotationImageBridge({ deliveryLeaseMs: 8_000, maxDeliveries: 2 });
    const run: ActiveRun = {
      bridge,
      completeCount: 0,
      storageCount: 0,
      attachmentCount: 0,
      writerCount: 0,
      failCount: 0,
      pngBytes: 0,
      pngSha256: '',
      requestIdentity: '',
      startedAt: now,
      completedAt: null,
      completion: Promise.resolve({} as QuotationImageMetadata),
    };
    const storage: QuotationImageStorage = {
      async put(input) {
        run.storageCount += 1;
        run.attachmentCount += 1;
        return { assetKey: input.assetKey };
      },
    };
    const coordinator = new QuotationImageCoordinator(bridge, storage, {
      timeoutMs: this.options.timeoutMs || 30_000,
      maxAttempts: 1,
    });
    run.completion = coordinator.process(SAFE_ITEM_ID, SAFE_RENDER_REQUEST).then(metadata => {
      if (metadata.state !== 'ready') {
        run.failCount += 1;
        return metadata;
      }
      run.writerCount += 1;
      run.completedAt = new Date().toISOString();
      bridge.markMetadataPersisted(metadata);
      return metadata;
    });
    this.run = run;
  }

  html(): string {
    return browserQuotationImageClientHtml(QUOTATION_IMAGE_READY_HANDSHAKE_RENDERER_URL, {
      bridgePath: QUOTATION_IMAGE_READY_HANDSHAKE_BRIDGE_PATH,
      deferRendererLoadUntilListener: true,
      showStageCounters: true,
    });
  }

  takeNext() {
    return this.run?.bridge.takeNext() || null;
  }

  complete(input: {
    requestId: string;
    contract: string;
    mimeType: string;
    width: number;
    height: number;
    requestIdentity: string;
    bytes: Uint8Array;
  }): boolean {
    if (!this.run) throw new Error('Quotation-image ready handshake is not active.');
    const accepted = this.run.bridge.complete(input);
    if (!accepted) return false;
    this.run.completeCount += 1;
    this.run.pngBytes = input.bytes.length;
    this.run.pngSha256 = quotationImageArtifactDigest(input.bytes);
    this.run.requestIdentity = input.requestIdentity;
    return true;
  }

  fail(requestId: string, errorCode: string): void {
    if (!this.run) return;
    this.run.failCount += 1;
    this.run.bridge.fail(requestId, errorCode);
  }

  status(requestId: string) {
    return this.run?.bridge.status(requestId) || null;
  }

  async waitForCompletion(): Promise<QuotationImageMetadata | null> {
    return this.run ? this.run.completion : null;
  }

  evidence(): QuotationImageReadyHandshakeEvidence {
    const run = this.run;
    if (!run) return emptyEvidence();
    return Object.freeze({
      active: true,
      started_at: run.startedAt,
      completed_at: run.completedAt,
      complete: run.completeCount,
      storage: run.storageCount,
      attachment: run.attachmentCount,
      writer: run.writerCount,
      fail: run.failCount,
      png_bytes: run.pngBytes,
      png_sha256: run.pngSha256,
      request_identity: run.requestIdentity,
    });
  }
}
