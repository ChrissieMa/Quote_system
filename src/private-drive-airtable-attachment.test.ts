import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AirtableHttpAttachmentProvider,
  AttachmentTransferError,
  GooglePrivateDriveFileProvider,
  PrivateDriveAirtableAttachmentAdapter,
  assertSafeImage,
  attachmentIdempotencyKey,
  fullSha256,
  planAttachmentRollback,
  type AirtableAttachmentProvider,
  type AttachmentDescriptor,
  type AttachmentTarget,
  type PrivateDriveFile,
  type PrivateDriveFileProvider,
} from './private-drive-airtable-attachment';
import type { GoogleDriveAccessTokenProvider } from './google-drive-quotation-image';
import {
  ALTERNATE_SAFE_PNG,
  CORRUPT_IDAT_PNG,
  CORRUPT_IDAT_PNG_SHA256,
  OVERSIZED_DIMENSION_PNG,
  SAFE_JPEG,
  SAFE_JPEG_SHA256,
  SAFE_PNG,
  SAFE_PNG_SHA256,
} from './test-only/fixtures/safe-private-drive-image';

const FILE_ID = 'drive_file_12345678';
const FOLDER_ID = 'drive_folder_12345678';
const OWNER_PERMISSION_ID = 'owner_permission_12345678';
const OWNER_EMAIL = 'owner@example.test';
const TARGET: AttachmentTarget = {
  baseId: 'appABCDEFGHIJKLMN',
  tableId: 'tblABCDEFGHIJKLMN',
  recordId: 'recABCDEFGHIJKLMN',
  fieldId: 'fldABCDEFGHIJKLMN',
};
const ATTACHMENT_ID = 'attABCDEFGHIJKLMN';
const AIRTABLE_USER_ID = 'usrABCDEFGHIJKLMN';
const FIXED_TIME = new Date('2026-09-01T00:00:00.000Z');

class StaticDrive implements PrivateDriveFileProvider {
  calls = 0;
  constructor(private readonly bytes = SAFE_PNG, private readonly sha256 = SAFE_PNG_SHA256) {}
  async download(input: { fileId: string; expectedSha256: string }): Promise<PrivateDriveFile> {
    this.calls += 1;
    assert.equal(input.fileId, FILE_ID);
    assert.equal(input.expectedSha256, this.sha256);
    return {
      fileId: FILE_ID,
      bytes: this.bytes,
      mimeType: 'image/png',
      size: this.bytes.length,
      sha256: this.sha256,
      parentFolderId: FOLDER_ID,
    };
  }
}

class MemoryAirtable implements AirtableAttachmentProvider {
  attachments: AttachmentDescriptor[] = [];
  uploads = 0;
  reads = 0;
  ambiguousUpload = false;
  failListAfterUpload = false;
  readback = SAFE_PNG;
  identity: AttachmentTarget = { ...TARGET };

  async preflight(): Promise<{ identity: AttachmentTarget; attachments: AttachmentDescriptor[] }> {
    return { identity: { ...this.identity }, attachments: [...this.attachments] };
  }
  async list(): Promise<AttachmentDescriptor[]> {
    if (this.failListAfterUpload && this.uploads > 0) throw new Error('mock post-upload read timeout');
    return [...this.attachments];
  }
  async uploadRaw(input: { filename: string; bytes: Uint8Array; mimeType: 'image/png' | 'image/jpeg' }): Promise<void> {
    this.uploads += 1;
    assert.deepEqual(Buffer.from(input.bytes), SAFE_PNG);
    this.attachments.push({
      id: ATTACHMENT_ID,
      filename: input.filename,
      url: 'https://v5.airtableusercontent.com/v3/mock/signed',
      mimeType: input.mimeType,
      size: input.bytes.byteLength,
    });
    if (this.ambiguousUpload) throw new Error('socket closed after write');
  }
  async download(): Promise<Uint8Array> {
    this.reads += 1;
    return this.readback;
  }
}

const adapter = (drive = new StaticDrive(), airtable = new MemoryAirtable()) => ({
  drive,
  airtable,
  value: new PrivateDriveAirtableAttachmentAdapter({
    drive,
    airtable,
    allowedTargets: [TARGET],
    now: () => FIXED_TIME,
  }),
});

