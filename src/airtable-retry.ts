export type AirtableRetryOptions = {
  maxAttempts?: number;
  delaysMs?: number[];
  sleep?: (delayMs: number) => Promise<void>;
  onRetry?: (details: { attempt: number; delayMs: number; error: unknown }) => void;
};

const DEFAULT_DELAYS_MS = [250, 750];

const errorStatus = (error: any): number | null => {
  const raw = error?.statusCode ?? error?.status ?? error?.response?.status;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

export const isRetryableAirtableReadError = (error: any): boolean => {
  const status = errorStatus(error);
  if (status !== null) return status === 408 || status === 425 || status === 429 || status >= 500;

  const code = String(error?.code || error?.error || error?.type || '').toUpperCase();
  if ([
    'CONNECTION_ERROR', 'ABORT_ERR', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN',
    'ENETDOWN', 'ENETUNREACH', 'ENOTFOUND', 'ETIMEDOUT', 'FETCH_ERROR',
  ].includes(code)) return true;

  const message = String(error?.message || error || '').toLowerCase();
  return [
    'failed, reason:', 'fetch failed', 'network', 'socket hang up', 'timed out',
    'timeout', 'connection reset', 'connection error', 'temporary failure',
  ].some(fragment => message.includes(fragment));
};

export const withAirtableReadRetry = async <T>(
  operation: () => Promise<T>,
  options: AirtableRetryOptions = {},
): Promise<T> => {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const delays = options.delaysMs?.length ? options.delaysMs : DEFAULT_DELAYS_MS;
  const sleep = options.sleep || ((delayMs: number) => new Promise(resolve => setTimeout(resolve, delayMs)));

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableAirtableReadError(error)) throw error;
      const delayMs = delays[Math.min(attempt - 1, delays.length - 1)] ?? 0;
      options.onRetry?.({ attempt, delayMs, error });
      if (delayMs > 0) await sleep(delayMs);
    }
  }
  throw lastError;
};

/**
 * Airtable.js 0.12 retries rate limits but not transient DNS/socket failures.
 * Install a read-only retry layer on the shared Base object so every GET/HEAD
 * used by dashboards and public documents gets the same protection. Writes are
 * deliberately never retried here because a lost response could duplicate a
 * Quote, Inquiry, Order, or payment mutation.
 */
export const installAirtableReadRetry = (
  baseFunctor: any,
  options: AirtableRetryOptions = {},
): void => {
  const baseObject = baseFunctor?._base;
  if (!baseObject || typeof baseObject.runAction !== 'function' || baseObject.__lksReadRetryInstalled) return;

  const originalRunAction = baseObject.runAction.bind(baseObject);
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const delays = options.delaysMs?.length ? options.delaysMs : DEFAULT_DELAYS_MS;

  baseObject.runAction = (
    method: string,
    path: string,
    queryParams: unknown,
    bodyData: unknown,
    callback: (error: any, response?: any, result?: any) => void,
  ) => {
    const normalizedMethod = String(method || '').toUpperCase();
    const isSafeRead = normalizedMethod === 'GET' || normalizedMethod === 'HEAD';
    let attempt = 1;

    const run = () => originalRunAction(method, path, queryParams, bodyData, (error: any, response?: any, result?: any) => {
      if (!isSafeRead || !error || attempt >= maxAttempts || !isRetryableAirtableReadError(error)) {
        callback(error, response, result);
        return;
      }
      const delayMs = delays[Math.min(attempt - 1, delays.length - 1)] ?? 0;
      options.onRetry?.({ attempt, delayMs, error });
      attempt += 1;
      setTimeout(run, Math.max(0, delayMs));
    });

    run();
  };
  baseObject.__lksReadRetryInstalled = true;
};
