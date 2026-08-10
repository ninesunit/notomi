# Notomi R2 broker

Holds the Cloudflare R2 signing key so the web app never has to. The app is a
static bundle — anything it carries is readable by every visitor — so this
Worker signs short-lived URLs on its behalf and enforces that a user can only
touch objects under `users/{their-uid}/`.

## Deploy

```bash
cd worker
npm install
npx wrangler login          # or: export CLOUDFLARE_API_TOKEN=…

# R2 API token: Cloudflare dashboard > R2 > Manage R2 API Tokens >
# Create API token, permission "Object Read & Write", scoped to notomi-materials.
npx wrangler secret put R2_ACCOUNT_ID          # 32-char hex from the R2 overview page
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY

npx wrangler deploy
```

`wrangler deploy` prints the Worker URL. Put it in the app's `.env`:

```
EXPO_PUBLIC_R2_WORKER_URL=https://notomi-r2.<your-subdomain>.workers.dev
```

Then rebuild and redeploy the app (`npm run deploy:hosting` from the repo root).

## Bucket CORS

Uploads go from the browser straight to R2 using the presigned URL, so R2 must
allow the app's origin. In the Cloudflare dashboard under
**R2 → notomi-materials → Settings → CORS policy**:

```json
[
  {
    "AllowedOrigins": [
      "https://notomii.web.app",
      "https://notomii.firebaseapp.com",
      "http://localhost:8081"
    ],
    "AllowedMethods": ["GET", "PUT"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["etag"],
    "MaxAgeSeconds": 3600
  }
]
```

Without this the browser blocks the PUT and the app reports "R2 refused the
browser request".

## Routes

| Route | Method | Purpose |
| --- | --- | --- |
| `/health` | GET | Liveness, no auth |
| `/presign-upload` | POST | `{ fileKey, contentType }` → `{ uploadUrl }` |
| `/presign-download` | GET | `?key=&expires=` → `{ downloadUrl }` |
| `/object` | DELETE | `?key=` removes an object |

All but `/health` require `Authorization: Bearer <firebase-id-token>`. The
Worker verifies the RS256 signature against Google's published keys and checks
issuer, audience and expiry before honouring anything.
