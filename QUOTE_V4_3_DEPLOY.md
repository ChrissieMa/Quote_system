# LKS Quote System v4.3 — confirmed Order Item live sync

## What changes

- A Quote that has not been converted continues to display its original `Quotes → Quote Items JSON` data.
- After conversion, the existing public Quote link and Invoice link display the latest confirmed product specifications from Airtable `Order Items`.
- Live fields include Item Type, For What, internal dimensions, outer dimensions, number of levels, level heights, accessories, description and QTY.
- Confirmed prices are not recalculated when product specifications change.
- The converted Quote uses the confirmed `Order_2026` subtotal, discount and final amount; the Invoice continues to use the same `Order_2026` financial values.
- If a converted Quote is missing its direct `Order Ref`, the system finds the Order through `Source Quote Ref`, so older converted Quotes remain supported.
- If no linked Order Items can be found, the original Quote Items JSON remains as a safe fallback.

## Daily workflow

1. Open the relevant record in Airtable `Order Items`.
2. Change the confirmed dimensions, levels, accessories, description or QTY.
3. Reopen or refresh the customer's original Quote or Invoice link.
4. The corrected product details appear immediately. There is no need to create another Quote or convert another Invoice.

## Important price rule

Changing an Order Item never triggers automatic repricing. If the agreed amount also needs to change, update the confirmed Order financial values separately before sharing the document again.

## Verification after Railway deploy

1. Choose one converted test Order and note its current Quote and Invoice total.
2. Change one internal dimension in its Airtable Order Item.
3. Refresh both the existing Quote and Invoice links and confirm the new dimension appears.
4. Confirm Quote number, Invoice number, payment status and total are unchanged.
5. Restore the test dimension if it was only a temporary verification change.
