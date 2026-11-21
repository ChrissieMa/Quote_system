# Supplier Portal → Quote/Airtable Production connection plan

Status: `release_candidate` plan only; not approved for Production execution

Date: 2026-11-21 HKT

## Fixed business behavior

Supplier Portal replaces the existing Quote owner China-freight page as the data-entry surface. It sends the same Shipment header, selected Order Items, China parcel count and per-parcel weights. Systems uses the same shared write-plan function as the existing page. Airtable keeps the existing freight allocation formula.

No new freight formula, RMB conversion, Delivery Package or light-package count is introduced.

## Minimum Airtable additions

No existing Order Item cost or freight formula needs to change for the normal flow.

Create one private technical table, `Supplier Sync Receipts`, containing only non-PII integration evidence:

| Field | Purpose |
|---|---|
| `Source Batch ID` | Stable unique Supplier batch identity. |
| `Source Revision` | Exact Supplier revision. |
| `Payload SHA256` | Detects changed retries. |
| `Source Version` | Supplier application version. |
| `State` | `prepared`, `applying_items`, `items_verified`, `creating_shipment`, `shipment_verified`, `recovery_required`, `committed`. |
| `Attempt Count` | Number of forward-completion attempts. |
| `Last Failure Code` | Sanitized failure category only. |
| `Original Payload JSON` | Allowlisted shipment data only; no customer data. |
| `Item Writes Verified` | True only after exact re-read. |
| `Shipment Record ID` | Created or recovered China Shipment identity. |
| `Shipment Verified` | True only after exact re-read. |
| `Created At`, `Updated At`, `Committed At` | HKT/offset-aware audit timestamps. |

Add these non-PII fields to `China Shipments`:

| Field | Purpose |
|---|---|
| `Supplier Source Batch ID` | Recovers a successful create after a lost response. |
| `Supplier Source Revision` | Confirms the exact submitted revision. |
| `Supplier Payload SHA256` | Confirms the exact payload. |
| `Supplier Source Version` | Records which Supplier build submitted the batch. |

`Source Batch ID` must be unique in application validation. The connector also checks Shipment No. uniqueness. Airtable itself has no enforceable unique constraint, so the application re-reads and verifies before acknowledging success.

Implementation note (2026-11-22): the receipt stores `Attempts JSON`, `Recovery State`, `Last Failure Code`, `Updated At` and `Committed At`; attempt count is derived from the attempt array. The approved non-PII Production schema now exists. Receiver deployment and credential activation remain separate runtime steps.

## Exact write sequence

1. Authenticate the Supplier request and reject stale or replayed signatures outside the approved window.
2. Validate the strict allowlist payload and exact Order Item record IDs.
3. Create or re-read the durable `prepared` receipt by Source Batch ID, revision and payload hash.
4. Resolve every Order Item and stop the whole batch if any Item is missing, ambiguous or linked to an unrelated China Shipment.
5. Build the same Airtable write plan used by the current owner page.
6. Write all Order Item parcel fields, then re-read every Item and verify exact equality.
7. Find an existing China Shipment by Source Batch ID/hash, or create it once with the same current fields plus the four Supplier evidence fields.
8. Re-read the China Shipment and verify the linked Item IDs, freight, date, weights and source evidence.
9. Mark the receipt `committed` only after both Item and Shipment evidence are verified.
10. Return `committed`; an exact later retry returns `already_committed` with the same Shipment record.

The China Shipment is created only after all Item weights are verified. Until that final create links the Items, the existing Airtable freight allocation has no new Shipment from which to allocate cost.

## Failure and retry

No automatic deletion or rollback is used.

| Failure point | Saved evidence | Retry behavior |
|---|---|---|
| Before Item writes | `prepared` | Re-run exact Item plan. |
| During Item writes | `recovery_required` | Re-apply the complete idempotent Item plan and re-read all Items. |
| After Item verification | `items_verified` | Continue at Shipment find/create. |
| Shipment create response lost | Receipt plus Source Batch/hash search | Find and verify the already-created Shipment; do not create another. |
| Shipment verification failure | `recovery_required` | Stop acknowledgement and require exact re-read/retry. |
| Response lost after commit | `committed` | Exact retry returns the same success. |
| Same batch/revision with changed body | Existing hash | Reject as `idempotency_conflict`. |

Supplier must keep the exact batch in its outbox until `committed` or matching `already_committed` is received. “Request sent” is never displayed as “已同步”.

## Authentication proposal

Use a dedicated Supplier-to-Quote request-signing credential, not an Airtable token and not a user login.

- Supplier signs method, path, timestamp and body SHA-256 using HMAC-SHA256.
- Quote verifies the signature with constant-time comparison and rejects timestamps outside five minutes.
- A key ID supports controlled rotation with at most current and next key active during a short overlap.
- Neither side logs the signature, secret, request body or protected environment value.
- The Production credential is created and stored only after separate Owner approval.

No credential is present in this development branch.

## Deployment sequence requiring separate approval

1. Approve and create the receipt table and four China Shipment evidence fields.
2. Deploy the Quote receiver behind a disabled feature flag.
3. Run one synthetic Test batch against an isolated Test base and verify exact parity with the current owner page.
4. Create the dedicated request-signing credential and configure both services without exposing it.
5. Deploy Supplier outbox/mapping support with sending still disabled.
6. Enable one controlled synthetic Production verification with no customer data.
7. Verify the receipt, Order Item fields, China Shipment and existing Airtable allocation.
8. Enable Supplier submission for normal batches.

Rollback is to disable Supplier submission and the Quote receiver flag. The existing owner page and existing Airtable calculation remain intact. No Production record is deleted automatically.

## Cases that remain blocked from automatic sync

- one Order Item split over multiple China Shipments;
- replacement/rework/reissue without a separately identifiable Order Item;
- one physical parcel containing multiple Order Items;
- correction after a batch is already committed;
- any batch with missing or ambiguous exact record-ID mapping.

These cases stop for LKS review rather than guessing.
