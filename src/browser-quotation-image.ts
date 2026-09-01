import crypto from 'crypto';
import {
  QuotationImageError,
  type QuotationImageRenderer,
  type QuotationImageMetadata,
  type RenderedQuotationImage,
  type RenderRequestV1,
} from './quotation-image';

export const BROWSER_TRANSPORT_PROTOCOL = 'lks-quotation-image-browser-v1' as const;
export const BROWSER_RENDER_READY_TYPE = 'lks.quotation-image.render.ready' as const;
export const BROWSER_RENDER_CAPABILITY = '3d-render-v1' as const;
export const BROWSER_RENDER_REQUEST_TYPE = 'lks.quotation-image.render.request' as const;
export const BROWSER_RENDER_RESPONSE_TYPE = 'lks.quotation-image.render.response' as const;

const REQUEST_ID_PATTERN = /^quote-[a-f0-9]{64}$/;
const REQUEST_IDENTITY_PATTERN = /^3d-render-v1:sha256:[a-f0-9]{64}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type PendingRender = {
  requestId: string;
  request: RenderRequestV1;
  deliveredAt: number | null;
  deliveryCount: number;
  resolve: (value: RenderedQuotationImage) => void;
  reject: (reason: Error) => void;
  detachAbort: () => void;
  expectedRequestIdentity: string;
};

export type BrowserQuotationImageStatus = {
  state: 'waiting' | 'processing' | 'ready' | 'failed';
  updated_at: string;
  delivery_count: number;
};

export type BrowserQuotationImageJob = {
  protocol: typeof BROWSER_TRANSPORT_PROTOCOL;
  type: typeof BROWSER_RENDER_REQUEST_TYPE;
  request_id: string;
  render_request: RenderRequestV1;
};

export const normalizeQuotationImageRendererUrl = (value: unknown): string => {
  const raw = String(value || '').trim();
  if (!raw || raw === '*') throw new Error('Quotation-image renderer URL is required.');
  const parsed = new URL(raw);
  if (parsed.protocol !== 'https:' || parsed.hostname.includes('*')) {
    throw new Error('Quotation-image renderer URL must use an exact HTTPS host.');
  }
  if (parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error('Quotation-image renderer URL must not contain query, fragment or credentials.');
  }
  return parsed.href;
};

const canonicalize = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
};

export const quotationRenderRequestIdentity = (request: RenderRequestV1): string =>
  `3d-render-v1:sha256:${crypto.createHash('sha256').update(canonicalize(request)).digest('hex')}`;

export class BrowserQuotationImageBridge implements QuotationImageRenderer {
  private readonly pending = new Map<string, PendingRender>();
  private readonly statuses = new Map<string, BrowserQuotationImageStatus>();
  private readonly completed = new Set<string>();

  constructor(private readonly options: {
    deliveryLeaseMs?: number;
    maxDeliveries?: number;
    now?: () => number;
  } = {}) {}

  private rememberStatus(
    requestId: string,
    state: BrowserQuotationImageStatus['state'],
    deliveryCount = this.pending.get(requestId)?.deliveryCount || 0,
  ): void {
    this.statuses.set(requestId, {
      state,
      updated_at: new Date(this.options.now?.() ?? Date.now()).toISOString(),
      delivery_count: deliveryCount,
    });
    while (this.statuses.size > 256) this.statuses.delete(this.statuses.keys().next().value as string);
  }

