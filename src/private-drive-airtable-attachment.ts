import crypto from 'crypto';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import type { GoogleDriveAccessTokenProvider } from './google-drive-quotation-image';

const GOOGLE_DRIVE_ORIGIN = 'https://www.googleapis.com';
const AIRTABLE_API_ORIGIN = 'https://api.airtable.com';
const AIRTABLE_CONTENT_ORIGIN = 'https://content.airtable.com';
const DRIVE_FILE_ID = /^[A-Za-z0-9_-]{8,200}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const AIRTABLE_IDS = {
  baseId: /^app[A-Za-z0-9]{14}$/,
  tableId: /^tbl[A-Za-z0-9]{14}$/,
  recordId: /^rec[A-Za-z0-9]{14}$/,
  fieldId: /^fld[A-Za-z0-9]{14}$/,
  attachmentId: /^att[A-Za-z0-9]{8,}$/,
} as const;
const ALLOWED_MIME_TYPES = new Set<AttachmentMimeType>(['image/png', 'image/jpeg']);
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 8192;
const MAX_IMAGE_PIXELS = 16_000_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type FetchLike = typeof fetch;
type FetchResponse = Awaited<ReturnType<FetchLike>>;

export type AttachmentMimeType = 'image/png' | 'image/jpeg';

export type AttachmentTarget = Readonly<{
  baseId: string;
  tableId: string;
  recordId: string;
  fieldId: string;
}>;

export type AttachmentDescriptor = Readonly<{
  id: string;
  filename: string;
  url: string;
  mimeType: string;
  size: number;
}>;

export type PrivateDriveFile = Readonly<{
  fileId: string;
  bytes: Uint8Array;
  mimeType: AttachmentMimeType;
  size: number;
  sha256: string;
  parentFolderId: string;
}>;

export interface PrivateDriveFileProvider {
  download(input: { fileId: string; expectedSha256: string }): Promise<PrivateDriveFile>;
}

export interface AirtableAttachmentProvider {
  preflight(target: AttachmentTarget): Promise<{
    identity: AttachmentTarget;
    attachments: AttachmentDescriptor[];
  }>;
  list(target: AttachmentTarget): Promise<AttachmentDescriptor[]>;
  uploadRaw(input: {
    target: AttachmentTarget;
    filename: string;
    bytes: Uint8Array;
    mimeType: AttachmentMimeType;
  }): Promise<void>;
  download(attachment: AttachmentDescriptor): Promise<Uint8Array>;
}

export type TransferReceipt = Readonly<{
  contract: 'private-drive-airtable-attachment-v1';
  state: 'processed';
  outcome: 'created' | 'deduped';
  writeResolution: 'confirmed' | 'preexisting' | 'ambiguous_reconciled';
  idempotencyKey: string;
  source: {
    fileId: string;
    sha256: string;
    mimeType: AttachmentMimeType;
    size: number;
  };
  target: AttachmentTarget;
  attachment: {
    id: string;
    filename: string;
    sha256: string;
  };
  retention: {
    sourceDisposition: 'retained_private';
    retainUntil: string | null;
    deletionActor: 'external_operator';
  };
  beforeAttachmentIds: string[];
  lifecycle: Array<'pending' | 'downloaded' | 'validated' | 'uploaded' | 'verified' | 'processed'>;
  processedAt: string;
}>;

export type TransferFailureAudit = Readonly<{
  contract: 'private-drive-airtable-attachment-v1';
  state: 'error';
  code: string;
  mutation: 'none' | 'ambiguous' | 'attachment_created';
  idempotencyKey?: string;
  target?: AttachmentTarget;
  createdAttachmentId?: string;
  createdAttachmentFilename?: string;
  expectedSha256?: string;
  beforeAttachmentIds?: string[];
  sourceDisposition: 'retained_private';
  rollback: 'not_required' | 'manual_review' | 'eligible_after_reread';
  lifecycle: string[];
}>;

export class AttachmentTransferError extends Error {
  constructor(message: string, readonly audit: TransferFailureAudit) {
    super(message);
    this.name = 'AttachmentTransferError';
  }
}

const fail = (
  code: string,
  message: string,
  details: Partial<TransferFailureAudit> = {},
): never => {
  throw new AttachmentTransferError(message, {
    contract: 'private-drive-airtable-attachment-v1',
    state: 'error',
    code,
    mutation: 'none',
    sourceDisposition: 'retained_private',
    rollback: 'not_required',
    lifecycle: ['pending'],
    ...details,
  });
};

const required = (value: unknown, label: string): string => {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
};

const boundedInteger = (value: unknown, fallback: number, minimum: number, maximum: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
};

const sameTarget = (left: AttachmentTarget, right: AttachmentTarget): boolean =>
  left.baseId === right.baseId
  && left.tableId === right.tableId
  && left.recordId === right.recordId
  && left.fieldId === right.fieldId;

const targetKey = (target: AttachmentTarget): string =>
  `${target.baseId}/${target.tableId}/${target.recordId}/${target.fieldId}`;

export const assertAttachmentTarget = (target: AttachmentTarget): void => {
  for (const [key, pattern] of Object.entries(AIRTABLE_IDS).slice(0, 4) as Array<[keyof AttachmentTarget, RegExp]>) {
    if (!pattern.test(String(target?.[key] || ''))) throw new Error(`Airtable ${key} is invalid.`);
  }
};

