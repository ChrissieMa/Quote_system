import crypto from 'crypto';
import {
  QuotationImageError,
  type QuotationImageRenderer,
  type RenderedQuotationImage,
  type RenderRequestV1,
} from '../quotation-image';
import { quotationRenderRequestIdentity } from '../browser-quotation-image';

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
};

type CompletedRenderEvidence = {
  requestId: string;
  request: RenderRequestV1;
  requestIdentity: string;
  pngSha256: string;
  byteLength: number;
};

export type LocalBrowserRenderJob = {
  protocol: 'lks-quotation-image-local-v1';
  type: 'lks.quotation-image.render.request';
  request_id: string;
  render_request: RenderRequestV1;
};

export class LocalBrowserQuotationImageBridge implements QuotationImageRenderer {
  private readonly pending = new Map<string, PendingRender>();
  private lastCompletion: CompletedRenderEvidence | null = null;

  async render(
    request: RenderRequestV1,
    context: { idempotencyKey: string; signal: AbortSignal },
  ): Promise<RenderedQuotationImage> {
    const digest = String(context.idempotencyKey).replace(/^sha256:/, '');
    const requestId = `quote-${digest}`;
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      throw new QuotationImageError('Local browser bridge received an invalid idempotency key.', 'terminal');
    }
    if (context.signal.aborted) {
      throw new QuotationImageError('Local browser render aborted.', 'temporary');
    }
    if (this.pending.has(requestId)) {
      throw new QuotationImageError('Local browser bridge duplicate request.', 'temporary');
    }
    return new Promise<RenderedQuotationImage>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(requestId);
        reject(new QuotationImageError('Local browser render aborted.', 'temporary'));
      };
      context.signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(requestId, {
        requestId,
        request,
        delivered: false,
        resolve,
        reject,
        detachAbort: () => context.signal.removeEventListener('abort', onAbort),
      });
    });
  }

  takeNext(): LocalBrowserRenderJob | null {
    const pending = [...this.pending.values()].find(item => !item.delivered);
    if (!pending) return null;
    pending.delivered = true;
    return {
      protocol: 'lks-quotation-image-local-v1',
      type: 'lks.quotation-image.render.request',
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
    if (!pending) throw new Error('Local browser bridge request is unavailable.');
    if (input.contract !== '3d-render-v1'
      || input.mimeType !== 'image/png'
      || input.width !== 1280
      || input.height !== 1280
      || !REQUEST_IDENTITY_PATTERN.test(input.requestIdentity)
      || input.requestIdentity !== quotationRenderRequestIdentity(pending.request)
      || input.bytes.length < PNG_SIGNATURE.length
      || !Buffer.from(input.bytes.subarray(0, PNG_SIGNATURE.length)).equals(PNG_SIGNATURE)) {
      throw new Error('Local browser bridge artifact is invalid.');
    }
    this.pending.delete(input.requestId);
    pending.detachAbort();
    this.lastCompletion = {
      requestId: input.requestId,
      request: pending.request,
      requestIdentity: input.requestIdentity,
      pngSha256: crypto.createHash('sha256').update(input.bytes).digest('hex'),
      byteLength: input.bytes.length,
    };
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
      : 'quotation-image-local-transport-render-failed';
    pending.reject(new QuotationImageError(safeCode, 'temporary'));
  }

  status(): {
    protocol: 'lks-quotation-image-local-v1';
    pending_count: number;
    last_completed: CompletedRenderEvidence | null;
  } {
    return {
      protocol: 'lks-quotation-image-local-v1',
      pending_count: this.pending.size,
      last_completed: this.lastCompletion ? { ...this.lastCompletion } : null,
    };
  }
}

const normalizeTestRendererOrigin = (
  value: unknown,
  allowExactHttpsPreview = false,
): string => {
  const raw = String(value || '').trim();
  if (!raw || raw === '*') throw new Error('Local 3D renderer origin is required.');
  const parsed = new URL(raw);
  const loopback = parsed.protocol === 'http:'
    && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  const exactHttpsPreview = allowExactHttpsPreview && parsed.protocol === 'https:';
  if (!loopback && !exactHttpsPreview) {
    throw new Error('Local 3D renderer must use an HTTP loopback origin.');
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new Error('Local 3D renderer must be an origin without path, query or credentials.');
  }
  return parsed.origin;
};

