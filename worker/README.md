# Notomi R2 broker

Uses a Cloudflare R2 binding so the web app never needs an R2 access key. The
Worker enforces that a user can only touch objects under
`users/{their-uid}/` and streams authenticated uploads and downloads.

## Deploy

```bash
cd worker
npm install
npx wrangler login          # or: export CLOUDFLARE_API_TOKEN=…

npx wrangler deploy
```

`wrangler deploy` prints the Worker URL. Put it in the app's `.env`:

```
EXPO_PUBLIC_R2_WORKER_URL=https://notomi.<your-subdomain>.workers.dev
```

Then rebuild and redeploy the app (`npm run deploy:hosting` from the repo root).

## Bucket CORS

Uploads go through the Worker, so the bucket itself does not need a browser
CORS policy. The Worker allows the production and local app origins declared
in `wrangler.toml`.

## Routes

| Route | Method | Purpose |
| --- | --- | --- |
| `/health` | GET | Liveness, no auth |
| `/object` | PUT | `?key=` uploads an object |
| `/object` | GET | `?key=` streams an object |
| `/object` | DELETE | `?key=` removes an object |

All but `/health` require `Authorization: Bearer <firebase-id-token>`. The
Worker verifies the RS256 signature against Google's published keys and checks
issuer, audience and expiry before honouring anything.
