# Quote quotation-image local transport

This is a development-only bridge between the genuine Quote application routes and the 3D configurator's approved local browser transport. It does not select or configure a Production renderer, storage provider, origin, credential or deployment endpoint.

The bridge is unavailable unless all of these independent safeguards are active:

- `NODE_ENV=test`
- `LKS_LOCAL_QUOTE_FIXTURE=1`
- `PUBLIC_BASE_URL` is an HTTP loopback URL
- `QUOTATION_IMAGE_ENABLED=true`
- `LKS_LOCAL_3D_BROWSER_TRANSPORT=1`
- `LKS_LOCAL_3D_RENDERER_ORIGIN` is an exact HTTP loopback origin

For the current non-Production acceptance setup, the 3D renderer is `http://127.0.0.1:5175` and the Quote fixture server uses the renderer's explicitly allowlisted client origin `http://127.0.0.1:4319`.

Open `http://127.0.0.1:4319/__test-only/quotation-image-bridge.html` in a browser while creating a Quote. The client polls the Quote process for a sanitized `lks-quotation-image-local-v1` job, posts it only to the exact configured iframe origin, validates the exact response origin/source/envelope, and returns the 1280 × 1280 PNG bytes to the Quote process. The local storage adapter persists the deterministic asset key in memory; the same item identity resolves the same optional image on the genuine customer Share and Invoice routes.

The render request contains configuration only. It rejects PII, customer fields, Quote/public tokens, credentials, payment data and price fields, and requires `show_price:false`. Browser completion writes require the exact Quote loopback origin. A missing browser, renderer failure, timeout or invalid artifact fails open: Quote creation, conversion, pricing and legacy documents remain available without a broken image.

Do not expose these test-only routes, flags or adapters as a Production transport. Production remains provider-unconfigured and feature-off by default.
