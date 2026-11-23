# Attribution bridge readiness

**Status: synthetic Development acceptance only; disabled by default. No
Production readiness or approval is implied.** No provider, database volume,
schema, live business data, frontend configuration, tracking configuration or
service has been created or changed.

## Runtime composition and storage gate

The host starts with no attribution router mounted. `configureAttribution` is
an explicit in-process composition point; it returns without activation unless
its caller explicitly passes `enabled: true`. It receives a
`LocalAttributionStore`, validation allowlists, an injected request limiter,
the asynchronous Airtable projection transport and a complete explicit field
mapping. `createAirtableProjectionTransport` must receive that same store, an
explicit Airtable base client and an explicit exclusive-writer confirmation.
There is no environment-variable configuration, default base, credential,
campaign key, background worker, timer or automatic recovery in this feature.
The host bootstrap does not call this composition point.

The expected backend is the Quote service, and the Website/3D browser origin is
`https://lksdisplaybox.online`. `createAttributionBrowserAdapter` rejects any
other browser origin and contains only the fixed Quote API origin
`https://quote.lksdisplaybox.online` and the fixed handoff/revocation paths.
Requests use `mode: cors`, `credentials: omit`, `redirect: error`, JSON bodies,
and no referrer. The adapter does not accept an endpoint, runtime switch,
arbitrary path or query string. The API router grants CORS only to the exact
Website origin, answers only the expected POST preflight, does not allow
credentials or wildcard origins, and rejects `null` and other origins.
Synthetic Chrome coverage exercises the real browser preflight and cross-origin
request locally; it makes no live endpoint request.

Production campaign validation and projection mappings must start empty. Add
only explicitly approved campaign keys linked to existing Campaign metadata
with a verified matching source. Synthetic campaign keys and records used by
tests are not Production configuration; never create Campaign records from
incoming values. The global GA4 outbound-click gate remains **NO-GO**. No
identifier, message, raw URL, Quote token or business reference is to be sent
to GA4 or written to logs.

The local store requires Node `node:sqlite` support (Node 22.13 or later); the
current hosted runtime reports Node 22.23.4. Concurrent WAL initialization
retries SQLite busy errors for at most ten seconds and surfaces other database
errors. That does not establish durable Production storage. Railway's attached
persistent-volume behavior for this SQLite file and its WAL sidecars is
unproven; this is a hard preflight gate. Do not select an ephemeral filesystem
or assume that one replica makes it durable. Before any separate approval,
verify a persistent mount, same-volume WAL operation, file permissions,
restart/reopen behavior, backup/restore and the one-writer topology using only
synthetic records. No provider or volume has been created here.

Startup preflight must also verify runtime compatibility, the explicit base and
table mapping, exact existing schema, campaign allowlist, rate limiter, owner
authentication/origin/CSRF wiring, and that no other process or integration can
write the mapped projection. It must not read customer records. A failed
preflight means do not call `configureAttribution` with `enabled: true`.

## Binding, projection and recovery

The local SQLite transaction is the business-selection linearization point. It
serializes binding with revocation, fixes Inquiry First once, updates Latest
only for a verified touch, pins each Quote (including Unknown), copies its
immutable pin to an Order, and enqueues projection work. Existing manual
customer-source fields remain a separate stream. Existing Quote and Order
creation is fail-open: a storage/projection failure does not block sales.

After each successful local binding, the runtime requests one bounded,
coalesced, fire-and-forget projection attempt. It never waits for the network
on the sales response. A concurrent request for the same projector is skipped;
the durable outbox remains pending and a static internal error is reported if
the batch is incomplete or fails. Later successful bindings or an explicit
local `flush()` can retry. There is no scheduler or timer. No network request
runs inside a SQLite transaction.

Airtable is not treated as providing uniqueness or compare-and-set. Query and
create are serialized only by the durable local exclusive-writer state. The
Inquiry projection revision protects a newer Latest value from an older queued
write; existing conflicting First or Quote/Order links are never overwritten.
Local pins are authoritative, but local and remote stores are not atomic.
Multiple independent local databases or uncoordinated remote writers are
unsafe.

The durable writer has no lease or automatic takeover. It records an
in-flight marker before each remote mutation. A crash or uncertain provider
response blocks further projection, including after restart. Before
`recoverProjectionWriter`, stop all previous writers, verify every request is
settled, reconcile uncertain remote creates/updates to actual record IDs, and
review all duplicate or conflicting links. Never guess a record ID or retry an
uncertain create automatically. The recovery confirmation argument is not
proof that these checks were performed.

Handoff codes and receipts expire at exactly seven days; browser journey
retention remains 30 days. Expired code reservations are intentionally retained
to prevent reuse, and local Quote/Order pins are retained for immutable
business history. There is no automatic garbage collection. An owner-approved
retention, backup and secure-disposal policy is still required before
Production; do not purge or compact records as part of this proposal.

## Additive schema proposal only

The current schema review found no `Attributions` table. The following is a
proposal, not an applied migration. Preflight exact table/field IDs and types
without reading customer records; fail closed on mismatches. Do not rename
existing fields, alter select choices, repurpose duplicate legacy links, or
create Campaign records.

| Target | New physical fields |
| --- | --- |
| `Attributions` (24 direct fields) | `Handoff Code`, `Attribution ID`, `Contract Version`, `Entry Surface`, `First Touch At`, `First Channel`, `First Source`, `First Medium`, `First Campaign`, `First Landing Path`, `Last Touch At`, `Last Channel`, `Last Source`, `Last Medium`, `Last Campaign`, `Last Landing Path`, `First Evidence`, `Last Evidence`, `First Confidence`, `Last Confidence`, `Consent At Capture`, `Created At`, `Expires At`, `Revoked At` |
| `Inquiries` (2 links + 1 number) | `First Attribution`, `Latest Attribution`, `Attribution Projection Revision` |
| `Quotes` (1 link) | `Attribution Snapshot` |
| `Order_2026` (1 link) | `Attribution Snapshot` |
| Airtable-generated inverse fields (6) | Two Campaigns inverses for First/Last Campaign; four Attributions inverses for the Inquiry, Quote and Order links above |

