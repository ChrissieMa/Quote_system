# Private Google Drive quotation-image storage

This optional provider stores quotation PNGs as private files in one explicitly authorized human user's My Drive. It is development-ready but remains disabled by default and has not been connected to a real Google account.

## Authorization model

Use OAuth user authorization with the least-privilege `https://www.googleapis.com/auth/drive.file` scope. Google recommends `drive.file` for per-file access and documents refresh tokens as the mechanism for long-term access to private Drive data:

- <https://developers.google.com/workspace/drive/api/guides/api-specific-auth>
- <https://developers.google.com/workspace/drive/api/guides/about-shareddrives>

Do not substitute a service account for a personal Gmail My Drive. Google states that service accounts have no storage quota and cannot own files; they must use a shared drive or act on behalf of a human user. This integration intentionally supports a human OAuth refresh token instead.

The one-time owner authorization must grant `drive.file` and place these secrets directly in the Production environment, never in Git or chat:

- `GOOGLE_DRIVE_OAUTH_CLIENT_ID`
- `GOOGLE_DRIVE_OAUTH_CLIENT_SECRET`
- `GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN`
- `QUOTATION_IMAGE_PROXY_SIGNING_SECRET` (independent random value, at least 32 bytes)

It must also configure, as environment values rather than file metadata:

- `GOOGLE_DRIVE_EXPECTED_OWNER_EMAIL` — the exact OAuth account expected by the application
- `GOOGLE_DRIVE_QUOTATION_IMAGE_FOLDER_ID` — a dedicated, private folder owned by that account

Configuration also requires `QUOTATION_IMAGE_STORAGE_PROVIDER=google_drive`. `QUOTATION_IMAGE_ENABLED` remains `false` until the complete renderer, storage and approval gates are separately satisfied.

## Privacy and identity

Before any read or write, the adapter uses `about.get` to verify the OAuth account against the configured expected owner, then verifies that the configured folder is private, owner-only and writable. Uploads name that folder explicitly and use `ignoreDefaultVisibility=true`, so an account or domain default cannot make a new file broadly visible. Google documents these endpoints here:

- <https://developers.google.com/workspace/drive/api/reference/rest/v3/about/get>
- <https://developers.google.com/workspace/drive/api/reference/rest/v3/files/create>

The adapter creates a 1280 x 1280 `image/png` with a deterministic, non-business filename and two private `appProperties`: the contract name and a SHA-256 asset digest. It never sends customer details, Quote/public tokens, credentials, payment data or prices as Drive file metadata. It never calls the Drive permissions API and rejects a file unless its returned permissions contain only the configured user owner. Google documents authenticated private `appProperties` here:

- <https://developers.google.com/workspace/drive/api/guides/properties>

Quote Items JSON persists only the deterministic `quotation-images/<sha256>.png` asset key. It does not persist a Drive URL, access token, refresh token or public permission. Sequential and concurrent repeats share one upload in-process, while a folder-scoped Drive `appProperties` lookup reuses the same file across restarts. Uploads use a pregenerated Drive file ID, and temporary-response retries reuse that exact ID; an ambiguous retry therefore verifies the resulting file instead of creating another. More than one match for a digest is a terminal safety error and no file is deleted automatically.

- <https://developers.google.com/workspace/drive/api/reference/rest/v3/files/generateIds>

Customer Share and Invoice pages receive a short-lived, HMAC-signed, same-origin URL such as `/quotation-images/google-drive/<signed-token>`. The server verifies expiry and signature, retrieves the still-private file with OAuth, validates its PNG signature and exact 1280 x 1280 IHDR dimensions, and returns it with `private, no-store` and same-origin response headers. The signed token binds the deterministic asset key to the immutable Quote `item_id` and expiry; it does not expose the Drive file ID.

## Failure and operating boundary

Drive calls have bounded timeout and retry handling for temporary errors. Storage, lookup, token refresh or proxy failures remain fail-open: Quote creation, pricing, sharing and conversion continue without a broken image. Google Drive API use must remain within Google's usage and user-data policies and must not turn Drive into a general CDN:

- <https://developers.google.com/workspace/drive/api/guides/limits>
- <https://developers.google.com/workspace/workspace-api-user-data-developer-policy>

When `QUOTATION_IMAGE_ENABLED=false`, the application does not construct the Google Drive provider and does not register its proxy route. This provider does not choose or implement the Production 3D renderer transport. It must not be enabled until that separate adapter, credentials, CI and Production approval are complete.