export const localBrowserQuotationImageClientHtml = (
  rendererOriginValue: unknown,
  options: { allowExactHttpsPreview?: boolean } = {},
): string => {
  const rendererOrigin = normalizeTestRendererOrigin(
    rendererOriginValue,
    options.allowExactHttpsPreview === true,
  );
  return `<!doctype html>
<meta charset="utf-8">
<meta name="robots" content="noindex,nofollow">
<title>LKS Quote local 3D bridge</title>
<style>body{font:15px system-ui;background:#111827;color:#e5e7eb;margin:24px}pre{white-space:pre-wrap}iframe{width:1px;height:1px;border:0}</style>
<h1>TEST-ONLY Quote → 3D local bridge</h1>
<pre id="status">initialising</pre>
<iframe id="local-3d-renderer" src="${rendererOrigin}/" title="Local 3D renderer"></iframe>
<script type="module">
const rendererOrigin = ${JSON.stringify(rendererOrigin)};
const frame = document.getElementById('local-3d-renderer');
const status = document.getElementById('status');
let rendererReady = false;
let activeJob = null;
let pollTimer = null;

const schedulePoll = (delay = 250) => {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, delay);
};

const fail = async (requestId, errorCode) => {
  await fetch('/__test-only/quotation-image-bridge/fail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_id: requestId, error_code: String(errorCode || 'quotation-image-local-transport-render-failed') })
  });
};

const poll = async () => {
  if (!rendererReady || activeJob) return schedulePoll();
  try {
    const response = await fetch('/__test-only/quotation-image-bridge/next', { cache: 'no-store' });
    if (response.status === 204) return schedulePoll();
    if (!response.ok) throw new Error('bridge-next-failed');
    const job = await response.json();
    if (job?.protocol !== 'lks-quotation-image-local-v1'
      || job?.type !== 'lks.quotation-image.render.request'
      || typeof job?.request_id !== 'string'
      || !job?.render_request) throw new Error('bridge-job-invalid');
    activeJob = job;
    status.textContent = 'rendering ' + job.request_id;
    frame.contentWindow.postMessage(job, rendererOrigin);
  } catch (error) {
    status.textContent = 'poll error';
    schedulePoll(750);
  }
};

window.addEventListener('message', async event => {
  if (event.origin !== rendererOrigin || event.source !== frame.contentWindow || !activeJob) return;
  const response = event.data;
  if (response?.protocol !== 'lks-quotation-image-local-v1'
    || response?.type !== 'lks.quotation-image.render.response'
    || response?.request_id !== activeJob.request_id) return;
  const requestId = activeJob.request_id;
  activeJob = null;
  try {
    if (!response.ok) {
      await fail(requestId, response.error_code);
      status.textContent = 'renderer failed ' + requestId;
      return schedulePoll();
    }
    const artifact = response.artifact;
    if (artifact?.contract !== '3d-render-v1'
      || artifact?.mime_type !== 'image/png'
      || artifact?.width !== 1280
      || artifact?.height !== 1280
      || !(artifact?.png_bytes instanceof ArrayBuffer)) throw new Error('bridge-artifact-invalid');
    const completed = await fetch('/__test-only/quotation-image-bridge/complete/' + encodeURIComponent(requestId), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-LKS-Contract': artifact.contract,
        'X-LKS-Mime-Type': artifact.mime_type,
        'X-LKS-Width': String(artifact.width),
        'X-LKS-Height': String(artifact.height),
        'X-LKS-Request-Identity': String(artifact.request_identity || '')
      },
      body: artifact.png_bytes
    });
    if (!completed.ok) throw new Error('bridge-complete-failed');
    status.textContent = 'ready ' + requestId + ' (' + artifact.png_bytes.byteLength + ' bytes)';
    document.documentElement.dataset.lastCompletedRequest = requestId;
  } catch (error) {
    await fail(requestId, error instanceof Error ? error.message : 'bridge-client-failed');
    status.textContent = 'client failed ' + requestId + ' ('
      + (error instanceof Error ? error.message : 'bridge-client-failed') + ')';
  } finally {
    schedulePoll();
  }
});

frame.addEventListener('load', () => {
  setTimeout(() => {
    rendererReady = true;
    status.textContent = 'waiting for Quote jobs';
    schedulePoll(0);
  }, 1000);
});
</script>`;
};