This is **35 physical fields**: 24 direct Attributions fields, four business
links, one Inquiry revision, and six automatically generated inverse fields.
Keep the existing canonical `Quotes.Inquiry` and `Order_2026.Inquiry` links
unchanged; do not repurpose duplicate legacy Inquiry links. Preserve existing
manual source fields and all existing formulas/options.

## Release order, rollback and validation limits

Only after separate Production approval: (1) approve the retention and
persistent-storage design; (2) perform schema-only preflight and separately
approve the additive 35-field migration; (3) provision and validate the
persistent provider and single-writer recovery process; (4) deploy the backend
with attribution disabled; (5) validate the browser CORS, owner-security,
business-binding, restart and recovery gates with synthetic data; (6) coordinate
frontend releases disabled; (7) consider activation only under a separate
explicit approval, with the Production campaign allowlist empty until reviewed.
No Website/3D, GTM, GA4 or Ads settings are changed here.

Rollback by disabling the feature and restoring prior application/frontend
builds. Leave additive fields and historical business links intact; do not
delete or rewrite business history. Any schema cleanup requires separate
approval.

The owner-actions E2E now uses the real registered application routes via an
explicit-options app factory and a synthetic local Quote adapter. Importing the
app does not run dotenv or the CLI startup, and the fixture supplies all its
configuration explicitly. The test exercises login, same-origin and CSRF
rejection, payment replay, receipt rendering and duplicate expense upload.
Normal CLI startup retains its existing configuration and listening path.

Historically, two full-inventory attempts included the old E2E bootstrap; each
reported 260 passed, one failed, and zero skipped because the local fixture did
not start. The old test's cleanup sent SIGTERM to its child and removed its
temporary files, but whether an external call could have occurred before those
failures is unproven. The subsequent safe inventory passed 260 tests with that
entire E2E file excluded. Those historical attempts must not be reported as
full-suite passes.

On Node 22.23.4, the focused attribution suites passed 22/22 and the TypeScript
build passed. The unchanged full repository test inventory passed 261/261,
with zero failures, skips or exclusions. The earlier pinned synthetic frontend-to-router-to-business fixture
passed five paths and 12 canonical scenarios. Direct browser-adapter tests
passed. Earlier local Chrome trials are excluded from acceptance because
those runs disabled the browser sandbox and certificate verification. A later
normal-sandbox diagnostic identified an iframe preflight that reached loopback
before child interception was enabled and failed with connection refused.
The corrected local CDP fixture waits for child interception before making
the opaque request: the router observes `Origin: null` and returns 403, and
the browser rejects it. The fixture also exercises first-party create/revoke,
disallowed origin and header, missing origin, invalid path, and the adapter's
opaque-origin rejection without a fetch. CDP fulfillment tests browser-origin
behavior only; it is not real TLS validation. Final pinned peer frontend
modules were not supplied to this fixture, so the combined final-peer browser
chain remains a separate acceptance gate.

## Locked dependency audit assessment

The following is a source-based assessment, not a penetration test or
Production verification. The classifications concern the stated advisory
mechanisms, not every possible defect in a package.

| Locked package | Advisory and fixed range | Local call path and assessment |
| --- | --- | --- |
| body-parser 1.20.8 | GHSA-27r3-jxmh-p828, fixed in 1.20.9 or later in the 1.x line | **Reachable parser; exploitability uncertain.** Global JSON and extended form parsers run before route authentication and accept compressed request bodies by default. The 1 MB limit is not evidence that the compressed trailing-bytes denial of service is prevented; ingress controls are unverified. |
| Express 4.22.2 | Audit finding inherited from qs GHSA-6pq8-jhm2-2vcw | **Uncertain dependency finding.** Express uses qs for query parsing, not the advisory's `qs.stringify` call. No independent Express advisory appears in this audit result; remediation must address the resolved qs version and verify compatibility, not assume a particular Express upgrade alone fixes the override. |
| Multer 2.3.0 | GHSA-3pph-fpjx-jg34 fixed in 2.4.0; GHSA-q7qp-rjg7-q26m fixed in 2.5.0 | **Advisory prerequisites not present in the inspected app.** The owner-authenticated, same-origin expense upload uses memory storage, not disk storage, and configures no asynchronous file filter. Its one-file/5 MB limit does not fix either package vulnerability; reassess if upload configuration changes. |
| proxy-addr 2.0.7 | GHSA-jqcg-44mw-7w3h fixed in 2.0.8 | **Specific subnet-matching path not used by the inspected app.** Express is configured with a numeric one-hop trust function, rather than an IPv4-mapped IPv6 trust subnet. Login and attribution rate limiting use `req.ip`; actual proxy-chain behavior and any other consumers require separate verification. |
| qs 6.16.0 | GHSA-6pq8-jhm2-2vcw affects versions through 6.16.0; a non-affected version must be newer | **Uncertain.** The inspected application, Express, body-parser and Airtable source paths did not call `qs.stringify`; Express/body-parser do parse untrusted query/form data with qs. This does not prove that no indirect or future caller can reach the advisory's stringify case. |

`npm audit` reports five package findings (two moderate, two high, one critical).
No dependency upgrade or audit fix was applied. Review fixed releases and the
lockfile override separately; audit findings and ingress/provider assumptions
remain Production gates.
