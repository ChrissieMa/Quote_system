# Integrated magnetic structure and RGB quote options

Status: development release candidate; not merged or deployed.

Baseline: `origin/master` at `ecafe075c1f32be28793180178ce62840a766752`.

## Scope

- Adds `一體磁吸結構` as a new Quote structure option without renaming the legacy `磁石門` value.
- Applies the approved outer-dimension rules only to `Display box 展示盒` with `一體磁吸結構`.
- Keeps the existing light accessory keys and pricing, while showing the customer-facing `三圈燈` labels.
- Adds four `彩燈` accessories with an HKD 100 customer surcharge per accessory quantity.
- Adds the supplier RGB strip surcharge at RMB 10 per calculated metre on top of the existing light cost.
- Adds the non-blocking warning when one RGB light group exceeds 5 metres.
- Keeps the existing quotation-image contract: legacy lights retain their canonical mapping, the integrated structure falls back to the accepted magnetic-door mapping, and RGB accessories are not sent as if the renderer already supports their colour effect.

## Verified examples

| Example | Result |
| --- | --- |
| 27 × 27 × 36, integrated structure, top + bottom lights | 28 × 28 × 40.6 cm |
| Same example plus backlight | 28 × 29.8 × 40.6 cm |
| RGB independent top light ×1, 25 × 25 | 1 m; RMB 10 supplier surcharge; HKD 100 customer surcharge |
| RGB independent top light ×2, 25 × 25 | 2 m; RMB 20 supplier surcharge; HKD 200 customer surcharge |
| RGB independent top + bottom light ×1, 25 × 25 | 2 m; RMB 20 supplier surcharge; HKD 100 customer surcharge |
| RGB independent top + bottom light ×2, 25 × 25 | 4 m; RMB 40 supplier surcharge; HKD 200 customer surcharge |

## Verification

- Full automated test suite: 197 passed, 0 failed.
- TypeScript production build: passed.
- Visual QA: Create Quote shows the two approved structure choices, the four `三圈燈` labels, the four `彩燈` choices, the calculated outer dimensions, RGB metres, supplier surcharge and customer surcharge.

## Production gates

No Production, Railway or Airtable change is included. Before Production release, the exact new multiple-select values must be approved and added to the Airtable `Order Items.Accessories` field, followed by conversion validation. Merge and deployment also require separate Owner approval.

Dedicated 3D visuals are outside this change. Until the 3D Project implements them, the Quote adapter uses the safe compatibility behaviour documented above.
