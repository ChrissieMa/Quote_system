# LKS Quote System - Phase 2B deployment

## Included

- Owner-only `/admin/costs` page showing only orders in the selected month with incomplete finance data.
- Supports supplier cost, manual China freight, and optional reissue cost; local delivery remains sourced from Deliveries.
- Saves the writable actual-cost fields and refreshes the affected finance month.
- Automatic recurring monthly expense creation from `Expense Checklist`.
- Automatic `Monthly Finance` refresh on startup and every six hours.
- Pending/refunded/cancelled marketing payments are excluded from finance totals.
- Finance month and owner display use `Internal 1 Order No` (for example JUL2601), with the legacy ORD number only as fallback.
- Create Quote now requires each Item's total estimated Hong Kong delivery weight.
- The whole quotation's local delivery fee is calculated once: first 5 kg HK$100, then HK$10 per additional kg, with no LKS markup.
- Multi-item quotations store the calculated fee on the first Item only to prevent Airtable rollups from double-counting; every Item keeps its own estimated weight.
- The customer Quote states that the weight-based local delivery fee is included in the quotation.

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
2. Enter one or more missing supplier, China freight, or reissue costs and save.
3. Confirm completed cost fields switch from inputs to values; the order disappears only when all required finance data is complete.
4. Confirm the actual-cost fields, `Actual Profit HKD`, and matching `Monthly Finance` record update in Airtable.
5. Create a test Quote with Item weights of 4 kg and 2.5 kg; confirm the total weight is 6.5 kg and the included local delivery fee is HK$115.
6. Convert the test Quote and confirm each Order Item has its own `Estimated HK Delivery Weight KG`, while `Quoted Local Delivery HKD` is recorded once only.
