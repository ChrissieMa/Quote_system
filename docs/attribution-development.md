# Attribution bridge development

**Status: development only, disabled by default.** The router, validator,
local transactional store and optional owner workflow hooks require explicit
in-process configuration and injected adapters. No production provider,
configuration, schema change or deployment is included.

The local adapter uses `node:sqlite`; this requires a Node release with that API
available without a runtime flag (Node 22.13 or later). It has been exercised
locally on Node 26, not against the production runtime. The caller supplies the
database path and a stable, secret proof key. Loss or rotation of that key
invalidates replay of existing receipts; storage protection, key management,
backups, retention, recovery and multi-host deployment need separate review.
Expired codes remain reserved in a local registry so old messages cannot
resolve to a different snapshot. Registry growth and retention are unresolved.
This local adapter is not a production storage recommendation.

The application mounts the router before its global body parser only when
explicitly configured. Configuration must supply a bounded rate limiter, a
store, allowlists, an Airtable transport and explicit field mappings; the
application supplies its owner authentication, origin and CSRF checks.
Automated attribution remains separate from the existing manual source stream.

The local binding transaction is the selection linearization point. It
serializes with revocation, fixes Inquiry First once, updates Latest only on a
verified selection, pins each Quote (including Unknown), copies its pin to the
Order and enqueues projection work. Revocation first prevents binding; binding
first protects that handoff from revocation. A missing selection never borrows
the Inquiry's earlier attribution. Local failures and pending projection do not
block the existing sales operations.

The asynchronous projector uses an injected Airtable SDK table client and an
explicit mapping. No network operation runs inside a SQLite transaction. Its
bounded `flush()` is called explicitly; no scheduler or service is installed.
The local pins are authoritative, and remote updates cannot be atomic with
them. The Inquiry revision prevents a stale queued update from replacing a
newer projected Latest. Existing conflicting First or Quote/Order links stop
projection rather than being overwritten.

Airtable does not provide native uniqueness or compare-and-set here. Before
constructing the transport, an operator must verify that **all** writes to the
mapped attribution records and links are exclusively serialized through one
shared local store and this transport, including across hosts and external
integrations. Multiple independent local stores or uncoordinated writers are
not safe. The local durable writer lock has no automatic lease or takeover.
Before each remote mutation it records an in-flight marker. A crash or
uncertain remote response leaves projection blocked, including after restart.
`projectionWriterStatus()` and `recoverProjectionWriter()` support explicit
recovery only after all prior writers are stopped, every in-flight remote
request is settled, and any uncertain create is reconciled to its actual
record ID. Wrong or duplicate mappings and ambiguous remote records require
manual investigation; never guess or automatically retry an uncertain create.
The confirmation argument is not proof of those operator checks. Provider,
shared-storage, recovery, permission and operational preflights remain gates.

## Proposed additive migration

After separate approval, preflight the current schema and exact field types
without reading customer records. Propose a separate attribution table for a
bound verified handoff, first/last normalized touch, consent, capture time and
expiry, with optional links to existing approved Campaign records.
Add first/latest attribution links to Inquiry and an immutable attribution link
to each Quote and Order. Do not repurpose existing fields, add arbitrary Campaign
options, backfill, or apply schema changes as part of this development work.
Missing or mismatched fields must fail preflight without writes.

| Target | Proposed mapping |
| --- | --- |
| `Attributions` | `Handoff Code`, `Attribution ID`, `Contract Version`, `Entry Surface`, `Created At`, `Expires At`, `Consent At Capture` |
| `Attributions` touches | First/last touch time, channel, source, medium, landing path, evidence and confidence as separate fields |
| `Attributions` campaigns | `First Campaign` and `Last Campaign` link only approved keys to existing Campaign metadata with matching source |
| `Inquiries` | `First Attribution`, `Latest Attribution`, and numeric `Attribution Projection Revision`, within the active cycle |
| `Quotes` | `Attribution Snapshot` links the explicitly selected verified snapshot; otherwise Unknown |
| `Order_2026` | `Attribution Snapshot` copies its Quote's pinned link; otherwise Unknown |

## Remaining work and release

The optional owner paste fields and Inquiry, Quote and Order hooks use the
local durable binding implementation. The runtime projector has only been
exercised with a synthetic Airtable table client, not a live provider.
Production-compatible storage, exclusive-writer preflight and recovery,
retention, schema approval, and private canonical acceptance remain **pending**.
The pinned frontend fixture exercises a synthetic parent/iframe/backend/business
chain, not a live deployment. Following an Inquiry's create-Quote action transfers
its selected code once in same-tab owner session storage, for at most a minute.
The Quote still verifies that code; absent or expired selection is Unknown.
The existing frontend consent, tag, privacy and legacy advertising compatibility
gates remain open.

Run isolated tests with `npm run test:attribution`. To exercise the actual
frontend modules without copying them into this repository, run
`node -r ts-node/register src/test-only/attribution-frontend-fixture.ts <website-module-path> <configurator-module-path> [vectors-path] [wire-output-path]`.
The paths must refer to independently obtained local fixtures; keep non-public
fixtures and captured payloads outside this repository.

Only after separate approvals: preflight and apply the additive migration,
deploy the backend disabled, deploy frontends disabled, validate all integration
gates, then consider enabling. Rollback disables only the new feature and
restores the prior builds; retain existing records and links. Do not change
existing tracking, delete business history, or run unapproved cleanup.
