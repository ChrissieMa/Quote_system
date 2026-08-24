import crypto from 'crypto';
import {
  QuotationImageError,
  type QuotationImageRenderer,
  type QuotationImageMetadata,
  type RenderedQuotationImage,
  type RenderRequestV1,
} from './quotation-image';

export const BROWSER_TRANSPORT_PROTOCOL = 'lks-quotation-image-browser-v1' as const;
export const BROWSER_RENDER_REQUEST_TYPE = 'lks.quotation-image.render.request' as const;
export const BROWSER_RENDER_RESPONSE_TYPE = 'lks.quotation-image.render.response' as const;

const REQUEST_ID_PATTERN = /^quote-[a-f0-9]{64}$/;
const REQUEST_IDENTITY_PATTERN = /^3d-render-v1:sha256:[a-f0-9]{64}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type PendingRender = {
  requestId: string;
  request: RenderRequestV1;
  delivered: boolean;
  resolve: (value: RenderedQuotationImage) => void;
  reject: (reason: Error) => void;
  detachAbort: () => void;
  expectedRequestIdentity: string;
};

export type BrowserQuotationImageStatus = {
  state: 'waiting' | 'processing' | 'ready' | 'failed';
  updated_at: string;
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

  private rememberStatus(requestId: string, state: BrowserQuotationImageStatus['state']): void {
    this.statuses.set(requestId, { state, updated_at: new Date().toISOString() });
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
        this.rememberStatus(requestId, 'failed');
        reject(new QuotationImageError('Browser render aborted.', 'temporary'));
      };
      context.signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(requestId, {
        requestId,
        request,
        delivered: false,
        resolve,
        reject,
        detachAbort: () => context.signal.removeEventListener('abort', onAbort),
        expectedRequestIdentity: quotationRenderRequestIdentity(request),
      });
      this.rememberStatus(requestId, 'waiting');
    });
  }

  takeNext(): BrowserQuotationImageJob | null {
    const pending = [...this.pending.values()].find(item => !item.delivered);
    if (!pending) return null;
    pending.delivered = true;
    return {
      protocol: BROWSER_TRANSPORT_PROTOCOL,
      type: BROWSER_RENDER_REQUEST_TYPE,
      request_id: pending.requestId,
      render_request: pending.request,
    };
  }

  complete(input: {
    requestId: string;
    contract: string;
    mimeType: string;
    width: number;
    height: number;
    requestIdentity: string;
    bytes: Uint8Array;
  }): void {
    const pending = this.pending.get(input.requestId);
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
    this.rememberStatus(input.requestId, 'processing');
    pending.resolve({
      bytes: new Uint8Array(input.bytes),
      mimeType: 'image/png',
      width: 1280,
      height: 1280,
    });
  }

  fail(requestId: string, errorCode: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    pending.detachAbort();
    const safeCode = /^[a-z0-9._:$\-[\]]{1,240}$/i.test(errorCode)
      ? errorCode
      : 'quotation-image-browser-transport-render-failed';
    this.rememberStatus(requestId, 'failed');
    pending.reject(new QuotationImageError(safeCode, 'temporary'));
  }

  markMetadataPersisted(metadata: QuotationImageMetadata): void {
    const match = String(metadata.idempotency_key || '').match(/^sha256:([a-f0-9]{64})$/);
    if (!match) throw new Error('Browser bridge metadata identity is invalid.');
    this.rememberStatus(`quote-${match[1]}`, metadata.state === 'ready' ? 'ready' : 'failed');
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

export const browserQuotationImageClientHtml = (rendererUrlValue: unknown): string => {
  const rendererUrl = normalizeQuotationImageRendererUrl(rendererUrlValue);
  const rendererOrigin = new URL(rendererUrl).origin;
  return `<!doctype html>
<meta charset="utf-8">
<meta name="robots" content="noindex,nofollow">
<title>LKS 3D quotation image</title>
<style>body{font:14px system-ui;margin:0;color:#334155}.status{padding:10px 12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px}iframe{width:1px;height:1px;border:0;position:absolute;left:-9999px}</style>
<div class="status" id="status">3D 圖片準備中…</div>
<iframe id="quotation-image-renderer" src="${rendererUrl}" title="3D quotation image renderer"></iframe>
<script>
const rendererOrigin = ${JSON.stringify(rendererOrigin)};
const frame = document.getElementById('quotation-image-renderer');
const status = document.getElementById('status');
let rendererReady = false;
let activeJob = null;
let pollTimer = null;
const schedulePoll = (delay = 300) => { clearTimeout(pollTimer); pollTimer = setTimeout(poll, delay); };
const fail = async (requestId, errorCode) => fetch('/quotation-image/browser-bridge/fail', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ request_id: requestId, error_code: String(errorCode || 'quotation-image-browser-transport-render-failed') })
});
const waitForPersistence = async requestId => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await fetch('/quotation-image/browser-bridge/status/' + encodeURIComponent(requestId), { cache: 'no-store' });
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
    const response = await fetch('/quotation-image/browser-bridge/next', { cache: 'no-store' });
    if (response.status === 204) { status.textContent = '3D 圖片已處理完成'; return schedulePoll(1000); }
    if (!response.ok) throw new Error('bridge-next-failed');
    const job = await response.json();
    if (job?.protocol !== '${BROWSER_TRANSPORT_PROTOCOL}'
      || job?.type !== '${BROWSER_RENDER_REQUEST_TYPE}'
      || typeof job?.request_id !== 'string' || !job?.render_request) throw new Error('bridge-job-invalid');
    activeJob = job;
    status.textContent = '正在產生3D圖片…';
    frame.contentWindow.postMessage(job, rendererOrigin);
  } catch { status.textContent = '3D圖片暫時未能產生；報價單已正常建立'; schedulePoll(1000); }
};
window.addEventListener('message', async event => {
  if (event.origin !== rendererOrigin || event.source !== frame.contentWindow || !activeJob) return;
  const response = event.data;
  if (response?.protocol !== '${BROWSER_TRANSPORT_PROTOCOL}'
    || response?.type !== '${BROWSER_RENDER_RESPONSE_TYPE}'
    || response?.request_id !== activeJob.request_id) return;
  const requestId = activeJob.request_id;
  activeJob = null;
  try {
    if (!response.ok) { await fail(requestId, response.error_code); throw new Error('renderer-failed'); }
    const artifact = response.artifact;
    if (artifact?.contract !== '3d-render-v1' || artifact?.mime_type !== 'image/png'
      || artifact?.width !== 1280 || artifact?.height !== 1280
      || !(artifact?.png_bytes instanceof ArrayBuffer)) throw new Error('bridge-artifact-invalid');
    const completed = await fetch('/quotation-image/browser-bridge/complete/' + encodeURIComponent(requestId), {
      method: 'POST', headers: {
        'Content-Type': 'application/octet-stream', 'X-LKS-Contract': artifact.contract,
        'X-LKS-Mime-Type': artifact.mime_type, 'X-LKS-Width': String(artifact.width),
        'X-LKS-Height': String(artifact.height), 'X-LKS-Request-Identity': String(artifact.request_identity || '')
      }, body: artifact.png_bytes
    });
    if (!completed.ok) throw new Error('bridge-complete-failed');
    const persistedState = await waitForPersistence(requestId);
    if (persistedState !== 'ready') throw new Error('bridge-persistence-failed');
    status.textContent = '3D 圖片已加入同一張報價單';
  } catch (error) {
    await fail(requestId, error instanceof Error ? error.message : 'bridge-client-failed');
    status.textContent = '3D圖片暫時未能產生；報價單已正常建立';
  } finally { schedulePoll(); }
});
frame.addEventListener('load', () => { rendererReady = true; schedulePoll(0); });
setTimeout(() => { if (!rendererReady) status.textContent = '3D系統未能載入；報價單已正常建立'; }, 15000);
</script>`;
};

export const quotationImageBridgeCsp = (rendererUrlValue: unknown): string => {
  const rendererOrigin = new URL(normalizeQuotationImageRendererUrl(rendererUrlValue)).origin;
  return `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src ${rendererOrigin}; connect-src 'self'`;
};

export const quotationImageArtifactDigest = (bytes: Uint8Array): string =>
  crypto.createHash('sha256').update(bytes).digest('hex');