test('safe fixtures are complete PNG/JPEG files with fixed full-file SHA-256 digests', () => {
  assertSafeImage(SAFE_PNG, 'image/png');
  assertSafeImage(SAFE_JPEG, 'image/jpeg');
  assert.equal(SAFE_PNG.length, 70);
  assert.equal(SAFE_JPEG.length, 616);
  assert.equal(fullSha256(SAFE_PNG), SAFE_PNG_SHA256);
  assert.equal(fullSha256(SAFE_JPEG), SAFE_JPEG_SHA256);
});

test('strict image validation rejects truncation, trailing data, forged CRC, and MIME mismatch', () => {
  assert.throws(() => assertSafeImage(SAFE_PNG.subarray(0, -1), 'image/png'), AttachmentTransferError);
  assert.throws(() => assertSafeImage(Buffer.concat([SAFE_PNG, Buffer.from('<script>')]), 'image/png'), AttachmentTransferError);
  const forged = Buffer.from(SAFE_PNG);
  forged[50] ^= 1;
  assert.throws(() => assertSafeImage(forged, 'image/png'), AttachmentTransferError);
  assert.throws(() => assertSafeImage(SAFE_JPEG, 'image/png'), AttachmentTransferError);
  assert.throws(() => assertSafeImage(SAFE_JPEG.subarray(0, -2), 'image/jpeg'), AttachmentTransferError);
});

test('full decode rejects corrupt IDAT with a valid CRC and oversized declared dimensions', () => {
  assert.equal(CORRUPT_IDAT_PNG.length, 68);
  assert.equal(fullSha256(CORRUPT_IDAT_PNG), CORRUPT_IDAT_PNG_SHA256);
  assert.throws(() => assertSafeImage(CORRUPT_IDAT_PNG, 'image/png'),
    (error: AttachmentTransferError) => error.audit.code === 'image_decode_failed');

  assert.throws(() => assertSafeImage(OVERSIZED_DIMENSION_PNG, 'image/png'),
    (error: AttachmentTransferError) => error.audit.code === 'invalid_png');
});

test('idempotency identity is deterministic and changes for every required component', () => {
  const input = { fileId: FILE_ID, fileSha256: SAFE_PNG_SHA256, recordId: TARGET.recordId, fieldId: TARGET.fieldId };
  const key = attachmentIdempotencyKey(input);
  assert.match(key, /^sha256:[a-f0-9]{64}$/);
  assert.equal(attachmentIdempotencyKey(input), key);
  assert.notEqual(attachmentIdempotencyKey({ ...input, fileId: `${FILE_ID}x` }), key);
  assert.notEqual(attachmentIdempotencyKey({ ...input, fileSha256: SAFE_JPEG_SHA256 }), key);
  assert.notEqual(attachmentIdempotencyKey({ ...input, recordId: 'recZYXWVUTSRQPONM' }), key);
  assert.notEqual(attachmentIdempotencyKey({ ...input, fieldId: 'fldZYXWVUTSRQPONM' }), key);
});

test('first transfer creates once, verifies readback SHA, and retains the private Drive source', async () => {
  const { value, airtable } = adapter();
  const receipt = await value.execute({
    fileId: FILE_ID,
    expectedSha256: SAFE_PNG_SHA256,
    target: TARGET,
    retainUntil: '2026-10-01T00:00:00.000Z',
  });
  assert.equal(receipt.state, 'processed');
  assert.equal(receipt.outcome, 'created');
  assert.equal(receipt.attachment.sha256, SAFE_PNG_SHA256);
  assert.equal(receipt.retention.sourceDisposition, 'retained_private');
  assert.equal(receipt.retention.deletionActor, 'external_operator');
  assert.deepEqual(receipt.lifecycle, ['pending', 'downloaded', 'validated', 'uploaded', 'verified', 'processed']);
  assert.equal(airtable.uploads, 1);
  assert.equal(airtable.reads, 1);
});

