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
store, allowlists and a business adapter; the application supplies its owner
authentication, origin and CSRF checks. Automated attribution remains separate
from the existing manual customer-source stream.

The business adapter interface is synchronous and intended for synthetic local
fixtures. Projection and link operations must be atomic, idempotent and preserve
existing Quote/Order snapshots. The local store holds a transaction during the
callback so a racing revocation cannot bind an invalid handoff, but it cannot
atomically commit an external service transaction. A production integration
therefore needs an independently reviewed cross-store consistency and recovery
design; do not connect an asynchronous network adapter to this interface.

## Proposed additive migration

After separate approval, preflight the current schema and exact field types
without reading customer records. Propose a separate attribution table for a
verified handoff, first/last normalized touch, consent, capture time, expiry and
revocation status, with optional links to existing approved Campaign records.
Add first/latest attribution links to Inquiry and an immutable attribution link
to each Quote and Order. Do not repurpose existing fields, add arbitrary Campaign
options, backfill, or apply schema changes as part of this development work.
Missing or mismatched fields must fail preflight without writes.

| Target | Proposed mapping |
| --- | --- |
| `Attributions` | `Handoff Code`, `Attribution ID`, `Contract Version`, `Entry Surface`, `Created At`, `Expires At`, `Revoked At`, `Consent At Capture` |
| `Attributions` touches | First/last touch time, channel, source, medium, landing path, evidence and confidence as separate fields |
| `Attributions` campaigns | `First Campaign` and `Last Campaign` link only approved keys to existing Campaign metadata with matching source |
| `Inquiries` | `First Attribution` and `Latest Attribution`, within the active cycle |
| `Quotes` | `Attribution Snapshot` links the explicitly selected verified snapshot; otherwise Unknown |
| `Order_2026` | `Attribution Snapshot` copies its Quote's pinned link; otherwise Unknown |

## Remaining work and release

The optional owner paste fields and Inquiry, Quote and Order hooks use an
injected synthetic business adapter for development tests. Production Airtable
projection, a production-compatible storage/provider, cross-store recovery,
retention, and private canonical acceptance are **pending**. The pinned
frontend fixture exercises synthetic frontend-to-backend-to-business paths; it
does not validate a live frontend integration, iframe interoperability or
production deployment. Following an Inquiry's create-Quote action transfers
its selected code once in same-tab owner session storage, for at most a minute.
The Quote still verifies that code; absent or expired selection is Unknown.
The existing frontend consent, tag, privacy and legacy advertising compatibility
gates remain open.

Run isolated tests with `npm run test:attribution`. To exercise the actual
frontend modules without copying them into this repository, run
`node -r ts-node/register src/test-only/attribution-frontend-fixture.ts <website-module-path> <configurator-module-path>`.
Both paths must refer to independently obtained local fixtures.

Only after separate approvals: preflight and apply the additive migration,
deploy the backend disabled, deploy frontends disabled, validate all integration
gates, then consider enabling. Rollback disables only the new feature and
restores the prior builds; retain existing records and links. Do not change
existing tracking, delete business history, or run unapproved cleanup.
