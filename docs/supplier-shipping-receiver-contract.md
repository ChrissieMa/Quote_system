# Supplier Portal → Quote/Airtable shipping receiver contract

Status: `release_candidate` development design only

Date: 2026-11-21 HKT

Contract: `lks.supplier-shipping.v1`

This development branch contains the validated, HTTP-independent Systems receiver core. It is not connected to a route, Airtable, Railway or Supplier Production. It reads no credentials and performs no Production write.

## Boundary

Supplier Portal is the single LKS-operated place for capturing parcel weights and the SF batch header. Systems remains responsible for:

- resolving one exact Airtable Order Item record ID per Supplier item;
- applying the existing China-freight allocation inputs;
- durable idempotency, receipt history, failure recovery and confirmed acknowledgements;
- leaving Hong Kong Delivery package creation to Delivery System.

The payload contains no customer name, phone, email, address, selling price, Quote Token, customer image or quotation image. Unknown fields are rejected. Order numbers are not accepted as a substitute for Airtable record IDs.

## Proposed request

The future authenticated endpoint is proposed as:

`POST /api/integrations/supplier-shipping/v1/batches`

It is deliberately not registered in the application in this development branch. The exact service authentication, credential owner, Railway settings and Production URL require separate Owner approval.

Synthetic example:

```json
{
  "contract": "lks.supplier-shipping.v1",
  "sourceSystem": "LKS_Supplier_Portal",
  "sourceVersion": "SP-TRIAL-20261121.30",
  "sourceBatchId": "SPCN-ABCDEF1234567890",
  "sourceRevision": 1,
  "previousPayloadSha256": null,
  "correctionReason": null,
  "createdAt": "2026-11-21T12:00:00+08:00",
  "shipment": {
    "shipmentNo": "SYN-SF-RECEIVER-001",
    "shipmentDate": "2026-11-21",
    "sfFreightRmb": "200.00",
    "sfActualWeightKg": "99.500",
    "sfChargeableWeightKg": "100.000"
  },
  "items": [
    {
      "sourceItemId": "supplier_item_a",
      "orderItemRecordId": "recAAAAAAAAAAAAAA",
      "activeParcels": [
        { "sourceParcelId": "parcel_a1", "weightKg": "1.500" }
      ],
      "parcelChanges": []
    }
  ]
}
```

## Field rules

| Field | Rule |
|---|---|
| `sourceBatchId` | Stable Supplier batch identity. Current Supplier `SPCN-...` reference is suitable. |
| `sourceRevision` | Starts at 1. A later revision must name the previous payload SHA-256 and include a correction reason. |
| `orderItemRecordId` | Exact Airtable Order Item record ID. Missing, ambiguous, duplicated or already-linked targets stop the whole batch. |
| `activeParcels` | One entry per physical China parcel. Weight is a positive decimal string with at most 3 places. One parcel ID belongs to exactly one Order Item. |
| `parcelChanges` | Immutable correction/void history supplied by Supplier. It is retained in the receipt snapshot but never used instead of current active parcels. |
| `sfFreightRmb` | Positive decimal string with at most 2 places. It remains the existing China freight input; no Alipay goods-payment rate is applied by this receiver. |
| `sfActualWeightKg`, `sfChargeableWeightKg` | Optional non-negative record-only values, at most 3 places. They never replace per-parcel weights for allocation. |

The receiver derives for each Order Item:

- `China Freight Piece Count` = number of active China parcels;
- `China Freight Piece Weights KG` = the exact active parcel weight strings;
- `China Freight Weight Input KG` = the exact active parcel sum, represented to at most 3 decimal places.

It passes exact item totals and batch freight to the future Airtable adapter. It does not calculate or round the final per-item RMB/HKD allocation in application code; existing Airtable allocation remains the authority until a separately approved rule changes it.

SF actual and chargeable totals are stored only as header evidence. Delivery later reads `China Freight Weight Input KG` and `China Freight Piece Count`. Delivery's separate “light accessory +1 Package” rule remains downstream and must not be included in the Supplier China parcel count.

## Idempotency and correction behavior

The receiver hashes the complete validated payload, including exact decimal spelling, source version and correction history.