test('sequential and concurrent replay dedupe by deterministic filename plus readback SHA', async () => {
  const { value, airtable } = adapter();
  const input = { fileId: FILE_ID, expectedSha256: SAFE_PNG_SHA256, target: TARGET };
  const [first, concurrent] = await Promise.all([value.execute(input), value.execute(input)]);
  assert.equal(first.outcome, 'created');
  assert.deepEqual(concurrent, first);
  const replay = await value.execute(input);
  assert.equal(replay.outcome, 'deduped');
  assert.equal(airtable.uploads, 1);
  assert.equal(airtable.attachments.length, 1);
});

test('ambiguous Airtable write is never retried and is reconciled by full readback SHA', async () => {
  const airtable = new MemoryAirtable();
  airtable.ambiguousUpload = true;
  const { value } = adapter(new StaticDrive(), airtable);
  const receipt = await value.execute({ fileId: FILE_ID, expectedSha256: SAFE_PNG_SHA256, target: TARGET });
  assert.equal(receipt.outcome, 'created');
  assert.equal(receipt.writeResolution, 'ambiguous_reconciled');
  assert.equal(airtable.uploads, 1);
  assert.equal(airtable.attachments.length, 1);
});

test('ambiguous write with failed readback preserves exact created-attachment rollback evidence', async () => {
  const airtable = new MemoryAirtable();
  airtable.ambiguousUpload = true;
  airtable.readback = ALTERNATE_SAFE_PNG;
  const { value } = adapter(new StaticDrive(), airtable);
  let audit: AttachmentTransferError['audit'] | undefined;
  await assert.rejects(value.execute({ fileId: FILE_ID, expectedSha256: SAFE_PNG_SHA256, target: TARGET }),
    (error: AttachmentTransferError) => {
      audit = error.audit;
      assert.equal(error.audit.mutation, 'attachment_created');
      assert.equal(error.audit.rollback, 'eligible_after_reread');
      assert.equal(error.audit.createdAttachmentId, ATTACHMENT_ID);
      return true;
    });
  assert.equal(planAttachmentRollback(audit!, { target: TARGET, attachments: airtable.attachments }).state, 'removable');
  assert.equal(airtable.uploads, 1);
});

test('2xx upload followed by an unreadable record remains ambiguous and never reports zero mutation', async () => {
  const airtable = new MemoryAirtable();
  airtable.failListAfterUpload = true;
  const { value } = adapter(new StaticDrive(), airtable);
  await assert.rejects(value.execute({ fileId: FILE_ID, expectedSha256: SAFE_PNG_SHA256, target: TARGET }),
    (error: AttachmentTransferError) => {
      assert.equal(error.audit.code, 'airtable_post_upload_read_ambiguous');
      assert.equal(error.audit.mutation, 'ambiguous');
      assert.equal(error.audit.rollback, 'manual_review');
      return true;
    });
  assert.equal(airtable.uploads, 1);
});

