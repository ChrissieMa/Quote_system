import crypto from 'crypto';
import type { Express, Request, Response as ExpressResponse } from 'express';
import {
  isImmutableItemId,
  QuotationImageError,
  type QuotationImagePresentationResolver,
  type QuotationImageSafeHttpClass,
  type QuotationImageStorage,
  type QuotationImageRuntimeAdapters,
} from './quotation-image';

const DRIVE_API_ORIGIN = 'https://www.googleapis.com';
const GOOGLE_OAUTH_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const ASSET_KEY_PATTERN = /^quotation-images\/([a-f0-9]{64})\.png$/;
const IDEMPOTENCY_KEY_PATTERN = /^sha256:([a-f0-9]{64})$/;
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{8,200}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PNG_BYTES = 10 * 1024 * 1024;
const QUOTATION_IMAGE_DIMENSION = 1280;
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

type FetchLike = typeof fetch;
type FetchResponse = Awaited<ReturnType<FetchLike>>;

export interface GoogleDriveAccessTokenProvider {
  getAccessToken(signal?: AbortSignal): Promise<string>;
  invalidateAccessToken?(): void;
}

export type GoogleOAuthRefreshTokenConfig = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetch?: FetchLike;
  tokenEndpoint?: string;
  timeoutMs?: number;
  now?: () => number;
};

const requiredSecret = (value: unknown, label: string): string => {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
};

const boundedInteger = (value: unknown, fallback: number, minimum: number, maximum: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
};

const timeoutSignal = (timeoutMs: number, parent?: AbortSignal): { signal: AbortSignal; cleanup(): void } => {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Google Drive request timed out.')), timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
};

export class GoogleOAuthRefreshTokenProvider implements GoogleDriveAccessTokenProvider {
  private accessToken = '';
  private expiresAt = 0;
  private readonly fetchImpl: FetchLike;
  private readonly tokenEndpoint: string;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly refreshToken: string;
  private inFlight?: Promise<string>;

  constructor(config: GoogleOAuthRefreshTokenConfig) {
    this.clientId = requiredSecret(config.clientId, 'Google OAuth client ID');
    this.clientSecret = requiredSecret(config.clientSecret, 'Google OAuth client secret');
    this.refreshToken = requiredSecret(config.refreshToken, 'Google OAuth refresh token');
    this.fetchImpl = config.fetch || fetch;
    this.tokenEndpoint = config.tokenEndpoint || GOOGLE_OAUTH_TOKEN_ENDPOINT;
    this.timeoutMs = boundedInteger(config.timeoutMs, 10_000, 500, 60_000);
    this.now = config.now || Date.now;
  }

  invalidateAccessToken(): void {
    this.accessToken = '';
    this.expiresAt = 0;
  }

  async getAccessToken(signal?: AbortSignal): Promise<string> {
    if (this.accessToken && this.expiresAt - this.now() > 60_000) return this.accessToken;
    if (this.inFlight) return this.inFlight;
    const operation = this.refresh(signal).finally(() => {
      if (this.inFlight === operation) this.inFlight = undefined;
    });
    this.inFlight = operation;
    return operation;
  }

  private async refresh(parentSignal?: AbortSignal): Promise<string> {
    const timed = timeoutSignal(this.timeoutMs, parentSignal);
    try {
      const response = await this.fetchImpl(this.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          refresh_token: this.refreshToken,
          grant_type: 'refresh_token',
        }),
        signal: timed.signal,
      });
      if (!response.ok) throw new Error(`Google OAuth token refresh failed (${response.status}).`);
      const body = await response.json() as Record<string, unknown>;
      const accessToken = requiredSecret(body.access_token, 'Google OAuth access token');
      const expiresIn = boundedInteger(body.expires_in, 3600, 60, 86_400);
      this.accessToken = accessToken;
      this.expiresAt = this.now() + expiresIn * 1000;
      return accessToken;
    } finally {
      timed.cleanup();
    }
  }
}