export const fullSha256 = (bytes: Uint8Array): string =>
  crypto.createHash('sha256').update(bytes).digest('hex');

export const attachmentIdempotencyKey = (input: {
  fileId: string;
  fileSha256: string;
  recordId: string;
  fieldId: string;
}): string => {
  if (!DRIVE_FILE_ID.test(input.fileId)) throw new Error('Google Drive file ID is invalid.');
  if (!SHA256.test(input.fileSha256)) throw new Error('Expected SHA-256 is invalid.');
  if (!AIRTABLE_IDS.recordId.test(input.recordId) || !AIRTABLE_IDS.fieldId.test(input.fieldId)) {
    throw new Error('Airtable idempotency target is invalid.');
  }
  const canonical = JSON.stringify({
    v: 1,
    file_id: input.fileId,
    file_sha256: input.fileSha256,
    record_id: input.recordId,
    field_id: input.fieldId,
  });
  return `sha256:${crypto.createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
};

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const assertPng = (bytes: Uint8Array): void => {
  const png = Buffer.from(bytes);
  if (png.length < 57 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    fail('invalid_png', 'PNG signature or structure is invalid.');
  }
  let offset = 8;
  let chunks = 0;
  let ihdr = 0;
  let idat = 0;
  let iend = 0;
  while (offset < png.length) {
    if (offset + 12 > png.length) fail('truncated_png', 'PNG chunk is truncated.');
    const length = png.readUInt32BE(offset);
    if (length > png.length - offset - 12) fail('truncated_png', 'PNG chunk length exceeds the file.');
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    if (!/^[A-Za-z]{4}$/.test(type)) fail('invalid_png', 'PNG chunk type is invalid.');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const expectedCrc = png.readUInt32BE(dataEnd);
    if (crc32(png.subarray(offset + 4, dataEnd)) !== expectedCrc) {
      fail('invalid_png_crc', 'PNG chunk checksum is invalid.');
    }
    chunks += 1;
    if (type === 'IHDR') {
      ihdr += 1;
      if (chunks !== 1 || ihdr !== 1 || length !== 13) fail('invalid_png', 'PNG IHDR is invalid.');
      const width = png.readUInt32BE(dataStart);
      const height = png.readUInt32BE(dataStart + 4);
      const bitDepth = png[dataStart + 8];
      const colorType = png[dataStart + 9];
      const validDepths: Record<number, number[]> = {
        0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16],
      };
      if (!width || !height || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION
        || width * height > MAX_IMAGE_PIXELS || !validDepths[colorType]?.includes(bitDepth)
        || png[dataStart + 10] !== 0 || png[dataStart + 11] !== 0 || png[dataStart + 12] > 1) {
        fail('invalid_png', 'PNG IHDR values are invalid.');
      }
    } else if (type === 'IDAT') {
      if (ihdr !== 1 || iend) fail('invalid_png', 'PNG IDAT order is invalid.');
      idat += 1;
    } else if (type === 'IEND') {
      iend += 1;
      if (length !== 0 || iend !== 1 || idat < 1 || dataEnd + 4 !== png.length) {
        fail('invalid_png', 'PNG IEND or trailing data is invalid.');
      }
    } else if (iend) {
      fail('invalid_png', 'PNG contains data after IEND.');
    }
    offset = dataEnd + 4;
  }
  if (ihdr !== 1 || idat < 1 || iend !== 1 || offset !== png.length) {
    fail('invalid_png', 'PNG is incomplete.');
  }
};

const isJpegFrameMarker = (marker: number): boolean =>
  (marker >= 0xc0 && marker <= 0xc3)
  || (marker >= 0xc5 && marker <= 0xc7)
  || (marker >= 0xc9 && marker <= 0xcb)
  || (marker >= 0xcd && marker <= 0xcf);

const assertJpeg = (bytes: Uint8Array): void => {
  const jpeg = Buffer.from(bytes);
  if (jpeg.length < 20 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) fail('invalid_jpeg', 'JPEG SOI is invalid.');
  let offset = 2;
  let frames = 0;
  let scans = 0;
  let ended = false;
  while (offset < jpeg.length && !ended) {
    if (jpeg[offset] !== 0xff) fail('invalid_jpeg', 'JPEG marker boundary is invalid.');
    while (offset < jpeg.length && jpeg[offset] === 0xff) offset += 1;
    if (offset >= jpeg.length) fail('truncated_jpeg', 'JPEG marker is truncated.');
    const marker = jpeg[offset++];
    if (marker === 0xd9) {
      ended = true;
      break;
    }
    if (marker === 0x00 || marker === 0xd8) fail('invalid_jpeg', 'JPEG marker is invalid.');
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > jpeg.length) fail('truncated_jpeg', 'JPEG segment length is truncated.');
    const segmentLength = jpeg.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > jpeg.length) {
      fail('truncated_jpeg', 'JPEG segment exceeds the file.');
    }
    if (isJpegFrameMarker(marker)) {
      frames += 1;
      if (segmentLength < 8) fail('invalid_jpeg', 'JPEG frame header is invalid.');
      const precision = jpeg[offset + 2];
      const height = jpeg.readUInt16BE(offset + 3);
      const width = jpeg.readUInt16BE(offset + 5);
      if (![8, 12].includes(precision) || !width || !height
        || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) {
        fail('invalid_jpeg_dimensions', 'JPEG dimensions are outside the safe decode range.');
      }
    }
    if (marker !== 0xda) {
      offset += segmentLength;
      continue;
    }
    scans += 1;
    offset += segmentLength;
    let nextMarker = -1;
    while (offset < jpeg.length) {
      if (jpeg[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      let markerOffset = offset;
      while (markerOffset < jpeg.length && jpeg[markerOffset] === 0xff) markerOffset += 1;
      if (markerOffset >= jpeg.length) fail('truncated_jpeg', 'JPEG entropy data is truncated.');
      const candidate = jpeg[markerOffset];
      if (candidate === 0x00) {
        offset = markerOffset + 1;
        continue;
      }
      if (candidate >= 0xd0 && candidate <= 0xd7) {
        offset = markerOffset + 1;
        continue;
      }
      nextMarker = candidate;
      offset = markerOffset + 1;
      break;
    }
    if (nextMarker < 0) fail('truncated_jpeg', 'JPEG EOI is missing.');
    if (nextMarker === 0xd9) ended = true;
    else {
      offset -= 2;
      if (offset < 0 || jpeg[offset] !== 0xff) fail('invalid_jpeg', 'JPEG scan marker is invalid.');
    }
  }
  if (!ended || offset !== jpeg.length || frames !== 1 || scans < 1) {
    fail('invalid_jpeg', 'JPEG is incomplete or contains trailing data.');
  }
};

export const assertSafeImage = (bytes: Uint8Array, mimeType: AttachmentMimeType, maxBytes = DEFAULT_MAX_BYTES): void => {
  if (!ALLOWED_MIME_TYPES.has(mimeType)) fail('mime_not_allowed', 'Only PNG and JPEG attachments are allowed.');
  if (bytes.byteLength < 1 || bytes.byteLength > maxBytes) fail('invalid_size', 'Attachment size is outside the allowed range.');
  if (mimeType === 'image/png') assertPng(bytes);
  else assertJpeg(bytes);
  try {
    const decoded = mimeType === 'image/png'
      ? PNG.sync.read(Buffer.from(bytes), { checkCRC: true, skipRescale: true })
      : jpeg.decode(Buffer.from(bytes), {
        useTArray: true,
        tolerantDecoding: false,
        maxResolutionInMP: MAX_IMAGE_PIXELS / 1_000_000,
        maxMemoryUsageInMB: 64,
      });
    if (!decoded.width || !decoded.height || decoded.width > MAX_IMAGE_DIMENSION || decoded.height > MAX_IMAGE_DIMENSION
      || decoded.width * decoded.height > MAX_IMAGE_PIXELS || decoded.data.byteLength !== decoded.width * decoded.height * 4) {
      fail('image_decode_bounds_failed', 'Decoded image dimensions or pixel data are invalid.');
    }
  } catch (error) {
    if (error instanceof AttachmentTransferError) throw error;
    fail('image_decode_failed', 'Image bytes cannot be decoded safely.');
  }
};

const timeoutSignal = (timeoutMs: number): { signal: AbortSignal; cleanup(): void } => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Request timed out.')), timeoutMs);
  return { signal: controller.signal, cleanup: () => clearTimeout(timer) };
};

const isRetryableReadStatus = (status: number): boolean => status === 408 || status === 425 || status === 429 || status >= 500;

export class GooglePrivateDriveFileProvider implements PrivateDriveFileProvider {
  private readonly fetchImpl: FetchLike;
  private readonly expectedOwnerEmail: string;
  private readonly allowedFolderIds: Set<string>;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly maxReadAttempts: number;
  private readonly retryDelay: (attempt: number) => Promise<void>;

  constructor(private readonly config: {
    accessTokenProvider: GoogleDriveAccessTokenProvider;
    expectedOwnerEmail: string;
    allowedFolderIds: readonly string[];
    fetch?: FetchLike;
    maxBytes?: number;
    timeoutMs?: number;
    maxReadAttempts?: number;
    retryDelay?: (attempt: number) => Promise<void>;
  }) {
    this.fetchImpl = config.fetch || fetch;
    this.expectedOwnerEmail = required(config.expectedOwnerEmail, 'Expected Google Drive owner email').toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.expectedOwnerEmail)) throw new Error('Expected Google Drive owner email is invalid.');
    this.allowedFolderIds = new Set(config.allowedFolderIds.map(String));
    if (!this.allowedFolderIds.size || [...this.allowedFolderIds].some(id => !DRIVE_FILE_ID.test(id))) {
      throw new Error('Google Drive staging folder allowlist is invalid.');
    }
    this.maxBytes = boundedInteger(config.maxBytes, DEFAULT_MAX_BYTES, 1, DEFAULT_MAX_BYTES);
    this.timeoutMs = boundedInteger(config.timeoutMs, 10_000, 500, 60_000);
    this.maxReadAttempts = boundedInteger(config.maxReadAttempts, 3, 1, 5);
    this.retryDelay = config.retryDelay || (attempt => new Promise(resolve => setTimeout(resolve, attempt * 250)));
  }

  async download(input: { fileId: string; expectedSha256: string }): Promise<PrivateDriveFile> {
    if (!DRIVE_FILE_ID.test(input.fileId)) fail('invalid_file_id', 'Google Drive file ID is invalid.');
    if (!SHA256.test(input.expectedSha256)) fail('invalid_expected_sha256', 'Expected SHA-256 is invalid.');
    const about = await this.json(
      `${GOOGLE_DRIVE_ORIGIN}/drive/v3/about?fields=${encodeURIComponent('user(emailAddress,permissionId)')}`,
    ) as { user?: { emailAddress?: unknown; permissionId?: unknown } };
    const ownerEmail = String(about.user?.emailAddress || '').trim().toLowerCase();
    const ownerPermissionId = String(about.user?.permissionId || '');
    if (ownerEmail !== this.expectedOwnerEmail || !DRIVE_FILE_ID.test(ownerPermissionId)) {
      fail('drive_identity_mismatch', 'Google Drive OAuth identity does not match the configured owner.');
    }

    const fields = 'id,mimeType,size,sha256Checksum,trashed,parents,owners(emailAddress,permissionId),permissions(id,type,role)';
    const metadata = await this.json(
      `${GOOGLE_DRIVE_ORIGIN}/drive/v3/files/${encodeURIComponent(input.fileId)}?fields=${encodeURIComponent(fields)}`,
    ) as {
      id?: unknown; mimeType?: unknown; size?: unknown; sha256Checksum?: unknown; trashed?: unknown;
      parents?: unknown[]; owners?: Array<{ emailAddress?: unknown; permissionId?: unknown }>;
      permissions?: Array<{ id?: unknown; type?: unknown; role?: unknown }>;
    };
    const mimeType = String(metadata.mimeType || '') as AttachmentMimeType;
    const size = Number(metadata.size);
    const parents = (metadata.parents || []).map(String);
    const owners = metadata.owners || [];
    const permissions = metadata.permissions || [];
    const ownerMatches = owners.length === 1
      && String(owners[0].emailAddress || '').trim().toLowerCase() === ownerEmail
      && String(owners[0].permissionId || '') === ownerPermissionId;
    const ownerOnly = permissions.length === 1
      && String(permissions[0].id || '') === ownerPermissionId
      && permissions[0].type === 'user'
      && permissions[0].role === 'owner';
    if (metadata.id !== input.fileId || metadata.trashed === true || !ALLOWED_MIME_TYPES.has(mimeType)
      || !Number.isInteger(size) || size < 1 || size > this.maxBytes
      || parents.length !== 1 || !this.allowedFolderIds.has(parents[0]) || !ownerMatches || !ownerOnly) {
      fail('drive_file_identity_mismatch', 'Google Drive file metadata is outside the private staging allowlist.');
    }

    const response = await this.authorizedGet(
      `${GOOGLE_DRIVE_ORIGIN}/drive/v3/files/${encodeURIComponent(input.fileId)}?alt=media`,
    );
    const responseType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (responseType !== mimeType) fail('drive_content_type_mismatch', 'Google Drive raw response MIME type does not match metadata.');
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && Number(contentLength) !== size) {
      fail('drive_content_length_mismatch', 'Google Drive raw response length does not match metadata.');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== size) fail('drive_size_mismatch', 'Google Drive returned a partial or oversized file.');
    assertSafeImage(bytes, mimeType, this.maxBytes);
    const sha256 = fullSha256(bytes);
    const metadataSha256 = String(metadata.sha256Checksum || '').toLowerCase();
    if ((metadataSha256 && metadataSha256 !== sha256) || sha256 !== input.expectedSha256) {
      fail('drive_sha256_mismatch', 'Google Drive file SHA-256 does not match the expected full-file digest.');
    }
    return { fileId: input.fileId, bytes, mimeType, size, sha256, parentFolderId: parents[0] };
  }

  private async json(url: string): Promise<unknown> {
    const response = await this.authorizedGet(url);
    const type = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') fail('drive_invalid_response', 'Google Drive returned a non-JSON metadata response.');
    return response.json();
  }

  private async authorizedGet(url: string): Promise<FetchResponse> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxReadAttempts; attempt += 1) {
      const timed = timeoutSignal(this.timeoutMs);
      try {
        const token = await this.config.accessTokenProvider.getAccessToken(timed.signal);
        const response = await this.fetchImpl(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
          redirect: 'error',
          signal: timed.signal,
        });
        if (response.status === 401 && attempt < this.maxReadAttempts) {
          this.config.accessTokenProvider.invalidateAccessToken?.();
          await this.retryDelay(attempt);
          continue;
        }
        if (isRetryableReadStatus(response.status) && attempt < this.maxReadAttempts) {
          await this.retryDelay(attempt);
          continue;
        }
        if (!response.ok) fail('drive_read_failed', `Google Drive authenticated read failed (${response.status}).`);
        return response;
      } catch (error) {
        if (error instanceof AttachmentTransferError) throw error;
        lastError = error;
        if (attempt < this.maxReadAttempts) await this.retryDelay(attempt);
      } finally {
        timed.cleanup();
      }
    }
    const message = lastError instanceof Error ? lastError.message : 'Google Drive authenticated read failed.';
    return fail('drive_read_failed', message);
  }
}

const assertAirtableIdentity = (actual: AttachmentTarget, expected: AttachmentTarget): void => {
  if (!sameTarget(actual, expected)) fail('airtable_identity_mismatch', 'Airtable target identity does not match the allowlisted target.');
};

const parseAttachments = (value: unknown): AttachmentDescriptor[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('airtable_invalid_attachments', 'Airtable attachment field is not an array.');
  return (value as unknown[]).map((raw: unknown) => {
    const attachment = raw as Record<string, unknown>;
    const id = String(attachment.id || '');
    const filename = String(attachment.filename || '');
    const url = String(attachment.url || '');
    const mimeType = String(attachment.type || attachment.mimeType || '');
    const size = Number(attachment.size);
    if (!AIRTABLE_IDS.attachmentId.test(id) || !filename || !url || !Number.isInteger(size) || size < 1) {
      return fail('airtable_invalid_attachment_identity', 'Airtable returned an invalid attachment identity.');
    }
    return { id, filename, url, mimeType, size };
  });
};

export class AirtableHttpAttachmentProvider implements AirtableAttachmentProvider {
  private readonly token: string;
  private readonly expectedUserId: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxReadAttempts: number;
  private readonly retryDelay: (attempt: number) => Promise<void>;

  constructor(config: {
    token: string;
    expectedUserId: string;
    fetch?: FetchLike;
    timeoutMs?: number;
    maxReadAttempts?: number;
    retryDelay?: (attempt: number) => Promise<void>;
  }) {
    this.token = required(config.token, 'Airtable personal access token');
    this.expectedUserId = required(config.expectedUserId, 'Expected Airtable user ID');
    if (!/^usr[A-Za-z0-9]{8,}$/.test(this.expectedUserId)) throw new Error('Expected Airtable user ID is invalid.');
    this.fetchImpl = config.fetch || fetch;
    this.timeoutMs = boundedInteger(config.timeoutMs, 10_000, 500, 60_000);
    this.maxReadAttempts = boundedInteger(config.maxReadAttempts, 3, 1, 5);
    this.retryDelay = config.retryDelay || (attempt => new Promise(resolve => setTimeout(resolve, attempt * 250)));
  }

  async preflight(target: AttachmentTarget): Promise<{ identity: AttachmentTarget; attachments: AttachmentDescriptor[] }> {
    assertAttachmentTarget(target);
    const whoami = await this.readJson(`${AIRTABLE_API_ORIGIN}/v0/meta/whoami`) as { id?: unknown };
    if (String(whoami.id || '') !== this.expectedUserId) fail('airtable_user_mismatch', 'Airtable API identity does not match the configured user.');
    const schema = await this.readJson(`${AIRTABLE_API_ORIGIN}/v0/meta/bases/${target.baseId}/tables`) as {
      tables?: Array<{ id?: unknown; fields?: Array<{ id?: unknown; type?: unknown }> }>;
    };
    const tables = (schema.tables || []).filter(table => table.id === target.tableId);
    const fields = tables[0]?.fields?.filter(field => field.id === target.fieldId) || [];
    if (tables.length !== 1 || fields.length !== 1 || fields[0].type !== 'multipleAttachments') {
      fail('airtable_schema_identity_mismatch', 'Airtable table or attachment field identity is invalid.');
    }
    return { identity: { ...target }, attachments: await this.list(target) };
  }

  async list(target: AttachmentTarget): Promise<AttachmentDescriptor[]> {
    assertAttachmentTarget(target);
    const record = await this.readJson(
      `${AIRTABLE_API_ORIGIN}/v0/${target.baseId}/${target.tableId}/${target.recordId}?returnFieldsByFieldId=true`,
    ) as { id?: unknown; fields?: Record<string, unknown> };
    if (record.id !== target.recordId || !record.fields || typeof record.fields !== 'object') {
      fail('airtable_record_identity_mismatch', 'Airtable record identity does not match the allowlisted target.');
    }
    return parseAttachments((record.fields as Record<string, unknown>)[target.fieldId]);
  }

  async uploadRaw(input: {
    target: AttachmentTarget; filename: string; bytes: Uint8Array; mimeType: AttachmentMimeType;
  }): Promise<void> {
    assertAttachmentTarget(input.target);
    assertSafeImage(input.bytes, input.mimeType);
    if (!/^lks-staging-[a-f0-9]{64}\.(png|jpg)$/.test(input.filename)) {
      fail('invalid_attachment_filename', 'Airtable attachment filename is not deterministic.');
    }
    const timed = timeoutSignal(this.timeoutMs);
    try {
      const response = await this.fetchImpl(
        `${AIRTABLE_CONTENT_ORIGIN}/v0/${input.target.baseId}/${input.target.recordId}/${input.target.fieldId}/uploadAttachment`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contentType: input.mimeType,
            filename: input.filename,
            file: Buffer.from(input.bytes).toString('base64'),
          }),
          redirect: 'error',
          signal: timed.signal,
        },
      );
      if (!response.ok) fail('airtable_upload_failed', `Airtable attachment upload failed (${response.status}).`, {
        mutation: response.status >= 500 || response.status === 408 || response.status === 429 ? 'ambiguous' : 'none',
        rollback: response.status >= 500 || response.status === 408 || response.status === 429 ? 'manual_review' : 'not_required',
      });
      await response.arrayBuffer();
    } catch (error) {
      if (error instanceof AttachmentTransferError) throw error;
      fail('airtable_upload_ambiguous', 'Airtable attachment upload outcome is ambiguous.', {
        mutation: 'ambiguous', rollback: 'manual_review',
      });
    } finally {
      timed.cleanup();
    }
  }

  async download(attachment: AttachmentDescriptor): Promise<Uint8Array> {
    if (!AIRTABLE_IDS.attachmentId.test(attachment.id)) fail('airtable_invalid_attachment_identity', 'Airtable attachment ID is invalid.');
    let url: URL;
    try { url = new URL(attachment.url); } catch { return fail('airtable_readback_url_rejected', 'Airtable readback URL is invalid.'); }
    const hostAllowed = url.hostname === 'airtableusercontent.com' || url.hostname.endsWith('.airtableusercontent.com');
    if (url.protocol !== 'https:' || !hostAllowed || url.username || url.password) {
      fail('airtable_readback_url_rejected', 'Airtable readback URL host is not allowed.');
    }
    const response = await this.read(url.toString(), false);
    const responseType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (responseType !== attachment.mimeType) fail('airtable_readback_mime_mismatch', 'Airtable readback MIME type does not match the attachment.');
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && Number(contentLength) !== attachment.size) {
      fail('airtable_readback_size_mismatch', 'Airtable readback content length does not match the attachment.');
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== attachment.size) fail('airtable_readback_size_mismatch', 'Airtable readback bytes do not match the attachment size.');
    return bytes;
  }

  private async readJson(url: string): Promise<unknown> {
    const response = await this.read(url, true);
    const type = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') fail('airtable_invalid_response', 'Airtable returned a non-JSON API response.');
    return response.json();
  }

  private async read(url: string, authenticated: boolean): Promise<FetchResponse> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxReadAttempts; attempt += 1) {
      const timed = timeoutSignal(this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, {
          method: 'GET',
          headers: authenticated ? { Authorization: `Bearer ${this.token}` } : {},
          redirect: 'error',
          signal: timed.signal,
        });
        if (isRetryableReadStatus(response.status) && attempt < this.maxReadAttempts) {
          await this.retryDelay(attempt);
          continue;
        }
        if (!response.ok) fail('airtable_read_failed', `Airtable read failed (${response.status}).`);
        return response;
      } catch (error) {
        if (error instanceof AttachmentTransferError) throw error;
        lastError = error;
        if (attempt < this.maxReadAttempts) await this.retryDelay(attempt);
      } finally {
        timed.cleanup();
      }
    }
    const message = lastError instanceof Error ? lastError.message : 'Airtable read failed.';
    return fail('airtable_read_failed', message);
  }
}

const deterministicFilename = (key: string, mimeType: AttachmentMimeType): string =>
  `lks-staging-${key.slice('sha256:'.length)}.${mimeType === 'image/png' ? 'png' : 'jpg'}`;

const validateRetention = (value: string | undefined): string | null => {
  if (value === undefined) return null;
  const normalized = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(normalized) || !Number.isFinite(Date.parse(normalized))) {
    throw new Error('retainUntil must be a canonical UTC timestamp.');
  }
  return normalized;
};

export class PrivateDriveAirtableAttachmentAdapter {
  private readonly allowedTargets = new Map<string, AttachmentTarget>();
  private readonly inFlight = new Map<string, { retainUntil: string | null; operation: Promise<TransferReceipt> }>();
  private readonly now: () => Date;

  constructor(private readonly config: {
    drive: PrivateDriveFileProvider;
    airtable: AirtableAttachmentProvider;
    allowedTargets: readonly AttachmentTarget[];
    now?: () => Date;
  }) {
    for (const target of config.allowedTargets) {
      assertAttachmentTarget(target);
      const key = targetKey(target);
      if (this.allowedTargets.has(key)) throw new Error('Airtable target allowlist contains a duplicate tuple.');
      this.allowedTargets.set(key, Object.freeze({ ...target }));
    }
    if (!this.allowedTargets.size) throw new Error('At least one Airtable attachment target must be allowlisted.');
    this.now = config.now || (() => new Date());
  }

  async execute(input: {
    fileId: string;
    expectedSha256: string;
    target: AttachmentTarget;
    retainUntil?: string;
  }): Promise<TransferReceipt> {
    if (!DRIVE_FILE_ID.test(input.fileId)) fail('invalid_file_id', 'Google Drive file ID is invalid.');
    if (!SHA256.test(input.expectedSha256)) fail('invalid_expected_sha256', 'Expected SHA-256 is invalid.');
    try { assertAttachmentTarget(input.target); } catch { return fail('target_not_allowed', 'Airtable target tuple is invalid.'); }
    const allowed = this.allowedTargets.get(targetKey(input.target));
    if (!allowed || !sameTarget(allowed, input.target)) fail('target_not_allowed', 'Airtable target tuple is not allowlisted.');
    const retainUntil = validateRetention(input.retainUntil);
    const idempotencyKey = attachmentIdempotencyKey({
      fileId: input.fileId,
      fileSha256: input.expectedSha256,
      recordId: input.target.recordId,
      fieldId: input.target.fieldId,
    });
    const active = this.inFlight.get(idempotencyKey);
    if (active) {
      if (active.retainUntil !== retainUntil) fail('retention_conflict', 'Concurrent replay has conflicting retention metadata.');
      return active.operation;
    }
    const operation = this.executeOnce({
      ...input, target: allowed as AttachmentTarget, retainUntil, idempotencyKey,
    }).finally(() => {
      if (this.inFlight.get(idempotencyKey)?.operation === operation) this.inFlight.delete(idempotencyKey);
    });
    this.inFlight.set(idempotencyKey, { retainUntil, operation });
    return operation;
  }

  private async executeOnce(input: {
    fileId: string; expectedSha256: string; target: AttachmentTarget;
    retainUntil: string | null; idempotencyKey: string;
  }): Promise<TransferReceipt> {
    const lifecycle: TransferReceipt['lifecycle'] = ['pending'];
    const preflight = await this.config.airtable.preflight(input.target);
    assertAirtableIdentity(preflight.identity, input.target);
    const beforeAttachmentIds = preflight.attachments.map(attachment => attachment.id);
    if (new Set(beforeAttachmentIds).size !== beforeAttachmentIds.length) {
      fail('airtable_duplicate_attachment_identity', 'Airtable returned duplicate attachment IDs.');
    }
    const source = await this.config.drive.download({ fileId: input.fileId, expectedSha256: input.expectedSha256 });
    lifecycle.push('downloaded');
    if (source.fileId !== input.fileId || source.sha256 !== input.expectedSha256
      || source.size !== source.bytes.byteLength || !ALLOWED_MIME_TYPES.has(source.mimeType)) {
      fail('drive_provider_identity_mismatch', 'Drive provider returned an unexpected file identity.');
    }
    assertSafeImage(source.bytes, source.mimeType);
    if (fullSha256(source.bytes) !== source.sha256) fail('drive_provider_sha256_mismatch', 'Drive provider bytes do not match its SHA-256.');
    lifecycle.push('validated');
    const filename = deterministicFilename(input.idempotencyKey, source.mimeType);
    const existing = preflight.attachments.filter(attachment => attachment.filename === filename);
    if (existing.length > 1) fail('duplicate_idempotency_identity', 'Multiple Airtable attachments have the same idempotency identity.');
    if (existing.length === 1) {
      await this.verifyReadback(existing[0], source);
      lifecycle.push('verified', 'processed');
      return this.receipt('deduped', 'preexisting', input, source, existing[0], beforeAttachmentIds, lifecycle);
    }

    try {
      await this.config.airtable.uploadRaw({ target: input.target, filename, bytes: source.bytes, mimeType: source.mimeType });
      lifecycle.push('uploaded');
    } catch (error) {
      let reconciled: AttachmentDescriptor | null = null;
      try {
        const attachments = await this.config.airtable.list(input.target);
        const matches = attachments.filter(attachment => attachment.filename === filename);
        if (matches.length > 1) fail('duplicate_idempotency_identity', 'Ambiguous Airtable write produced duplicate attachment identities.');
        if (matches.length === 1) {
          reconciled = matches[0];
          try {
            await this.verifyReadback(reconciled, source);
          } catch (readbackError) {
            throw this.createdAttachmentFailure(readbackError, input, reconciled, beforeAttachmentIds, lifecycle);
          }
        }
      } catch (reconcileError) {
        if (reconcileError instanceof AttachmentTransferError
          && reconcileError.audit.mutation === 'attachment_created') throw reconcileError;
        const message = reconcileError instanceof Error ? reconcileError.message : 'Airtable upload reconciliation failed.';
        throw new AttachmentTransferError(message, {
          contract: 'private-drive-airtable-attachment-v1', state: 'error', code: 'airtable_upload_reconcile_failed',
          mutation: 'ambiguous', idempotencyKey: input.idempotencyKey, target: input.target,
          beforeAttachmentIds, sourceDisposition: 'retained_private', rollback: 'manual_review', lifecycle: [...lifecycle],
        });
      }
      if (reconciled) {
        lifecycle.push('uploaded', 'verified', 'processed');
        return this.receipt('created', 'ambiguous_reconciled', input, source, reconciled, beforeAttachmentIds, lifecycle);
      }
      if (error instanceof AttachmentTransferError) {
        throw new AttachmentTransferError(error.message, {
          ...error.audit,
          idempotencyKey: input.idempotencyKey,
          target: input.target,
          beforeAttachmentIds,
          lifecycle: [...lifecycle],
        });
      }
      fail('airtable_upload_ambiguous', 'Airtable upload failed and could not be reconciled.', {
        mutation: 'ambiguous', rollback: 'manual_review', idempotencyKey: input.idempotencyKey,
        target: input.target, beforeAttachmentIds, lifecycle: [...lifecycle],
      });
    }

    let matches: AttachmentDescriptor[];
    try {
      const after = await this.config.airtable.list(input.target);
      matches = after.filter(attachment => attachment.filename === filename);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Airtable post-upload read failed.';
      throw new AttachmentTransferError(message, {
        contract: 'private-drive-airtable-attachment-v1', state: 'error', code: 'airtable_post_upload_read_ambiguous',
        mutation: 'ambiguous', idempotencyKey: input.idempotencyKey, target: input.target,
        beforeAttachmentIds, sourceDisposition: 'retained_private', rollback: 'manual_review', lifecycle: [...lifecycle],
      });
    }
    if (matches.length !== 1 || beforeAttachmentIds.includes(matches[0]?.id || '')) {
      fail('airtable_upload_identity_mismatch', 'Airtable did not return one new deterministic attachment.', {
        mutation: 'ambiguous', rollback: 'manual_review', idempotencyKey: input.idempotencyKey,
        target: input.target, beforeAttachmentIds, lifecycle: [...lifecycle],
      });
    }
    const created = matches[0];
    try {
      await this.verifyReadback(created, source);
    } catch (error) {
      throw this.createdAttachmentFailure(error, input, created, beforeAttachmentIds, lifecycle);
    }
    lifecycle.push('verified', 'processed');
    return this.receipt('created', 'confirmed', input, source, created, beforeAttachmentIds, lifecycle);
  }

  private createdAttachmentFailure(
    error: unknown,
    input: { idempotencyKey: string; target: AttachmentTarget },
    created: AttachmentDescriptor,
    beforeAttachmentIds: string[],
    lifecycle: TransferReceipt['lifecycle'],
  ): AttachmentTransferError {
    const message = error instanceof Error ? error.message : 'Airtable attachment readback verification failed.';
    return new AttachmentTransferError(message, {
      contract: 'private-drive-airtable-attachment-v1', state: 'error',
      code: error instanceof AttachmentTransferError ? error.audit.code : 'readback_integrity_failed',
      mutation: 'attachment_created', idempotencyKey: input.idempotencyKey, target: input.target,
      createdAttachmentId: created.id, createdAttachmentFilename: created.filename,
      beforeAttachmentIds, sourceDisposition: 'retained_private', rollback: 'eligible_after_reread',
      lifecycle: [...lifecycle],
    });
  }

  private async verifyReadback(attachment: AttachmentDescriptor, source: PrivateDriveFile): Promise<void> {
    if (!AIRTABLE_IDS.attachmentId.test(attachment.id) || attachment.mimeType !== source.mimeType || attachment.size !== source.size) {
      fail('airtable_attachment_identity_mismatch', 'Airtable attachment metadata does not match the source file.');
    }
    const bytes = await this.config.airtable.download(attachment);
    assertSafeImage(bytes, source.mimeType);
    if (bytes.byteLength !== source.size || fullSha256(bytes) !== source.sha256) {
      fail('airtable_readback_sha256_mismatch', 'Airtable readback SHA-256 does not match the source file.');
    }
  }

  private receipt(
    outcome: 'created' | 'deduped',
    writeResolution: TransferReceipt['writeResolution'],
    input: { fileId: string; target: AttachmentTarget; retainUntil: string | null; idempotencyKey: string },
    source: PrivateDriveFile,
    attachment: AttachmentDescriptor,
    beforeAttachmentIds: string[],
    lifecycle: TransferReceipt['lifecycle'],
  ): TransferReceipt {
    return {
      contract: 'private-drive-airtable-attachment-v1', state: 'processed', outcome, writeResolution,
      idempotencyKey: input.idempotencyKey,
      source: { fileId: source.fileId, sha256: source.sha256, mimeType: source.mimeType, size: source.size },
      target: { ...input.target },
      attachment: { id: attachment.id, filename: attachment.filename, sha256: source.sha256 },
      retention: { sourceDisposition: 'retained_private', retainUntil: input.retainUntil, deletionActor: 'external_operator' },
      beforeAttachmentIds: [...beforeAttachmentIds], lifecycle: [...lifecycle], processedAt: this.now().toISOString(),
    };
  }
}

export type RollbackPlan = Readonly<
  | { state: 'not_applicable'; reason: 'deduped_transfer' }
  | { state: 'blocked'; reason: string }
  | { state: 'removable'; removeAttachmentId: string; preserveAttachmentIds: string[]; target: AttachmentTarget }
>;

export const planAttachmentRollback = (
  evidence: TransferReceipt | TransferFailureAudit,
  current: { target: AttachmentTarget; attachments: readonly AttachmentDescriptor[] },
): RollbackPlan => {
  if (evidence.state === 'processed' && evidence.outcome === 'deduped') {
    return { state: 'not_applicable', reason: 'deduped_transfer' };
  }
  if (evidence.state === 'error' && evidence.rollback !== 'eligible_after_reread') {
    return { state: 'blocked', reason: 'failure_not_rollback_eligible' };
  }
  const target = evidence.target;
  const createdId = evidence.state === 'processed' ? evidence.attachment.id : evidence.createdAttachmentId;
  const createdFilename = evidence.state === 'processed'
    ? evidence.attachment.filename
    : evidence.createdAttachmentFilename;
  const beforeAttachmentIds = evidence.beforeAttachmentIds;
  if (!target || !createdId || !createdFilename || !beforeAttachmentIds) {
    return { state: 'blocked', reason: 'rollback_evidence_incomplete' };
  }
  if (!sameTarget(target, current.target)) return { state: 'blocked', reason: 'target_identity_changed' };
  const currentIds = current.attachments.map(attachment => attachment.id);
  if (new Set(currentIds).size !== currentIds.length) return { state: 'blocked', reason: 'duplicate_attachment_identity' };
  const created = current.attachments.filter(attachment => attachment.id === createdId);
  if (created.length !== 1 || created[0].filename !== createdFilename) {
    return { state: 'blocked', reason: 'created_attachment_identity_changed' };
  }
  const expectedIds = new Set([...beforeAttachmentIds, createdId]);
  if (currentIds.length !== expectedIds.size || currentIds.some(id => !expectedIds.has(id))) {
    return { state: 'blocked', reason: 'attachment_set_changed' };
  }
  return {
    state: 'removable', removeAttachmentId: createdId,
    preserveAttachmentIds: [...beforeAttachmentIds], target: { ...target },
  };
};
