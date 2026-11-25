const websiteOrigin = 'https://lksdisplaybox.online';
const apiOrigin = 'https://quote.lksdisplaybox.online';
const handoffPath = '/api/attribution/v1/handoffs';
const revokePath = '/api/attribution/v1/revoke';

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export type AttributionBrowserAdapter = {
  create(path: string, body: unknown, headers: Record<string, string>): Promise<unknown>;
  revoke(path: string, body: unknown): Promise<void>;
};

export const createAttributionBrowserAdapter = (
  browser: Pick<Window, 'location'>,
  fetchImpl: typeof fetch,
): AttributionBrowserAdapter => {
  const post = async (path: string, body: unknown, headers: Record<string, string>): Promise<Response> => {
    if (browser.location.origin !== websiteOrigin) throw new Error('Attribution origin is not allowed.');
    const url = new URL(path, apiOrigin);
    if (url.origin !== apiOrigin || url.pathname !== path || url.search || url.hash) {
      throw new Error('Attribution path is not allowed.');
    }
    return fetchImpl(url.href, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      headers,
      body: JSON.stringify(body),
    });
  };

  return {
    async create(path, body, headers) {
      if (path !== handoffPath || !isRecord(body) || typeof body.requestId !== 'string'
          || Object.keys(headers).length !== 1 || headers['Idempotency-Key'] !== body.requestId) {
        throw new Error('Attribution request is invalid.');
      }
      const response = await post(path, body, {
        'Content-Type': 'application/json',
        'Idempotency-Key': body.requestId,
      });
      if (response.status !== 200 && response.status !== 201) throw new Error('Attribution request failed.');
      return response.json();
    },
    async revoke(path, body) {
      if (path !== revokePath || !isRecord(body)) throw new Error('Attribution request is invalid.');
      const response = await post(path, body, { 'Content-Type': 'application/json' });
      if (response.status !== 204) throw new Error('Attribution revocation failed.');
    },
  };
};