test('concurrent replay rejects conflicting retention metadata', async () => {
  const { value } = adapter();
  const input = { fileId: FILE_ID, expectedSha256: SAFE_PNG_SHA256, target: TARGET };
  const results = await Promise.allSettled([
    value.execute({ ...input, retainUntil: '2026-10-01T00:00:00.000Z' }),
    value.execute({ ...input, retainUntil: '2026-11-01T00:00:00.000Z' }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.equal((rejected.reason as AttachmentTransferError).audit.code, 'retention_conflict');
});

test('target and provider identity mismatches fail closed before any Airtable write', async () => {
  const first = adapter();
  await assert.rejects(first.value.execute({
    fileId: FILE_ID,
    expectedSha256: SAFE_PNG_SHA256,
    target: { ...TARGET, recordId: 'recZYXWVUTSRQPONM' },
  }), (error: AttachmentTransferError) => error.audit.code === 'target_not_allowed');
  assert.equal(first.drive.calls, 0);
  assert.equal(first.airtable.uploads, 0);

  const second = adapter();
  second.airtable.identity = { ...TARGET, fieldId: 'fldZYXWVUTSRQPONM' };
  await assert.rejects(second.value.execute({ fileId: FILE_ID, expectedSha256: SAFE_PNG_SHA256, target: TARGET }),
    (error: AttachmentTransferError) => error.audit.code === 'airtable_identity_mismatch');
  assert.equal(second.drive.calls, 0);
  assert.equal(second.airtable.uploads, 0);
});

test('readback SHA mismatch never becomes processed and returns a scoped rollback contract', async () => {
  const { value, airtable } = adapter();
  airtable.readback = ALTERNATE_SAFE_PNG;
  let failureAudit: AttachmentTransferError['audit'] | undefined;
  await assert.rejects(
    value.execute({ fileId: FILE_ID, expectedSha256: SAFE_PNG_SHA256, target: TARGET }),
    (error: AttachmentTransferError) => {
      assert.equal(error.audit.code, 'airtable_readback_sha256_mismatch');
      assert.equal(error.audit.mutation, 'attachment_created');
      assert.equal(error.audit.rollback, 'eligible_after_reread');
      assert.equal(error.audit.createdAttachmentId, ATTACHMENT_ID);
      assert.equal(error.audit.sourceDisposition, 'retained_private');
      failureAudit = error.audit;
      return true;
    },
  );
  assert.equal(airtable.uploads, 1);
  assert.equal(planAttachmentRollback(failureAudit!, { target: TARGET, attachments: airtable.attachments }).state, 'removable');
});

test('rollback planner removes only the created attachment when target and snapshot still match', async () => {
  const { value, airtable } = adapter();
  const existing: AttachmentDescriptor = {
    id: 'attPREEXISTING123', filename: 'existing.pdf', url: 'https://v5.airtableusercontent.com/v3/mock/old',
    mimeType: 'application/pdf', size: 12,
  };
  airtable.attachments.push(existing);
  const receipt = await value.execute({ fileId: FILE_ID, expectedSha256: SAFE_PNG_SHA256, target: TARGET });
  const plan = planAttachmentRollback(receipt, { target: TARGET, attachments: airtable.attachments });
  assert.deepEqual(plan, {
    state: 'removable', removeAttachmentId: ATTACHMENT_ID,
    preserveAttachmentIds: [existing.id], target: TARGET,
  });
  assert.equal(planAttachmentRollback(receipt, {
    target: TARGET,
    attachments: [...airtable.attachments, { ...existing, id: 'attUNRELATED12345' }],
  }).state, 'blocked');
  const deduped = await value.execute({ fileId: FILE_ID, expectedSha256: SAFE_PNG_SHA256, target: TARGET });
  assert.equal(planAttachmentRollback(deduped, { target: TARGET, attachments: airtable.attachments }).state, 'not_applicable');
});

class StaticToken implements GoogleDriveAccessTokenProvider {
  invalidations = 0;
  async getAccessToken(): Promise<string> { return 'mock-oauth-token'; }
  invalidateAccessToken(): void { this.invalidations += 1; }
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

test('Google provider uses authenticated exact-ID alt=media and verifies private owner-only metadata', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.includes('/drive/v3/about?')) return json({ user: { emailAddress: OWNER_EMAIL, permissionId: OWNER_PERMISSION_ID } });
    if (url.includes(`files/${FILE_ID}?fields=`)) return json({
      id: FILE_ID, mimeType: 'image/png', size: String(SAFE_PNG.length), sha256Checksum: SAFE_PNG_SHA256,
      trashed: false, parents: [FOLDER_ID],
      owners: [{ emailAddress: OWNER_EMAIL, permissionId: OWNER_PERMISSION_ID }],
      permissions: [{ id: OWNER_PERMISSION_ID, type: 'user', role: 'owner' }],
    });
    if (url === `https://www.googleapis.com/drive/v3/files/${FILE_ID}?alt=media`) {
      return new Response(SAFE_PNG, { status: 200, headers: { 'Content-Type': 'image/png', 'Content-Length': String(SAFE_PNG.length) } });
    }
    throw new Error(`Unexpected Drive request: ${url}`);
  };
  const provider = new GooglePrivateDriveFileProvider({
    accessTokenProvider: new StaticToken(), expectedOwnerEmail: OWNER_EMAIL,
    allowedFolderIds: [FOLDER_ID], fetch: fetchMock, retryDelay: async () => {},
  });
  const result = await provider.download({ fileId: FILE_ID, expectedSha256: SAFE_PNG_SHA256 });
  assert.equal(result.sha256, SAFE_PNG_SHA256);
  assert.ok(requests.every(request => new Headers(request.init.headers).get('Authorization') === 'Bearer mock-oauth-token'));
  assert.ok(requests.every(request => request.init.method === 'GET'));
  assert.ok(requests.every(request => !/view|webContentLink|\/permissions(?:\?|\/|$)|share/i.test(request.url)));
});

test('Google identity or parent mismatch fails before raw download', async () => {
  let rawDownloads = 0;
  const fetchMock: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('/drive/v3/about?')) return json({ user: { emailAddress: OWNER_EMAIL, permissionId: OWNER_PERMISSION_ID } });
    if (url.includes('?fields=')) return json({
      id: FILE_ID, mimeType: 'image/png', size: String(SAFE_PNG.length), trashed: false,
      parents: ['wrong_folder_12345678'], owners: [{ emailAddress: OWNER_EMAIL, permissionId: OWNER_PERMISSION_ID }],
      permissions: [{ id: OWNER_PERMISSION_ID, type: 'user', role: 'owner' }],
    });
    rawDownloads += 1;
    return new Response(SAFE_PNG);
  };
  const provider = new GooglePrivateDriveFileProvider({
    accessTokenProvider: new StaticToken(), expectedOwnerEmail: OWNER_EMAIL,
    allowedFolderIds: [FOLDER_ID], fetch: fetchMock,
  });
  await assert.rejects(provider.download({ fileId: FILE_ID, expectedSha256: SAFE_PNG_SHA256 }),
    (error: AttachmentTransferError) => error.audit.code === 'drive_file_identity_mismatch');
  assert.equal(rawDownloads, 0);
});

