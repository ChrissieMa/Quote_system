# LKS Quote System - Phase 2B deployment

## Included

- Owner-only `/admin/costs` page showing only orders in the selected month with incomplete finance data.
- Supports supplier cost, manual China freight, and optional reissue cost; local delivery remains sourced from Deliveries.
- Supplier cost is entered separately for every linked Order Item (for example `JUL2605-A` and `JUL2605-B`). Each value is the actual total charged by 小糖 for that whole Order Item; when all Item costs are present, the system adds them together and writes the combined total to `Order_2026 → Actual Supplier Cost HKD` automatically. QTY is not multiplied again.
- Orders without linked Order Items retain the legacy single supplier-cost input as a safe fallback.
- Saves the writable actual-cost fields and refreshes the affected finance month.
- Automatic recurring monthly expense creation from `Expense Checklist`.
- Automatic `Monthly Finance` refresh on startup and every six hours.
- Pending/refunded/cancelled marketing payments are excluded from finance totals.
- Finance month and owner display use `Internal 1 Order No` (for example JUL2601), with the legacy ORD number only as fallback.
- Create Quote accepts one manually estimated Hong Kong local delivery total for each Item; weight is not required at quotation stage.
- The entered delivery estimate remains included in the quotation calculation, but the customer Quote only shows the existing approximate fee range and never exposes the exact internal amount.
- Actual Item weights and the driver fee rule are handled later in Delivery System, after the goods are ready.

## Required Railway variables

- `ADMIN_PASSWORD`: choose a strong private password. The owner page and finance sync stay disabled when this is missing.
- `ADMIN_USERNAME`: optional; defaults to `lks`.

The existing Airtable variables remain unchanged. The following table variables are optional because the code uses the current table names by default:

- `AIRTABLE_TABLE_BUSINESS_EXPENSES`
- `AIRTABLE_TABLE_EXPENSE_CHECKLIST`
- `AIRTABLE_TABLE_MONTHLY_FINANCE`
- `AIRTABLE_TABLE_MARKETING_SPEND`

## Owner page

Open `https://<quote-system-domain>/admin/costs` and sign in using the Railway `ADMIN_USERNAME` and `ADMIN_PASSWORD` values.

## Verification

1. Confirm July shows JUL2601-JUL2604 and the missing-data status for each order.
2. Confirm a multi-Item order shows one supplier-cost input per Item, then enter one or more missing supplier, China freight, or reissue costs and save.
3. Confirm a partially completed multi-Item order stays on the page, retaining the Item cost already entered.
4. After all Item costs are entered, confirm `Actual Supplier Cost HKD` equals the combined Item total and the completed cost switches from inputs to a value; the order disappears only when all required finance data is complete.
5. Confirm the actual-cost fields, `Actual Profit HKD`, and matching `Monthly Finance` record update in Airtable.
6. Create a test Quote with one manual local delivery estimate and confirm it is included in the total.
7. Confirm the customer Quote shows only the approximate range, for example `預計運費約 HK$300–$400`, and does not show the exact internal amount.
