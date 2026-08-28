import crypto from 'crypto';

export const ADMIN_SESSION_COOKIE = 'lks_admin_session';
export const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const PUBLIC_TOKEN_TTL_DAYS_DEFAULT = 3650;

type AdminSessionPayload = {
  v: 1;
  sub: string;
  iat: number;
  exp: number;
  nonce: string;
};
export const safeEqual = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

export const parseCookies = (cookieHeader: unknown): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const part of String(cookieHeader || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name) continue;
    try {
      result[name] = decodeURIComponent(value);
    } catch {
      result[name] = value;
    }
  }
  return result;
};

export const issueAdminSession = (
  username: string,
  secret: string,
  now = Date.now(),
  ttlMs = ADMIN_SESSION_TTL_MS,
): string => {
  if (!username || !secret) throw new Error('Admin session configuration is incomplete.');
  const payload: AdminSessionPayload = {
    v: 1,
    sub: username,
    iat: now,
    exp: now + ttlMs,
    nonce: crypto.randomBytes(18).toString('base64url'),
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
};

export const verifyAdminSession = (
  token: string,
  expectedUsername: string,
  secret: string,
  now = Date.now(),
): boolean => {
  if (!token || !expectedUsername || !secret) return false;
  const [encoded, suppliedSignature, extra] = String(token).split('.');
  if (!encoded || !suppliedSignature || extra) return false;
  const expectedSignature = crypto.createHmac('sha256', secret).update(encoded).digest();
  let actualSignature: Buffer;
  try {
    actualSignature = Buffer.from(suppliedSignature, 'base64url');
  } catch {
    return false;
  }
  if (expectedSignature.length !== actualSignature.length || !crypto.timingSafeEqual(expectedSignature, actualSignature)) {
    return false;
  }
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as AdminSessionPayload;
    return payload.v === 1
      && safeEqual(String(payload.sub || ''), expectedUsername)
      && Number.isFinite(payload.iat)
      && Number.isFinite(payload.exp)
      && payload.iat <= now + 60_000
      && payload.exp > now
      && payload.exp - payload.iat <= ADMIN_SESSION_TTL_MS;
  } catch {
    return false;
  }
};

export const adminSessionCookie = (token: string, maxAgeSeconds = ADMIN_SESSION_TTL_MS / 1000): string =>
  `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${Math.floor(maxAgeSeconds)}; HttpOnly; Secure; SameSite=Strict`;

export const clearAdminSessionCookie = (): string =>
  `${ADMIN_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

export const sanitizeAdminNextPath = (value: unknown): string => {
  const path = String(value || '').trim();
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /[\r\n]/.test(path)) return '/quotes';
  const allowed = ['/quotes', '/quote/create', '/inquiry/create', '/admin/dashboard', '/admin/costs'];
  return allowed.some(prefix => path === prefix || path.startsWith(`${prefix}/`)) ? path : '/quotes';
};

export const isSameOriginWrite = (
  origin: unknown,
  referer: unknown,
  publicBaseUrl: string,
  requestOrigin = '',
  fetchSite: unknown = '',
): boolean => {
  const allowedOrigins = new Set<string>();
  for (const value of [publicBaseUrl, requestOrigin]) {
    try {
      if (value) allowedOrigins.add(new URL(value).origin);
    } catch {
      // Invalid configured/request origins are never trusted.
    }
  }
  if (allowedOrigins.size === 0) return false;
  const originValue = String(origin || '').trim();
  const refererValue = String(referer || '').trim();
  const candidate = originValue && originValue.toLowerCase() !== 'null'
    ? originValue
    : refererValue;
  if (!candidate) {
    // Some privacy-focused browsers suppress Origin/Referer on ordinary HTML
    // form posts. Chrome DevTools/remote-control sessions can also serialize a
    // same-origin form Origin as the opaque value "null". Sec-Fetch-Site is a
    // forbidden browser header, so page scripts cannot forge "same-origin"
    // from another site. Cross-site and headerless writes remain rejected.
    return String(fetchSite || '').toLowerCase() === 'same-origin' && Boolean(requestOrigin);
  }
  try {
    return allowedOrigins.has(new URL(candidate).origin);
  } catch {
    return false;
  }
};

export type LoginRateLimitResult = { allowed: boolean; retryAfterSeconds: number };

export class LoginRateLimiter {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly maxAttempts = 5, private readonly windowMs = 15 * 60 * 1000) {}

  check(key: string, now = Date.now()): LoginRateLimitResult {
    const current = this.attempts.get(key);
    if (!current || current.resetAt <= now) {
      this.attempts.delete(key);
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (current.count < this.maxAttempts) return { allowed: true, retryAfterSeconds: 0 };
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
  }

  fail(key: string, now = Date.now()): LoginRateLimitResult {
    const current = this.attempts.get(key);
    const next = !current || current.resetAt <= now
      ? { count: 1, resetAt: now + this.windowMs }
      : { count: current.count + 1, resetAt: current.resetAt };
    this.attempts.set(key, next);
    return this.check(key, now);
  }

  success(key: string): void {
    this.attempts.delete(key);
  }
}

const publicTokenPatterns = [
  { pattern: /^v3_([0-9a-z]{6,12})_([A-Za-z0-9_-]{22})$/, randomBytes: 16 },
  // Existing customer links remain valid after the shorter v3 format launches.
  { pattern: /^v2_([0-9a-z]{6,12})_([A-Za-z0-9_-]{43})$/, randomBytes: 32 },
] as const;

export const generatePublicToken = (now = Date.now()): string => {
  const issuedAtSeconds = Math.floor(now / 1000).toString(36);
  return `v3_${issuedAtSeconds}_${crypto.randomBytes(16).toString('base64url')}`;
};

export const formatDeterministicPublicToken = (issuedAt: number, digest: Buffer): string => {
  if (!Number.isFinite(issuedAt) || digest.length < 16) throw new Error('Unable to issue public token.');
  return `v3_${Math.floor(issuedAt / 1000).toString(36)}_${digest.subarray(0, 16).toString('base64url')}`;
};

export const publicTokenTtlMs = (rawDays: unknown): number => {
  const days = Number(rawDays || PUBLIC_TOKEN_TTL_DAYS_DEFAULT);
  const safeDays = Number.isFinite(days) && days >= 1 && days <= PUBLIC_TOKEN_TTL_DAYS_DEFAULT
    ? days
    : PUBLIC_TOKEN_TTL_DAYS_DEFAULT;
  return safeDays * 24 * 60 * 60 * 1000;
};

export const isValidPublicToken = (token: unknown, now = Date.now(), ttlMs = publicTokenTtlMs(undefined)): boolean => {
  const raw = String(token || '');
  const tokenFormat = publicTokenPatterns.find(({ pattern }) => pattern.test(raw));
  if (!tokenFormat) return false;
  const match = raw.match(tokenFormat.pattern);
  if (!match) return false;
  const issuedAtSeconds = parseInt(match[1], 36);
  if (!Number.isFinite(issuedAtSeconds)) return false;
  const issuedAt = issuedAtSeconds * 1000;
  if (issuedAt > now + 5 * 60 * 1000 || now - issuedAt > ttlMs) return false;
  try {
    return Buffer.from(match[2], 'base64url').length === tokenFormat.randomBytes;
  } catch {
    return false;
  }
};