test('Airtable HTTP provider verifies user/schema/record, uploads base64 bytes once, and rejects unsafe readback hosts', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let attachments: AttachmentDescriptor[] = [];
  const fetchMock: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith('/v0/meta/whoami')) return json({ id: AIRTABLE_USER_ID });
    if (url.endsWith(`/v0/meta/bases/${TARGET.baseId}/tables`)) return json({ tables: [{
      id: TARGET.tableId, fields: [{ id: TARGET.fieldId, type: 'multipleAttachments' }],
    }] });
    if (url.includes(`/v0/${TARGET.baseId}/${TARGET.tableId}/${TARGET.recordId}?`)) {
      return json({ id: TARGET.recordId, fields: { [TARGET.fieldId]: attachments.map(item => ({
        id: item.id, filename: item.filename, url: item.url, type: item.mimeType, size: item.size,
      })) } });
    }
    if (url.includes('content.airtable.com') && init.method === 'POST') {
      const body = JSON.parse(String(init.body));
      assert.equal(body.file, SAFE_PNG.toString('base64'));
      assert.equal(body.contentType, 'image/png');
      attachments = [{ id: ATTACHMENT_ID, filename: body.filename,
        url: 'https://v5.airtableusercontent.com/v3/mock/signed', mimeType: body.contentType, size: SAFE_PNG.length }];
      return json({ id: ATTACHMENT_ID });
    }
    if (url.includes('airtableusercontent.com')) return new Response(SAFE_PNG, {
      status: 200, headers: { 'Content-Type': 'image/png', 'Content-Length': String(SAFE_PNG.length) },
    });
    throw new Error(`Unexpected Airtable request: ${url}`);
  };
  const provider = new AirtableHttpAttachmentProvider({
    token: 'pat_mock_secret', expectedUserId: AIRTABLE_USER_ID, fetch: fetchMock, retryDelay: async () => {},
  });
  const before = await provider.preflight(TARGET);
  assert.deepEqual(before, { identity: TARGET, attachments: [] });
  await provider.uploadRaw({ target: TARGET, filename: `lks-staging-${'a'.repeat(64)}.png`, bytes: SAFE_PNG, mimeType: 'image/png' });
  const [uploaded] = await provider.list(TARGET);
  assert.deepEqual(Buffer.from(await provider.download(uploaded)), SAFE_PNG);
  await assert.rejects(provider.download({ ...uploaded, url: 'https://example.test/steal' }),
    (error: AttachmentTransferError) => error.audit.code === 'airtable_readback_url_rejected');
  assert.equal(requests.filter(request => request.init.method === 'POST').length, 1);
  assert.ok(requests.every(request => !request.url.includes('drive.google.com')));
});