- Same batch ID + same revision + same hash after commit → return the earlier receipt; no second Shipment, item update or allocation.
- Same batch ID + same revision + different hash → `idempotency_conflict`; never overwrite.
- Lower revision → `stale_source_revision`.
- Higher revision after a retryable pre-commit failure → allowed only when it chains to the exact earlier hash and includes a reason.
- Higher revision after a committed batch → `committed_batch_correction_requires_review`; no automatic business-data overwrite.
- Item already linked to a China Shipment → `order_item_already_shipped`; no partial or replacement guess.

Original payloads, payload hashes, attempts, states, failure codes and acknowledgements are immutable receipt evidence. Supplier must retry the exact same body after an uncertain response.

## Failure and retry states

| State | Meaning | Supplier action |
|---|---|---|
| `committed` | All target writes verified and one receipt exists. | Save acknowledgement; show synchronized only after this response. |
| `already_committed` | Exact replay of a committed payload. | Treat as the same success; do not create another batch. |
| `retryable_failure` | No business effect is accepted; mapping/provider failure can be retried. | Keep the outbox item and retry the exact payload/key. |
| `rejected` | Conflict, already-shipped item or correction requiring human review. | Stop automatic retry and show LKS review required. |

The adapter interface requires an atomic commit or an equivalent verified forward-completion protocol. Tests simulate a failure after item updates and confirm all business writes roll back before a retry.

### Production Airtable limitation

Airtable does not provide one transaction across multiple Order Item updates plus a China Shipment create. The current manual Quote route updates Items before creating the Shipment, so directly reusing it would not meet this contract's recovery guarantee.

Before Production, Systems needs one approved durable integration receipt/staging design. A safe forward-completion design would require, at minimum:

1. a unique Source Batch ID and payload hash receipt;
2. explicit `prepared`, `applying`, `recovery_required`, `committed` states;
3. exact before/after snapshots and verified idempotent item writes;
4. a pending/committed boundary that prevents partial records from entering allocation;
5. a reconciliation path that completes forward without automatically deleting Production records.

This likely needs Airtable fields or a dedicated receipt table and formula/status changes. None are created in this branch.

## Supplier Portal handoff

Supplier repository changes are not included here. Supplier needs to implement the following separately:

1. Store the exact Systems-provided `orderItemRecordId` against each Supplier item before shipping. Do not search by order number at send time.
2. If one Supplier order maps to zero or more than one candidate Item, show “未配對／有歧義” and do not send.
3. Build the payload from the immutable finalized weighing event, including all active parcels and its correction/void history.
4. Keep a durable outbox with `pending`, `sending`, `retryable_failure`, `confirmed`, and `review_required` states.
5. Reuse the same `sourceBatchId`, revision, exact body and idempotency identity for network retries.
6. Save the returned payload hash, receipt identity and Shipment result. Do not show “已同步” before `committed` or matching `already_committed`.
7. Never send customer PII, customer selling prices, Quote Tokens, images, Supplier freight payer/payment status, accessories or Hong Kong Delivery package counts.
8. A corrected pre-commit payload must increment `sourceRevision`, point to the prior hash and include the LKS correction reason.

The preferred future mapping source is the Systems order-to-Supplier handoff when a production item is first created. Manual copying of Airtable record IDs into shipment screens should not become the normal workflow.

## Decisions still required from Chrissie

These are intentionally not decided by code:

1. Same Order Item split across more than one China shipment.
2. Replacement/rework/reissue identity: new Order Item versus a dedicated shipment-line model.
3. One physical parcel containing products from multiple Order Items.
4. Final freight rounding and residual-cent ownership in Airtable.
5. Whether a committed batch correction is a reversing adjustment, a new Shipment, or an Owner-approved edit.
6. Durable receipt/staging location and the required Airtable schema/formula changes.
7. Service-to-service authentication method, credential owner and rotation procedure.

Until these are confirmed, the receiver fails closed for the affected cases.

## Production approvals still required

- Airtable schema/formula/Automation changes;
- any Production Airtable write or existing-record migration;
- connector credential creation, storage, rotation and permissions;
- Railway configuration and Quote deployment;
- Supplier Portal connector/outbox deployment;
- any Delivery change for split/reissue/multiple deliveries;
- a final synthetic end-to-end Test followed by separate Production approval.