type DriveFile = {
  id: string;
  name?: string;
  mimeType?: string;
  trashed?: boolean;
  appProperties?: Record<string, string>;
  parents?: string[];
  permissions?: Array<{ id?: string; type?: string; role?: string }>;
  capabilities?: { canAddChildren?: boolean };
};

export type GoogleDriveQuotationImageStorageConfig = {
  accessTokenProvider: GoogleDriveAccessTokenProvider;
  fetch?: FetchLike;
  apiOrigin?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelay?: (attempt: number) => Promise<void>;
  folderId: string;
  expectedOwnerEmail: string;
};

const driveAssetDigest = (assetKey: string, idempotencyKey?: string): string => {
  const assetMatch = String(assetKey).match(ASSET_KEY_PATTERN);
  if (!assetMatch) throw new QuotationImageError('Google Drive asset_key is invalid.', 'terminal');
  if (idempotencyKey !== undefined) {
    const idempotencyMatch = String(idempotencyKey).match(IDEMPOTENCY_KEY_PATTERN);
    if (!idempotencyMatch || idempotencyMatch[1] !== assetMatch[1]) {
      throw new QuotationImageError('Google Drive idempotency identity does not match asset_key.', 'terminal');
    }
  }
  return assetMatch[1];
};

const isRetryableStatus = (status: number): boolean => status === 408 || status === 429 || status >= 500;
const safeHttpClass = (status: number): QuotationImageSafeHttpClass => {
  if (status === 408) return '408';
  if (status === 429) return '429';
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  return 'unknown';
};

const assertQuotationPng = (bytes: Uint8Array, message: string): void => {
  const png = Buffer.from(bytes);
  const hasIhdr = png.length >= 33
    && png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    && png.readUInt32BE(8) === 13
    && png.subarray(12, 16).toString('ascii') === 'IHDR';
  if (!hasIhdr
    || png.length > MAX_PNG_BYTES
    || png.readUInt32BE(16) !== QUOTATION_IMAGE_DIMENSION
    || png.readUInt32BE(20) !== QUOTATION_IMAGE_DIMENSION) {
    throw new QuotationImageError(message, 'terminal');
  }
};

export class GoogleDriveQuotationImageStorage implements QuotationImageStorage {
  private readonly fetchImpl: FetchLike;
  private readonly apiOrigin: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryDelay: (attempt: number) => Promise<void>;
  private readonly folderId: string;
  private readonly expectedOwnerEmail: string;
  private readonly inFlight = new Map<string, Promise<{ assetKey: string }>>();
  private preflight?: Promise<{ ownerPermissionId: string }>;

