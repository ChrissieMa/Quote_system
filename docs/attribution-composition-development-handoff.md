# Attribution runtime composition Development handoff

Recorded: 2026-11-25 07:40 HKT  
Status: `in_progress`  
Scope: Quote System PR #40, Development only

## Source

- Branch: `codex/attribution-systems-v1-20261122`
- Previous reviewed PR head: `238efd6e28295e0cce7df607ddccdafa6852ba80`
- Disabled composition candidate: `b798e3edaaf4b908b367728411c2529f2b22431c`
- Formal master included by the branch: `2ff9990640e481a261edbac820be7689620d21ee`
- The feature remains literal-disabled. No merge, deployment, schema change, business-data access, configuration change or activation was performed.

## Candidate behavior

- The normal CLI contains one literal `ATTRIBUTION_ACTIVATION_ENABLED = false` gate.
- Disabled startup performs no attribution deployment-config read, proof-key read, store open, table access, projection or route mount.
- Future enabled startup accepts only the fixed private non-secret deployment file, exact schema/runtime, complete mapping and allowlists, fixed durable paths, a confirmed single-process writer and a distinct mounted device.
- Existing database, WAL and SHM paths must be absent or regular non-symlink files. Missing mount metadata, same-device directories, symlinks (including dangling links), non-regular files or configuration drift fail closed with one static message.
- Quote and Order may validly use the same physical field name because they are separate tables. Duplicate fields within one table mapping are rejected.
- The existing host Airtable/base client and owner authentication, origin and CSRF protections are reused. No activation endpoint, environment toggle, scheduler, writer takeover or dependency was added.

## Verification on Node 22.23.4

- Full existing inventory plus new composition tests: **271/271 passed**, zero failed/skipped/excluded. This contains the original 262 tests and nine new tests.
- Supplier shipping suites: **24/24 passed**.
- Attribution suites: **31/31 passed**.
- TypeScript build: passed.
- Final private peer snapshots: five frontend-to-router-to-business paths and 12 canonical scenarios passed using synthetic data only.
- Dependency audit: still exits nonzero with five existing affected package nodes (three moderate, one high, one critical). No broad audit fix or Express/Multer upgrade was made.

## Browser evidence limit

The final macOS normal-sandbox synthetic browser attempt timed out at the first `Page.navigate` with both the original 5-second bound and one 15-second diagnostic bound. No `--no-sandbox`, certificate bypass or weakened assertion was used. This is **not a browser pass**. The existing Linux normal-sandbox fixture must be rerun against the final candidate before any Production request. Synthetic CDP HTTPS is not real deployed TLS.

A focused follow-up captured only the synthetic auto-attached target state and routing errors. It observed one `page` target with `waitingForDebugger=false` and no routing error. This disproves the suspected ignored paused-target cause; no auto-attach or interception behavior was changed, and the temporary macOS diagnostic edits were removed.

## Future activation and rollback

Activation is not approved. After all remaining gates and a separate explicit Production approval, the reviewed source change is exactly:

`const ATTRIBUTION_ACTIVATION_ENABLED = false;` → `true`

The operator must separately provision the fixed non-secret deployment file and private proof-key file without placing either value in Git, chat or evidence. Invalid or absent files keep attribution closed while ordinary Quote and Supplier routes remain available.

Before merge, rollback is simply to leave PR #40 unmerged. If the disabled candidate is later merged under approval, source rollback is a revert of `b798e3edaaf4b908b367728411c2529f2b22431c`; keep the literal false and do not delete any durable store, schema or history. Activation/configuration rollback is always false first, with no automatic writer recovery.

## Remaining gate

Obtain one final Linux normal-sandbox browser pass at this candidate, then assemble the separate Production approval packet. Production merge, deployment, schema/config installation, key provisioning and activation remain unapproved.
