# Attribution runtime composition Development handoff

Recorded: 2026-11-25 07:51 HKT
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

The final macOS normal-sandbox synthetic browser attempt timed out at the first `Page.navigate` with both the original 5-second bound and one 15-second diagnostic bound. No `--no-sandbox`, certificate bypass or weakened assertion was used. This is not counted as a browser pass. Synthetic CDP HTTPS is not real deployed TLS.

A focused follow-up captured only the synthetic auto-attached target state and routing errors. It observed one `page` target with `waitingForDebugger=false` and no routing error. This disproves the suspected ignored paused-target cause; no auto-attach or interception behavior was changed, and the temporary macOS diagnostic edits were removed.

A minimal `pull_request`-only Linux acceptance workflow is now present on PR #40 with `contents: read`, disabled checkout credential persistence, exact Node 22.23.4, the hosted runner's installed Google Chrome and the existing normal-sandbox fixture. It contains no secret/environment read, private peer source, deployment or Production action. The launcher runs Chrome directly for the hosted runner's unprivileged user and retains the root-only `nobody`/`setpriv` path; it adds no `--no-sandbox` or certificate bypass.

GitHub Actions run [45513148675](https://github.com/ChrissieMa/Quote_system/actions/runs/45513148675) completed successfully at 2026-11-25 07:50 HKT. The `normal-sandbox-cors` job passed checkout, exact runtime/browser verification and the existing browser adapter/router CORS acceptance, including OPTIONS and `Origin: null` rejection. This closes the final Linux normal-sandbox Development gate for the current source candidate. It does not prove real deployed TLS or authorize Production.

## Future activation and rollback

Activation is not approved. After all remaining gates and a separate explicit Production approval, the reviewed source change is exactly:

`const ATTRIBUTION_ACTIVATION_ENABLED = false;` → `true`

The operator must separately provision the fixed non-secret deployment file and private proof-key file without placing either value in Git, chat or evidence. Invalid or absent files keep attribution closed while ordinary Quote and Supplier routes remain available.

Before merge, rollback is simply to leave PR #40 unmerged. If the disabled candidate is later merged under approval, source rollback is a revert of `b798e3edaaf4b908b367728411c2529f2b22431c`; keep the literal false and do not delete any durable store, schema or history. Activation/configuration rollback is always false first, with no automatic writer recovery.

## Remaining gate

The Linux normal-sandbox Development gate is passed. Production merge, deployment, schema/config installation, key provisioning, live operational verification and activation remain unapproved and require a separate concrete Production plan and explicit Owner approval. The existing dependency-audit findings also remain recorded above; no broad dependency upgrade was made in this bounded change.
