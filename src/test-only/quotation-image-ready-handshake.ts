import crypto from 'crypto';
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
import { ADMIN_SESSION_COOKIE, parseCookies } from '../security';

export const QUOTATION_IMAGE_READY_HANDSHAKE_PATH = '/test-only/quotation-image-ready-handshake';
export const QUOTATION_IMAGE_READY_HANDSHAKE_BRIDGE_PATH = `${QUOTATION_IMAGE_READY_HANDSHAKE_PATH}/bridge`;
export const QUOTATION_IMAGE_READY_HANDSHAKE_RENDERER_URL = 'https://lksdisplaybox.online/configurator/';
export const QUOTATION_IMAGE_READY_HANDSHAKE_RUN_HEADER = 'x-lks-test-run';
export const QUOTATION_IMAGE_READY_HANDSHAKE_RUN_KEY_PATTERN = /^[a-f0-9]{32}$/;

export const quotationImageReadyHandshakeScopedRunKey = (
  cookieHeader: unknown,
  runKeyValue: unknown,
): string | null => {
  const runKey = String(runKeyValue || '');
  if (!QUOTATION_IMAGE_READY_HANDSHAKE_RUN_KEY_PATTERN.test(runKey)) return null;
  const authenticatedSession = parseCookies(cookieHeader)[ADMIN_SESSION_COOKIE] || '';
  if (!authenticatedSession) return null;
  const sessionScope = crypto.createHash('sha256').update(authenticatedSession).digest('hex');
  return `${sessionScope}:${runKey}`;
};

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
  terminal: boolean;
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
  private readonly runs = new Map<string, ActiveRun>();
  private readonly terminalRuns = new Set<string>();
  private readonly maxRuns = 32;

  constructor(private readonly options: { timeoutMs?: number } = {}) {}

  private createRun(now: string, runKey: string): ActiveRun {
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
      terminal: false,
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
      } else {
        run.writerCount += 1;
        run.completedAt = new Date().toISOString();
        bridge.markMetadataPersisted(metadata);
      }
      run.terminal = true;
      this.terminalRuns.add(runKey);
      while (this.terminalRuns.size > 256) {
        this.terminalRuns.delete(this.terminalRuns.values().next().value as string);
      }
      return metadata;
    });
    return run;
  }

  begin(now = new Date().toISOString(), runKey = 'default'): void {
    if (this.runs.has(runKey) || this.terminalRuns.has(runKey)) return;
    if (this.runs.size >= this.maxRuns) {
      for (const [key, run] of this.runs) {
        if (run.terminal) this.runs.delete(key);
        if (this.runs.size < this.maxRuns) break;
      }
    }
    if (this.runs.size >= this.maxRuns) {
      throw new Error('Quotation-image ready handshake run capacity reached.');
    }
    this.runs.set(runKey, this.createRun(now, runKey));
  }

  html(): string {
    return browserQuotationImageClientHtml(QUOTATION_IMAGE_READY_HANDSHAKE_RENDERER_URL, {
      bridgePath: QUOTATION_IMAGE_READY_HANDSHAKE_BRIDGE_PATH,
      deferRendererLoadUntilListener: true,
      showStageCounters: true,
      isolatedTestRun: true,
    });
  }

  takeNext(runKey = 'default') {
    this.begin(new Date().toISOString(), runKey);
    return this.runs.get(runKey)?.bridge.takeNext() || null;
  }

  complete(input: {
    requestId: string;
    contract: string;
    mimeType: string;
    width: number;
    height: number;
    requestIdentity: string;
    bytes: Uint8Array;
  }, runKey = 'default'): boolean {
    const run = this.runs.get(runKey);
    if (!run) throw new Error('Quotation-image ready handshake is not active.');
    const accepted = run.bridge.complete(input);
    if (!accepted) return false;
    run.completeCount += 1;
    run.pngBytes = input.bytes.length;
    run.pngSha256 = quotationImageArtifactDigest(input.bytes);
    run.requestIdentity = input.requestIdentity;
    return true;
  }

  fail(requestId: string, errorCode: string, runKey = 'default'): void {
    const run = this.runs.get(runKey);
    if (!run) return;
    run.failCount += 1;
    run.bridge.fail(requestId, errorCode);
  }

  status(requestId: string, runKey = 'default') {
    return this.runs.get(runKey)?.bridge.status(requestId) || null;
  }

  async waitForCompletion(runKey = 'default'): Promise<QuotationImageMetadata | null> {
    return this.runs.get(runKey)?.completion || null;
  }

  evidence(runKey = 'default'): QuotationImageReadyHandshakeEvidence {
    const run = this.runs.get(runKey);
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
