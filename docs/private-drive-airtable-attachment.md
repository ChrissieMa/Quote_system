# Private Google Drive staging to Airtable attachment adapter

## Scope and safety boundary

`src/private-drive-airtable-attachment.ts` is a provider-based transport contract. It is deliberately not wired into `src/index.ts`, Production environment variables, routes, jobs, or Airtable schema. Enabling it later requires an owner-approved caller to supply explicit providers, credentials, identity expectations, and an immutable allowlist.

The adapter never creates or deletes a Drive file, changes Drive permissions, makes a file public, writes an Airtable schema, or creates/deletes an Airtable record. The source disposition is always `retained_private`; any later source-retention deletion belongs to an external operator, not this adapter.

## Processing contract

1. Reject any target not matching an exact allowlisted `baseId/tableId/recordId/fieldId` tuple. IDs only; names, wildcards, and fallback tables are not accepted.
2. Verify the Airtable PAT user, exact table, `multipleAttachments` field, and exact record identity using read-only API calls.
3. Verify the Google OAuth owner and requested file metadata. The file must be owner-only/private, untrashed, in one allowlisted staging folder, within 5 MB, and declared as PNG or JPEG.
4. Download bytes only through authenticated `GET /drive/v3/files/{fileId}?alt=media`. View, export, web-content, public-share, and permission endpoints are not used.
5. Check declared size, response length, MIME, complete PNG/JPEG structure, and the SHA-256 of every byte. The computed digest must equal the caller's full expected SHA-256 and, when supplied, Drive's SHA-256 metadata.
6. Derive `sha256:<digest>` from versioned canonical JSON containing `file_id`, full file SHA-256, `record_id`, and `field_id`. Base/table are already isolated by the exact target namespace. The deterministic Airtable filename contains only this digest and an allowlisted extension, never source filenames or PII.
7. Reconcile that filename before upload. One attachment is downloaded and verified as `deduped`; more than one, or any content mismatch, fails closed.
8. Upload raw bytes directly with Airtable's attachment upload API as base64 (`content.airtable.com/.../uploadAttachment`). No Drive/public URL is passed to Airtable. The append write is issued once and is never blindly retried.
9. After upload—or an ambiguous response—reread the record. Select the one deterministic attachment ID, immediately download its expiring `airtableusercontent.com` URL without redirects, and compare MIME, size, complete image structure, and full SHA-256. Only then return `state: processed` with `outcome: created|deduped`.

The direct upload request follows Airtable's [Upload attachment API](https://airtable.com/developers/web/api/upload-attachment). Attachment download URLs are treated as short-lived readback capabilities and are never persisted in a receipt.

## Failure and retry contract

- Google and Airtable reads can retry bounded transient failures.
- Airtable attachment POST never retries automatically because a lost response can hide a successful append.
- An ambiguous POST is reconciled by deterministic filename plus a fresh, full-byte readback. Zero matches stays `ambiguous/manual_review`; one verified match is `deduped`; multiple matches fail closed.
- Every identity, schema, MIME, size, image-structure, or SHA mismatch fails before `processed`.
- Errors contain only stable codes, IDs already supplied by the caller, and lifecycle state. Tokens, file bytes, source filenames, attachment URLs, and response bodies are excluded.

## Lifecycle and retention

Successful receipts carry this lifecycle:

`pending → downloaded → validated → uploaded → verified → processed`

For a pre-existing or reconciled attachment, `uploaded` means the write outcome was observed, not that a second write occurred. All receipts state:

```text
sourceDisposition = retained_private
deletionActor = external_operator
```

`retainUntil` is optional advisory metadata. The adapter does not schedule or execute deletion.

## Rollback contract

`planAttachmentRollback` is pure and does not mutate Airtable. It returns `removable` only when all of the following still hold after a fresh read:

- the transfer created an attachment, or a readback-integrity failure recorded one exact created attachment ID;
- the base/table/record/field tuple is unchanged;
- the current attachment IDs are exactly the before-snapshot plus that created ID;
- the created ID and deterministic filename each match once.

The plan names one `removeAttachmentId` and every `preserveAttachmentId`. If the record changed, evidence is incomplete, identities are duplicated, or the transfer was deduped, rollback is blocked/not applicable. A future owner-approved executor must reread again and apply only that plan; it must never delete the Drive source, record, table, schema, or any pre-existing attachment.

## Test-only evidence

The test suite uses synthetic 1×1 PNG and JPEG fixtures with fixed full-file SHA-256 digests. Mock Drive and Airtable providers reject every unexpected request. No Production base, record, schema, Drive folder, Drive file, credential, or customer data is embedded or contacted.
