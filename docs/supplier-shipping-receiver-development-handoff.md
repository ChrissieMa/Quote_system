# Supplier shipping receiver development handoff

Date: 2026-11-21 HKT

Owner: Systems / Quote System

Status: `release_candidate` development core only

## Completed

- Rebased development scope on Quote `origin/master` `52a0783dd8fec773b8f845ade124def74440905e`.
- Read Supplier Portal `.30` shipping handoff and verified that its deployed functional source is `ebc8459784fb2d5d08ddeb082161eb2263cb4e8e`; the newer Supplier `main` commits only add rollout evidence.
- Added the HTTP-independent `lks.supplier-shipping.v1` receiver core.
- Added strict allowlist validation with no customer PII, selling prices, Quote Tokens or images.
- Required an exact Airtable Order Item record ID per Supplier item; order-number guessing is impossible in the contract.
- Added exact payload hashing, revision chains, duplicate SF-number checks, exact replay handling and committed-batch correction stop.
- Kept China parcel counts separate from Delivery Packages and excluded light/accessory fields from the contract.
- Kept SF actual/chargeable totals record-only; allocation input comes only from active per-parcel weights.
- Defined an adapter boundary that must provide durable compare-and-set and atomic or verified forward-completion behavior.
- Documented the Supplier outbox/mapping changes and all remaining production approvals.

No HTTP route, Airtable adapter, credential, schema, Railway setting, Supplier code, Production record or deployment was added.

## Validation

- Receiver-specific tests: 12 passed.
- Full Quote suite: 246 passed, 0 failed.
- TypeScript build: passed.
- Diff whitespace check: passed.

The tests use synthetic Airtable record IDs and an in-memory transactional adapter. They cover:

- missing and ambiguous mapping fail-closed;
- incomplete batch and combined/duplicate parcel rejection;
- exact replay with one economic effect;
- two receiver instances racing the same batch;
- duplicate non-empty SF number rejection;
- simulated failure after Item writes with complete rollback and safe retry;
- source revision correction-chain validation;
- already-linked Item and post-commit correction review gates;
- exact decimal precision and immutable correction history;
- SF actual/chargeable values not affecting allocation inputs;
- no Delivery light Package double-counting.

## Production blocker

The current Airtable sequence is multi-record and is not transactional. A Production adapter cannot honestly promise atomicity without a durable receipt/staging design and a committed-only formula boundary. This requires a separate Airtable schema/formula proposal and Owner approval before implementation.

## Next approval package

Before any live connection, Systems should present one concrete plan covering:

1. exact receipt/staging fields or table;
2. Source Batch uniqueness and duplicate SF-number enforcement;
3. prepared/applying/recovery-required/committed transitions;
4. formula behavior while a batch is not committed;
5. exact protected endpoint authentication and credential rotation;
6. Supplier mapping/outbox implementation;
7. synthetic end-to-end Test, rollback/forward-recovery procedure and deployment sequence.

Open business decisions remain listed in `supplier-shipping-receiver-contract.md`; no default was chosen for split shipments, reissue/rework, combined packages or freight residuals.
