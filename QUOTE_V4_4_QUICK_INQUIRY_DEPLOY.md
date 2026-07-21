# LKS Quote System v4.4 — Quick Inquiry

## What changes

- Quote Dashboard adds `+ 新增查詢`.
- `/inquiry/create` is a mobile-friendly form for a WhatsApp inquiry that does not yet need a Quote.
- Minimum entry is phone number plus source; name, product interest, campaign and notes are optional.
- Phone formats such as `6898 3722`, `68983722` and `+852 6898 3722` are normalized and treated as the same Hong Kong phone number.
- The live phone check and final server-side check both search Inquiries, Quotes, Customers and confirmed Orders.
- An existing Inquiry, Quote or Order blocks a duplicate by default. A genuinely different product inquiry can still be saved after explicit confirmation.
- An existing Customer is linked automatically through the new `Inquiries → Customer` linked-record field.
- New inquiries are saved as `New` and linked to the current `Monthly Performance` month automatically.
- After saving, `用此查詢建立 Quote` opens Create Quote with the Inquiry already selected and fills the saved phone, name, source, campaign and month.
- Existing Create Quote Inquiry updates now use the correct Airtable field name `Monthly Performance`.
- Existing v4.2 Item-level supplier cost entry and v4.3 confirmed Order Item live sync remain included.
- New Order Items store Quote Description only in `Description`; Item Type and For What remain in their separate fields.

## Threads source

The existing Airtable `Inquiries → Channel` single select does not currently contain `Threads Organic`. The form still offers it. It stores `Channel = Other` and `Campaign / Source Detail = Threads Organic`, so the attribution is retained without requiring Railway schema-write permission.

## Airtable changes already completed

- `Order Items → Internal Size` formula combines `Inter L`, `Inter D` and `Inter H` as `L*D*H` for one-cell copying to the shared Tencent document.
- `Inquiries → Customer` links a recognized existing Customer automatically.

## Verification after Railway deployment

1. Open Quote Dashboard and press `+ 新增查詢`.
2. Enter a phone with no history and confirm the green no-match message appears.
3. Save phone plus source and confirm the Inquiry is `New` and linked to the current Monthly Performance record.
4. Press `用此查詢建立 Quote` and confirm the Inquiry, phone and source are prefilled.
5. Enter a phone that already has a Quote and confirm the system displays the existing record and does not create a duplicate.
6. Only for a genuinely different product inquiry, tick the confirmation box and save a separate Inquiry.