  async render(
    request: RenderRequestV1,
    context: { idempotencyKey: string; signal: AbortSignal },
  ): Promise<RenderedQuotationImage> {
    const requestId = `quote-${String(context.idempotencyKey).replace(/^sha256:/, '')}`;
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      throw new QuotationImageError('Browser bridge received an invalid idempotency key.', 'terminal');
    }
    if (context.signal.aborted) throw new QuotationImageError('Browser render aborted.', 'temporary');
    if (this.pending.has(requestId)) {
      throw new QuotationImageError('Browser bridge duplicate request.', 'temporary');
    }
    return new Promise<RenderedQuotationImage>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(requestId);
        this.rememberStatus(requestId, 'failed', this.statuses.get(requestId)?.delivery_count || 0);
        reject(new QuotationImageError('Browser render aborted.', 'temporary'));
      };
      context.signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(requestId, {
        requestId,
        request,
        deliveredAt: null,
        deliveryCount: 0,
        resolve,
        reject,
        detachAbort: () => context.signal.removeEventListener('abort', onAbort),
        expectedRequestIdentity: quotationRenderRequestIdentity(request),
      });
      this.rememberStatus(requestId, 'waiting');
    });
  }

  takeNext(): BrowserQuotationImageJob | null {
    const now = this.options.now?.() ?? Date.now();
    const leaseMs = this.options.deliveryLeaseMs ?? 8_000;
    const maxDeliveries = this.options.maxDeliveries ?? 4;
    for (const pending of this.pending.values()) {
      if (pending.deliveredAt !== null && now - pending.deliveredAt < leaseMs) continue;
      if (pending.deliveryCount >= maxDeliveries) {
        this.pending.delete(pending.requestId);
        pending.detachAbort();
        this.rememberStatus(pending.requestId, 'failed', pending.deliveryCount);
        pending.reject(new QuotationImageError('quotation-image-browser-delivery-exhausted', 'temporary'));
        continue;
      }
      pending.deliveredAt = now;
      pending.deliveryCount += 1;
      this.rememberStatus(pending.requestId, 'processing', pending.deliveryCount);
      return {
        protocol: BROWSER_TRANSPORT_PROTOCOL,
        type: BROWSER_RENDER_REQUEST_TYPE,
        request_id: pending.requestId,
        render_request: pending.request,
      };
    }
    return null;
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
    const pending = this.pending.get(input.requestId);
    if (!pending && this.completed.has(input.requestId)) return false;
    if (!pending) throw new Error('Browser bridge request is unavailable.');
    if (input.contract !== '3d-render-v1'
      || input.mimeType !== 'image/png'
      || input.width !== 1280
      || input.height !== 1280
      || !REQUEST_IDENTITY_PATTERN.test(input.requestIdentity)
      || input.requestIdentity !== pending.expectedRequestIdentity
      || input.bytes.length < PNG_SIGNATURE.length
      || !Buffer.from(input.bytes.subarray(0, PNG_SIGNATURE.length)).equals(PNG_SIGNATURE)) {
      throw new Error('Browser bridge artifact is invalid.');
    }
    this.pending.delete(input.requestId);
    pending.detachAbort();
    this.completed.add(input.requestId);
    while (this.completed.size > 256) this.completed.delete(this.completed.values().next().value as string);
    this.rememberStatus(input.requestId, 'processing', pending.deliveryCount);
    pending.resolve({
      bytes: new Uint8Array(input.bytes),
      mimeType: 'image/png',
      width: 1280,
      height: 1280,
    });
    return true;
  }

  fail(requestId: string, errorCode: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    const safeCode = /^[a-z0-9._:$\-[\]]{1,240}$/i.test(errorCode)
      ? errorCode
      : 'quotation-image-browser-transport-render-failed';
    const maxDeliveries = this.options.maxDeliveries ?? 4;
    if (pending.deliveryCount < maxDeliveries) {
      pending.deliveredAt = null;
      this.rememberStatus(requestId, 'waiting', pending.deliveryCount);
      return;
    }
    this.pending.delete(requestId);
    pending.detachAbort();
    this.rememberStatus(requestId, 'failed', pending.deliveryCount);
    pending.reject(new QuotationImageError(safeCode, 'temporary'));
  }

  markMetadataPersisted(metadata: QuotationImageMetadata): void {
    const match = String(metadata.idempotency_key || '').match(/^sha256:([a-f0-9]{64})$/);
    if (!match) throw new Error('Browser bridge metadata identity is invalid.');
    const requestId = `quote-${match[1]}`;
    this.rememberStatus(
      requestId,
      metadata.state === 'ready' ? 'ready' : 'failed',
      this.statuses.get(requestId)?.delivery_count || 0,
    );
  }

  status(requestId: string): BrowserQuotationImageStatus | null {
    if (!REQUEST_ID_PATTERN.test(requestId)) return null;
    const status = this.statuses.get(requestId);
    return status ? { ...status } : null;
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

export type BrowserQuotationImageClientOptions = {
  bridgePath?: string;
  deferRendererLoadUntilListener?: boolean;
  showStageCounters?: boolean;
};

const normalizeBrowserBridgePath = (value: unknown): string => {
  const path = String(value || '/quotation-image/browser-bridge').trim();
  if (!/^\/[a-z0-9/_-]+$/i.test(path) || path.includes('//') || path.endsWith('/')) {
    throw new Error('Quotation-image browser bridge path is invalid.');
  }
  return path;
};

export const browserQuotationImageClientHtml = (
  rendererUrlValue: unknown,
  options: BrowserQuotationImageClientOptions = {},
): string => {
  const rendererUrl = normalizeQuotationImageRendererUrl(rendererUrlValue);
  const rendererOrigin = new URL(rendererUrl).origin;
  const bridgePath = normalizeBrowserBridgePath(options.bridgePath);
  const deferRendererLoad = options.deferRendererLoadUntilListener === true;
  const showStageCounters = options.showStageCounters === true;
  const iframeSourceAttribute = deferRendererLoad
    ? `data-renderer-src="${rendererUrl}"`
    : `src="${rendererUrl}"`;
  const stageCounterMarkup = showStageCounters
    ? '<pre id="handshake-counters">iframe_loaded=0\nready_received=0\nrequest_sent=0\nresponse_received=0\npng_valid=0\nwriter_ok=0\nfail_code=</pre>'
    : '';
  const statusVisibilityAttribute = showStageCounters ? ' hidden aria-hidden="true"' : '';
  const stageCounterScript = showStageCounters
    ? `const stageCounter = document.getElementById('handshake-counters');
const renderStageCounters = () => {
  stageCounter.textContent = [
    'iframe_loaded=' + stageCounts.iframe_loaded,
    'ready_received=' + stageCounts.ready_received,
    'request_sent=' + stageCounts.request_sent,
    'response_received=' + stageCounts.response_received,
    'png_valid=' + stageCounts.png_valid,
    'writer_ok=' + stageCounts.writer_ok,
    'fail_code=' + stageCounts.fail_code
  ].join('\\n');
};`
    : '';
  const stageCounterEmit = showStageCounters ? 'renderStageCounters();' : '';
  const deferredRendererStart = deferRendererLoad
    ? `frame.src = ${JSON.stringify(rendererUrl)};`
    : '';
  return `<!doctype html>
<meta charset="utf-8">
<meta name="robots" content="noindex,nofollow">
<title>LKS 3D quotation image</title>
<style>body{font:14px system-ui;margin:0;color:#334155}.status{padding:10px 12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px}iframe{width:1px;height:1px;border:0;position:absolute;left:-9999px}</style>
<div class="status" id="status"${statusVisibilityAttribute}>3D 圖片準備中…</div>
${stageCounterMarkup}
<iframe id="quotation-image-renderer" ${iframeSourceAttribute} title="3D quotation image renderer"></iframe>
<script>
const rendererOrigin = ${JSON.stringify(rendererOrigin)};
const frame = document.getElementById('quotation-image-renderer');
const status = document.getElementById('status');
let rendererReady = false;
let activeJob = null;
let pollTimer = null;
let readyTimer = null;
let responseTimer = null;
let recoverLatest = true;
let rendererReloads = 0;
const rendererReadyTimeoutMs = 8000;
const rendererResponseTimeoutMs = 6000;
const maxRendererReloads = 2;
const stageCounts = Object.seal({
  iframe_loaded: 0,
  ready_received: 0,
  request_sent: 0,
  response_received: 0,
  png_valid: 0,
  writer_ok: 0,
  fail_code: ''
});
${stageCounterScript}
const emitStage = (name, failCode = '') => {
  if (name && typeof stageCounts[name] === 'number') stageCounts[name] += 1;
  if (failCode) stageCounts.fail_code = /^[a-z0-9._:$-]{1,120}$/i.test(failCode)
    ? failCode : 'quotation-image-client-failed';
  ${stageCounterEmit}
  console.info('quotation-image-stage', JSON.stringify(stageCounts));
};
const schedulePoll = (delay = 300) => { clearTimeout(pollTimer); pollTimer = setTimeout(poll, delay); };
const reloadRenderer = failCode => {
  rendererReady = false;
  clearTimeout(readyTimer);
  clearTimeout(responseTimer);
  activeJob = null;
  emitStage('', failCode);
  status.textContent = '3D系統準備中；報價單已正常建立';
  if (rendererReloads >= maxRendererReloads) return;
  rendererReloads += 1;
  frame.src = ${JSON.stringify(rendererUrl)};
};
const armReadyTimeout = () => {
  clearTimeout(readyTimer);
  readyTimer = setTimeout(() => {
    if (!rendererReady) reloadRenderer('quotation-image-renderer-ready-timeout');
  }, rendererReadyTimeoutMs);
};
const isExactRendererReady = response => response && typeof response === 'object'
  && Object.keys(response).length === 3
  && response.protocol === '${BROWSER_TRANSPORT_PROTOCOL}'
  && response.type === '${BROWSER_RENDER_READY_TYPE}'
  && response.capability === '${BROWSER_RENDER_CAPABILITY}';
const fail = async (requestId, errorCode) => fetch(${JSON.stringify(`${bridgePath}/fail`)}, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ request_id: requestId, error_code: String(errorCode || 'quotation-image-browser-transport-render-failed') })
});
const waitForPersistence = async requestId => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await fetch(${JSON.stringify(`${bridgePath}/status/`)} + encodeURIComponent(requestId), { cache: 'no-store' });
    if (response.ok) {
      const result = await response.json();
      if (result?.state === 'ready' || result?.state === 'failed') return result.state;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return 'failed';
};
const poll = async () => {
  if (!rendererReady || activeJob) return schedulePoll();
  try {
    const recoveryQuery = recoverLatest ? '?recover_latest=1' : '';
    const response = await fetch(${JSON.stringify(`${bridgePath}/next`)} + recoveryQuery, { cache: 'no-store' });
    if (!response.ok) throw new Error('bridge-next-failed');
    recoverLatest = false;
    if (response.status === 204) { status.textContent = '3D 圖片已處理完成'; return schedulePoll(1000); }
    const job = await response.json();
    if (job?.protocol !== '${BROWSER_TRANSPORT_PROTOCOL}'
      || job?.type !== '${BROWSER_RENDER_REQUEST_TYPE}'
      || typeof job?.request_id !== 'string' || !job?.render_request) throw new Error('bridge-job-invalid');
    activeJob = job;
    status.textContent = '正在產生3D圖片…';
    frame.contentWindow.postMessage(job, rendererOrigin);
    emitStage('request_sent');
    clearTimeout(responseTimer);
    responseTimer = setTimeout(() => {
      if (activeJob?.request_id !== job.request_id) return;
      reloadRenderer('quotation-image-renderer-response-timeout');
    }, rendererResponseTimeoutMs);
  } catch { status.textContent = '3D圖片暫時未能產生；報價單已正常建立'; schedulePoll(1000); }
};
window.addEventListener('message', async event => {
  if (event.origin !== rendererOrigin || event.source !== frame.contentWindow) return;
  const response = event.data;
  if (isExactRendererReady(response)) {
    if (rendererReady || activeJob) return;
    rendererReady = true;
    rendererReloads = 0;
    clearTimeout(readyTimer);
    emitStage('ready_received');
    schedulePoll(0);
    return;
  }
  if (!activeJob) return;
  if (response?.protocol !== '${BROWSER_TRANSPORT_PROTOCOL}'
    || response?.type !== '${BROWSER_RENDER_RESPONSE_TYPE}'
    || response?.request_id !== activeJob.request_id) return;
  const requestId = activeJob.request_id;
  clearTimeout(responseTimer);
  activeJob = null;
  emitStage('response_received');
  try {
    if (!response.ok) throw new Error(String(response.error_code || 'quotation-image-renderer-failed'));
    const artifact = response.artifact;
    if (artifact?.contract !== '3d-render-v1' || artifact?.mime_type !== 'image/png'
      || artifact?.width !== 1280 || artifact?.height !== 1280
      || !(artifact?.png_bytes instanceof ArrayBuffer)) throw new Error('bridge-artifact-invalid');
    emitStage('png_valid');
    const completed = await fetch(${JSON.stringify(`${bridgePath}/complete/`)} + encodeURIComponent(requestId), {
      method: 'POST', headers: {
        'Content-Type': 'application/octet-stream', 'X-LKS-Contract': artifact.contract,
        'X-LKS-Mime-Type': artifact.mime_type, 'X-LKS-Width': String(artifact.width),
        'X-LKS-Height': String(artifact.height), 'X-LKS-Request-Identity': String(artifact.request_identity || '')
      }, body: artifact.png_bytes
    });
    if (!completed.ok) throw new Error('bridge-complete-failed');
    const persistedState = await waitForPersistence(requestId);
    if (persistedState !== 'ready') throw new Error('bridge-persistence-failed');
    emitStage('writer_ok');
    status.textContent = '3D 圖片已加入同一張報價單';
  } catch (error) {
    const failCode = error instanceof Error ? error.message : 'bridge-client-failed';
    await fail(requestId, failCode);
    emitStage('', failCode);
    status.textContent = '3D圖片暫時未能產生；報價單已正常建立';
  } finally { schedulePoll(); }
});
frame.addEventListener('load', () => {
  rendererReady = false;
  emitStage('iframe_loaded');
  clearTimeout(readyTimer);
  clearTimeout(responseTimer);
  activeJob = null;
  armReadyTimeout();
});
armReadyTimeout();
${deferredRendererStart}
</script>`;
};

export const quotationImageBridgeCsp = (rendererUrlValue: unknown): string => {
  const rendererOrigin = new URL(normalizeQuotationImageRendererUrl(rendererUrlValue)).origin;
  return `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src ${rendererOrigin}; connect-src 'self'`;
};

export const quotationImageArtifactDigest = (bytes: Uint8Array): string =>
  crypto.createHash('sha256').update(bytes).digest('hex');
