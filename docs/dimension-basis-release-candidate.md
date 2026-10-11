# Quote item dimension basis — release candidate

- Status: `release_candidate`
- Verified at: 2026-10-11 18:29 HKT
- Development baseline: `8075fd28aca9aa47d637a29e6d8fd63e294f07d7`
- Production deployment: not performed

## Scope

- Each Create Quote item has one mutually exclusive choice: `內尺寸為準` or `外尺寸為準`.
- New Quote items default to `內尺寸為準` for backward-compatible data entry.
- The choice is stored in Quote Items JSON and copied to `Order Items.尺寸基準` on invoice conversion.
- The choice is internal metadata only. It does not change pricing or calculate dimensions in reverse.
- Legacy Quote items without this metadata remain unclassified rather than being silently relabelled.

## Airtable evidence

The Owner-approved schema change added the `Order Items.尺寸基準` single-select field with the two choices above. The existing copy-only `Internal Size` formula now includes the selected dimension basis and remains a valid single-line formula. No Order Item records were changed.

## Verification

- Full automated test suite: 209 passed
- TypeScript build: passed
- Local browser QA: adding a second item preserves the first item's selection; each row can independently select a different dimension basis
