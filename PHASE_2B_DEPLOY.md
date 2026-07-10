# LKS Quote System - Phase 2B deployment

## Included

- Owner-only `/admin/costs` page showing only orders with no supplier cost.
- Saves `Actual Supplier Cost HKD` and refreshes the affected finance month.
- Automatic recurring monthly expense creation from `Expense Checklist`.
- Automatic `Monthly Finance` refresh on startup and every six hours.
- Pending/refunded/cancelled marketing payments are excluded from finance totals.

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

1. Confirm only orders without supplier costs are listed (currently JUL2601-JUL2604).
2. Enter one supplier cost and save.
3. Confirm the completed order disappears from the page.
4. Confirm `Actual Supplier Cost HKD`, `Actual Profit HKD`, and the matching `Monthly Finance` record update in Airtable.
