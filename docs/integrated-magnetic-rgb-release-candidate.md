# Integrated magnetic structure and RGB quote options

Status: development release candidate; not merged or deployed.

Baseline: `origin/master` at `6574633034b2e2c2dac456265035b9ab4081526b`.

## Scope

- Adds `一體磁吸結構` as a new Quote structure option without renaming the legacy `磁石門` value.
- Applies the approved outer-dimension rules only to `Display box 展示盒` with `一體磁吸結構`.
- Keeps the existing light accessory keys and pricing, while showing the customer-facing `三圈燈` labels.
- Adds four `彩燈` accessories with an HKD 100 customer surcharge per accessory quantity.
- Adds the supplier RGB strip surcharge at RMB 10 per calculated metre on top of the existing light cost.
- Adds the non-blocking warning when one RGB light group exceeds 5 metres.
- Keeps legacy three-ring-light quotation-image mappings unchanged.
- Sends `一體磁吸結構` through the established `door_magnetic` canonical key used by the new integrated four-door renderer.
- Sends the four RGB Quote choices through the matching `light_board_colour_*` modes implemented and tested by 3D Draft PR #24.
- Treats accessory quantity as commercial Quote data while rendering one visual light mode for each product image.

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

- Full automated Quote test suite: 205 passed, 0 failed.
- TypeScript production build: passed.
- Visual QA: Create Quote shows the two approved structure choices, the four `三圈燈` labels, the four `彩燈` choices, the calculated outer dimensions, RGB metres, supplier surcharge and customer surcharge.
- Local end-to-end Quote → 3D → Quote Share QA: a fictional 27 × 27 × 36 cm item with `一體磁吸結構`, `彩燈｜上下燈` and `背燈` produced one validated 1280 × 1280 PNG at 28 × 29.8 × 40.6 cm. The render request contained only approved configuration data and no customer, token, payment or price fields.
- 3D dependency verification at Draft PR #24: 130 tests passed and the production build passed.

## Production gates

No Production, Railway or Airtable change is included. Before Production release, the exact new multiple-select values must be approved and added to the Airtable `Order Items.Accessories` field, followed by conversion validation. Merge and deployment also require separate Owner approval.

The Quote image mappings depend on 3D Draft PR #24 (`a968e3d70e45b15a30039e56500a332e7a2c96cc`). They must not be described as Production-live until that 3D release is merged and deployed, followed by an end-to-end Quote image check against the deployed renderer.
