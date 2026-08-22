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

Configuration also requires `QUOTATION_IMAGE_STORAGE_PROVIDER=google_drive`. `QUOTATION_IMAGE_ENABLED` remains `false` until the complete renderer, storage and approval gates are separately satisfied.

## Privacy and identity

The adapter creates an `image/png` with a deterministic, non-business filename and two private `appProperties`: the contract name and a SHA-256 asset digest. It never sends customer details, Quote/public tokens, credentials, payment data or prices as Drive file metadata. It never calls the Drive permissions API and rejects a file unless its returned permissions contain only a user owner. Google documents authenticated private `appProperties` here:

- <https://developers.google.com/workspace/drive/api/guides/properties>

Quote Items JSON persists only the deterministic `quotation-images/<sha256>.png` asset key. It does not persist a Drive URL, access token, refresh token or public permission. Sequential and concurrent repeats share one upload in-process, while a Drive `appProperties` lookup reuses the same file across restarts.

Customer Share and Invoice pages receive a short-lived, HMAC-signed, same-origin URL such as `/quotation-images/google-drive/<signed-token>`. The server verifies expiry and signature, retrieves the still-private file with OAuth, validates a bounded PNG, and returns it with `private, no-store` and same-origin response headers. The token contains only the deterministic asset key and expiry; it does not expose the Drive file ID.

## Failure and operating boundary

Drive calls have bounded timeout and retry handling for temporary errors. Storage, lookup, token refresh or proxy failures remain fail-open: Quote creation, pricing, sharing and conversion continue without a broken image. Google Drive API use must remain within Google's usage and user-data policies and must not turn Drive into a general CDN:

- <https://developers.google.com/workspace/drive/api/guides/limits>
- <https://developers.google.com/workspace/workspace-api-user-data-developer-policy>

This provider does not choose or implement the Production 3D renderer transport. It must not be enabled until that separate adapter, credentials, CI and Production approval are complete.
