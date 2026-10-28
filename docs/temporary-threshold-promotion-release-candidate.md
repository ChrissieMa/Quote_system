# Short-term threshold promotion release candidate

Status: `release_candidate`

## Scope

- Adds a separate manual promotion choice: `短期滿額優惠`.
- Keeps the existing first-order and returning-customer promotions unchanged.
- Does not change the quote's delivery-charge mode.
- Recalculates the discount from the authoritative original subtotal:
  - HKD 700–999.99: HKD 100 discount
  - HKD 1,000–1,999.99: HKD 200 discount
  - HKD 2,000 or above: HKD 300 discount
- Below HKD 700: no discount.

## Safety and compatibility

- Browser-supplied discount amounts cannot override this preset.
- Existing first-order promotion pricing remains HKD 300 for boxes and HKD 500 when the quote contains a Display Case.
- Existing Quote, Invoice, Receipt, customer, finance and quotation-image regressions remain covered by the full test suite.

## Production gates

This release candidate is not Production live. Before deployment it still requires:

1. explicit approval to add `短期滿額優惠` to the existing `Promotion / Offer Type` choices in the Quotes and Order_2026 Airtable fields (choice only; no record updates), and
2. explicit approval to merge and deploy this release candidate to Production.

No end date is encoded. Removal or expiry must be handled as a later, separately approved change.
