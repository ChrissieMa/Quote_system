# Expense receipt workflow

## Current owner flow

1. The owner uploads one PDF or image from the Owner Dashboard.
2. After the owner selects the local `稅務單據` directory once, the browser stores the directory handle in local IndexedDB.
3. Every later upload copies the original file to `稅務單據/00 待整理（所有單據先放這裡）` before sending it to Airtable.
4. The browser verifies the local file with SHA-256 and writes a readable row to `稅務單據/_系統記錄/單據自動同步記錄.csv`.
5. The server writes the attachment to Airtable `Business Expenses`, with `Pending Review` and `Amount HKD = 0` until it is reconciled.
6. The same SHA-256 is never uploaded or saved locally twice. A same-name file with different bytes receives a short SHA suffix.

## Fixed boundaries

- This local folder copy runs in the owner's browser and does not consume Codex usage.
- Browser security requires the owner to choose the `稅務單據` directory once. Removing the site permission requires one reconnection.
- No customer payment evidence is required or created. Creating a Receipt still means full payment.
- The upload does not guess the accounting amount or category. Those remain `Pending Review` and zero until reconciled.
- The workflow does not delete Airtable attachments or local files.

## Recovery

- Airtable remains the durable attachment source.
- The local CSV log records time, month, filename, SHA-256, local result, and upload request ID without customer data.
- If the local save fails, the form does not submit. Reconnect the folder and submit the same file again; SHA-256 deduplication prevents duplication.