  constructor(private readonly config: GoogleDriveQuotationImageStorageConfig) {
    this.fetchImpl = config.fetch || fetch;
    this.apiOrigin = String(config.apiOrigin || DRIVE_API_ORIGIN).replace(/\/$/, '');
    this.timeoutMs = boundedInteger(config.timeoutMs, 10_000, 500, 60_000);
    this.maxAttempts = boundedInteger(config.maxAttempts, 3, 1, 5);
    this.retryDelay = config.retryDelay || (attempt => new Promise(resolve => setTimeout(resolve, attempt * 250)));
    this.folderId = requiredSecret(config.folderId, 'Google Drive quotation-image folder ID');
    if (!FILE_ID_PATTERN.test(this.folderId)) throw new Error('Google Drive quotation-image folder ID is invalid.');
    this.expectedOwnerEmail = requiredSecret(config.expectedOwnerEmail, 'Expected Google Drive OAuth owner').toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.expectedOwnerEmail)) {
      throw new Error('Expected Google Drive OAuth owner is invalid.');
    }
  }

  async put(input: {
    assetKey: string;
    idempotencyKey: string;
    bytes: Uint8Array;
    mimeType: 'image/png';
  }): Promise<{ assetKey: string }> {
    const digest = driveAssetDigest(input.assetKey, input.idempotencyKey);
    if (input.mimeType !== 'image/png') {
      throw new QuotationImageError('Google Drive storage accepts only PNG artifacts.', 'terminal');
    }
    assertQuotationPng(input.bytes, 'Google Drive storage accepts only 1280 x 1280 PNG artifacts.');
    const active = this.inFlight.get(input.assetKey);
    if (active) return active;
    const operation = this.putOnce(input.assetKey, digest, input.bytes).finally(() => {
      if (this.inFlight.get(input.assetKey) === operation) this.inFlight.delete(input.assetKey);
    });
    this.inFlight.set(input.assetKey, operation);
    return operation;
  }

  async read(assetKey: string): Promise<Uint8Array> {
    const digest = driveAssetDigest(assetKey);
    await this.ensurePreflight();
    const file = await this.findPrivateFile(digest);
    if (!file) throw new QuotationImageError('Google Drive quotation image was not found.', 'terminal');
    const response = await this.authorizedFetch(
      `${this.apiOrigin}/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`,
      { method: 'GET' },
    );
    if (!response.ok) throw this.driveError('Google Drive image download failed', response.status);
    const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (contentType !== 'image/png') {
      throw new QuotationImageError('Google Drive returned an invalid quotation image.', 'terminal');
    }
    assertQuotationPng(bytes, 'Google Drive returned an invalid quotation image.');
    return bytes;
  }

  private async putOnce(assetKey: string, digest: string, bytes: Uint8Array): Promise<{ assetKey: string }> {
    await this.ensurePreflight();
    const existing = await this.findPrivateFile(digest);
    if (existing) return { assetKey };
    const fileId = await this.generateFileId();
    const boundary = `lks-quotation-image-${digest}`;
    const metadata = {
      id: fileId,
      name: `quotation-image-${digest}.png`,
      mimeType: 'image/png',
      parents: [this.folderId],
      appProperties: {
        lks_contract: 'quotation-image-v1',
        lks_asset_digest: digest,
      },
    };
    const multipart = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Type: image/png\r\n\r\n`),
      Buffer.from(bytes),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await this.authorizedFetch(
      `${this.apiOrigin}/upload/drive/v3/files?uploadType=multipart&fields=id&ignoreDefaultVisibility=true`,
      {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: multipart,
      },
    );
    if (response.status === 409) {
      await this.getAndAssertPrivate(fileId, digest);
      await this.findPrivateFile(digest);
      return { assetKey };
    }
    if (!response.ok) throw this.driveError('Google Drive image upload failed', response.status);
    const created = await response.json() as Record<string, unknown>;
    if (String(created.id || '') !== fileId) throw new QuotationImageError('Google Drive returned an unexpected file ID.', 'terminal');
    await this.getAndAssertPrivate(fileId, digest);
    await this.findPrivateFile(digest);
    return { assetKey };
  }

  private async generateFileId(): Promise<string> {
    const parameters = new URLSearchParams({ count: '1', space: 'drive', type: 'files' });
    const response = await this.authorizedFetch(
      `${this.apiOrigin}/drive/v3/files/generateIds?${parameters}`,
      { method: 'GET' },
    );
    if (!response.ok) throw this.driveError('Google Drive file ID generation failed', response.status);
    const body = await response.json() as { ids?: unknown[] };
    const ids = (body.ids || []).map(String).filter(id => FILE_ID_PATTERN.test(id));
    if (ids.length !== 1) throw new QuotationImageError('Google Drive returned an invalid generated file ID.', 'terminal');
    return ids[0];
  }

  private async findPrivateFile(digest: string): Promise<DriveFile | null> {
    const query = `'${this.folderId}' in parents and trashed = false and appProperties has { key='lks_asset_digest' and value='${digest}' }`;
    const parameters = new URLSearchParams({
      q: query,
      spaces: 'drive',
      pageSize: '3',
      orderBy: 'createdTime,name',
      fields: 'files(id)',
    });
    const response = await this.authorizedFetch(`${this.apiOrigin}/drive/v3/files?${parameters}`, { method: 'GET' });
    if (!response.ok) throw this.driveError('Google Drive image lookup failed', response.status);
    const body = await response.json() as { files?: Array<{ id?: unknown }> };
    const rawIds = (body.files || []).map(file => String(file.id || ''));
    if (rawIds.some(id => !FILE_ID_PATTERN.test(id))) {
      throw new QuotationImageError('Google Drive lookup returned an invalid file identity.', 'terminal');
    }
    const ids = rawIds.filter(Boolean);
    if (ids.length === 0) return null;
    if (ids.length > 1) {
      throw new QuotationImageError('Google Drive contains duplicate files for one quotation image identity.', 'terminal');
    }
    return this.getAndAssertPrivate(ids[0], digest);
  }

  private async getAndAssertPrivate(fileId: string, digest: string): Promise<DriveFile> {
    const fields = 'id,name,mimeType,trashed,parents,appProperties,permissions(id,type,role)';
    const response = await this.authorizedFetch(
      `${this.apiOrigin}/drive/v3/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(fields)}`,
      { method: 'GET' },
    );
    if (!response.ok) throw this.driveError('Google Drive file verification failed', response.status);
    const file = await response.json() as DriveFile;
    const permissions = file.permissions || [];
    const ownerPermissionId = (await this.ensurePreflight()).ownerPermissionId;
    const privateOwnerOnly = permissions.length === 1
      && permissions[0].id === ownerPermissionId
      && permissions[0].type === 'user'
      && permissions[0].role === 'owner';
    if (!FILE_ID_PATTERN.test(String(file.id || ''))
      || file.mimeType !== 'image/png'
      || file.trashed === true
      || file.appProperties?.lks_contract !== 'quotation-image-v1'
      || file.appProperties?.lks_asset_digest !== digest
      || file.parents?.length !== 1
      || file.parents[0] !== this.folderId
      || !privateOwnerOnly) {
      throw new QuotationImageError('Google Drive file is not a private quotation image.', 'terminal');
    }
    return file;
  }

  private async ensurePreflight(): Promise<{ ownerPermissionId: string }> {
    if (this.preflight) return this.preflight;
    const operation = this.runPreflight().catch(error => {
      if (this.preflight === operation) this.preflight = undefined;
      throw error;
    });
    this.preflight = operation;
    return operation;
  }

  private async runPreflight(): Promise<{ ownerPermissionId: string }> {
    const aboutFields = 'user(emailAddress,permissionId)';
    const aboutResponse = await this.authorizedFetch(
      `${this.apiOrigin}/drive/v3/about?fields=${encodeURIComponent(aboutFields)}`,
      { method: 'GET' },
    );
    if (!aboutResponse.ok) throw this.driveError('Google Drive OAuth owner verification failed', aboutResponse.status);
    const about = await aboutResponse.json() as { user?: { emailAddress?: unknown; permissionId?: unknown } };
    const emailAddress = String(about.user?.emailAddress || '').trim().toLowerCase();
    const ownerPermissionId = String(about.user?.permissionId || '');
    if (emailAddress !== this.expectedOwnerEmail || !FILE_ID_PATTERN.test(ownerPermissionId)) {
      throw new QuotationImageError('Google Drive OAuth owner does not match the configured owner.', 'terminal');
    }

    const folderFields = 'id,mimeType,trashed,capabilities(canAddChildren),permissions(id,type,role)';
    const folderResponse = await this.authorizedFetch(
      `${this.apiOrigin}/drive/v3/files/${encodeURIComponent(this.folderId)}?fields=${encodeURIComponent(folderFields)}`,
      { method: 'GET' },
    );
    if (!folderResponse.ok) throw this.driveError('Google Drive quotation-image folder verification failed', folderResponse.status);
    const folder = await folderResponse.json() as DriveFile;
    const permissions = folder.permissions || [];
    const privateOwnerOnly = permissions.length === 1
      && permissions[0].id === ownerPermissionId
      && permissions[0].type === 'user'
      && permissions[0].role === 'owner';
    if (folder.id !== this.folderId
      || folder.mimeType !== 'application/vnd.google-apps.folder'
      || folder.trashed === true
      || folder.capabilities?.canAddChildren !== true
      || !privateOwnerOnly) {
      throw new QuotationImageError('Google Drive quotation-image folder is not a private writable owner folder.', 'terminal');
    }
    return { ownerPermissionId };
  }

  private async authorizedFetch(url: string, init: RequestInit): Promise<FetchResponse> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const timed = timeoutSignal(this.timeoutMs);
      try {
        const accessToken = await this.config.accessTokenProvider.getAccessToken(timed.signal);
        const response = await this.fetchImpl(url, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init.headers).entries()),
            Authorization: `Bearer ${accessToken}`,
          },
          signal: timed.signal,
        });
        if (response.status === 401 && attempt < this.maxAttempts) {
          this.config.accessTokenProvider.invalidateAccessToken?.();
          await this.retryDelay(attempt);
          continue;
        }
        if (isRetryableStatus(response.status) && attempt < this.maxAttempts) {
          await this.retryDelay(attempt);
          continue;
        }
        return response;
      } catch {
        if (attempt >= this.maxAttempts) break;
        await this.retryDelay(attempt);
      } finally {
        timed.cleanup();
      }
    }
    throw new QuotationImageError(
      'Google Drive request failed.',
      'temporary',
      { code: 'google-drive-network', httpClass: 'network' },
    );
  }

  private driveError(message: string, status: number): QuotationImageError {
    return new QuotationImageError(
      `${message} (${status}).`,
      isRetryableStatus(status) ? 'temporary' : 'terminal',
      {
        code: isRetryableStatus(status) ? 'google-drive-http-retryable' : 'google-drive-http-terminal',
        httpClass: safeHttpClass(status),
      },
    );
  }
}

type SignedProxyPayload = { v: 2; asset_key: string; item_id: string; expires_at: number };

export class GoogleDriveQuotationImageProxy {
  readonly routePath = '/quotation-images/google-drive/:token';
  readonly presentationResolver: QuotationImagePresentationResolver;
  private readonly secret: Buffer;
  private readonly ttlSeconds: number;
  private readonly now: () => number;

  constructor(
    private readonly storage: GoogleDriveQuotationImageStorage,
    options: { signingSecret: string; ttlSeconds?: number; now?: () => number },
  ) {
    const secret = requiredSecret(options.signingSecret, 'Quotation image proxy signing secret');
    if (Buffer.byteLength(secret) < 32) throw new Error('Quotation image proxy signing secret must be at least 32 bytes.');
    this.secret = Buffer.from(secret);
    this.ttlSeconds = boundedInteger(options.ttlSeconds, 300, 30, 900);
    this.now = options.now || Date.now;
    this.presentationResolver = {
      resolve: async (assetKey, context) => ({
        src: `/quotation-images/google-drive/${this.sign(assetKey, context.itemId)}`,
        expiresAt: new Date(this.now() + this.ttlSeconds * 1000).toISOString(),
      }),
    };
  }

  async read(token: string): Promise<Uint8Array> {
    const payload = this.verify(token);
    return this.storage.read(payload.asset_key);
  }

  private sign(assetKey: string, itemId: string): string {
    driveAssetDigest(assetKey);
    if (!isImmutableItemId(itemId)) throw new QuotationImageError('Quotation image proxy item identity is invalid.', 'terminal');
    const payload: SignedProxyPayload = {
      v: 2,
      asset_key: assetKey,
      item_id: itemId.toLowerCase(),
      expires_at: Math.floor(this.now() / 1000) + this.ttlSeconds,
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto.createHmac('sha256', this.secret).update(encoded).digest('base64url');
    return `${encoded}.${signature}`;
  }

  private verify(token: string): SignedProxyPayload {
    const [encoded, supplied, extra] = String(token || '').split('.');
    if (!encoded || !supplied || extra) throw new QuotationImageError('Quotation image proxy token is invalid.', 'terminal');
    const expected = crypto.createHmac('sha256', this.secret).update(encoded).digest();
    let suppliedBytes: Buffer;
    try {
      suppliedBytes = Buffer.from(supplied, 'base64url');
    } catch {
      throw new QuotationImageError('Quotation image proxy token is invalid.', 'terminal');
    }
    if (suppliedBytes.length !== expected.length || !crypto.timingSafeEqual(suppliedBytes, expected)) {
      throw new QuotationImageError('Quotation image proxy token is invalid.', 'terminal');
    }
    let payload: SignedProxyPayload;
    try {
      payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SignedProxyPayload;
    } catch {
      throw new QuotationImageError('Quotation image proxy token is invalid.', 'terminal');
    }
    driveAssetDigest(payload.asset_key);
    if (payload.v !== 2
      || !isImmutableItemId(payload.item_id)
      || !Number.isInteger(payload.expires_at)
      || payload.expires_at <= Math.floor(this.now() / 1000)) {
      throw new QuotationImageError('Quotation image proxy token has expired.', 'terminal');
    }
    return payload;
  }
}

export const registerGoogleDriveQuotationImageProxy = (
  app: Express,
  proxy: GoogleDriveQuotationImageProxy,
): void => {
  app.get(proxy.routePath, async (req: Request, res: ExpressResponse) => {
    try {
      const bytes = await proxy.read(String(req.params.token || ''));
      res.setHeader('Cache-Control', 'private, no-store, max-age=0');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      res.setHeader('Content-Disposition', 'inline; filename="quotation-image.png"');
      return res.type('image/png').send(Buffer.from(bytes));
    } catch {
      return res.status(404).type('text/plain').send('Quotation image unavailable.');
    }
  });
};

export type GoogleDriveQuotationImageProvider = {
  storage: GoogleDriveQuotationImageStorage;
  proxy: GoogleDriveQuotationImageProxy;
};

export const createGoogleDriveQuotationImageProviderFromEnvironment = (
  environment: NodeJS.ProcessEnv,
  options: { fetch?: FetchLike; now?: () => number } = {},
): GoogleDriveQuotationImageProvider | null => {
  const provider = String(environment.QUOTATION_IMAGE_STORAGE_PROVIDER || '').trim().toLowerCase();
  if (!provider) return null;
  if (provider !== 'google_drive') throw new Error('Unsupported quotation image storage provider.');
  const tokenProvider = new GoogleOAuthRefreshTokenProvider({
    clientId: requiredSecret(environment.GOOGLE_DRIVE_OAUTH_CLIENT_ID, 'GOOGLE_DRIVE_OAUTH_CLIENT_ID'),
    clientSecret: requiredSecret(environment.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET, 'GOOGLE_DRIVE_OAUTH_CLIENT_SECRET'),
    refreshToken: requiredSecret(environment.GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN, 'GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN'),
    fetch: options.fetch,
    now: options.now,
  });
  const storage = new GoogleDriveQuotationImageStorage({
    accessTokenProvider: tokenProvider,
    fetch: options.fetch,
    folderId: requiredSecret(
      environment.GOOGLE_DRIVE_QUOTATION_IMAGE_FOLDER_ID,
      'GOOGLE_DRIVE_QUOTATION_IMAGE_FOLDER_ID',
    ),
    expectedOwnerEmail: requiredSecret(
      environment.GOOGLE_DRIVE_EXPECTED_OWNER_EMAIL,
      'GOOGLE_DRIVE_EXPECTED_OWNER_EMAIL',
    ),
  });
  const proxy = new GoogleDriveQuotationImageProxy(storage, {
    signingSecret: requiredSecret(
      environment.QUOTATION_IMAGE_PROXY_SIGNING_SECRET,
      'QUOTATION_IMAGE_PROXY_SIGNING_SECRET',
    ),
    ttlSeconds: Number(environment.QUOTATION_IMAGE_PROXY_TTL_SECONDS || 300),
    now: options.now,
  });
  return { storage, proxy };
};

export const installGoogleDriveQuotationImageProvider = (
  app: Express,
  runtime: QuotationImageRuntimeAdapters,
  provider: GoogleDriveQuotationImageProvider,
): void => {
  runtime.storage = provider.storage;
  runtime.presentationResolver = provider.proxy.presentationResolver;
  registerGoogleDriveQuotationImageProxy(app, provider.proxy);
};

export const GOOGLE_DRIVE_QUOTATION_IMAGE_OAUTH_SCOPE = DRIVE_FILE_SCOPE;
