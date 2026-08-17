# Notomi R2 broker

Uses a Cloudflare R2 binding so the web app never needs an R2 access key. The
Worker enforces that a user can only touch objects under
`users/{their-uid}/` and streams authenticated uploads and downloads.

## Deploy

```bash
cd worker
npm install
npx wrangler login          # see below if this is a Codespace or over SSH

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
| `/user-data` | DELETE | Removes every object the caller owns |
| `/drive/link` | POST | Trades an authorization code for a stored grant |
| `/drive/token` | POST | Mints a fresh Drive access token |
| `/drive/unlink` | POST | Revokes and forgets the stored grant |

All but `/health` require `Authorization: Bearer <firebase-id-token>`. The
Worker verifies the RS256 signature against Google's published keys and checks
issuer, audience and expiry before honouring anything.


## Keeping Google Drive connected

A browser OAuth flow returns an access token that dies after an hour and no
refresh token, which is why students had to reconnect Drive every time they
opened Notomi. Only a *confidential* client may hold a refresh token, and only
because its secret never reaches the browser — so the exchange happens on this
Worker, the refresh token is stored here, and the browser only ever receives the
short-lived access token it already knew how to use.

This is optional. Until both steps below are done the `/drive/*` routes answer
`501` and the app reconnects Drive by hand exactly as before — nothing breaks,
the connection simply does not persist.

### Signing in from a Codespace, a container or over SSH

`wrangler login` redirects to `http://localhost:8976`, which only resolves when
the browser and wrangler run on the same machine. Anywhere else the approval
lands on the wrong localhost and the login never completes.

Use a token instead — it also survives the container being rebuilt, which the
OAuth session does not:

1. https://dash.cloudflare.com/profile/api-tokens
2. **Create Token → "Edit Cloudflare Workers" template → Continue → Create**
3. `export CLOUDFLARE_API_TOKEN=<the token>`

Add it to your Codespace secrets to avoid repeating this after every rebuild.

### 1. A place to keep the tokens

```bash
cd worker
npx wrangler kv namespace create DRIVE_TOKENS
```

It prints an id. Uncomment the `[[kv_namespaces]]` block in `wrangler.toml` and
paste the id in.

Workers KV's free tier is 100,000 reads and 1,000 writes a day; a student
account uses roughly one read per session and one write per link, so this stays
inside the free tier.

### 2. The client secret

In the Google Cloud console for project `notomii`: **APIs & Services →
Credentials → OAuth 2.0 Client IDs**, open the Web application client already
used for sign-in, and copy its **client secret**. Then:

```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

Paste it when prompted. Deliberately a secret and not a `[vars]` entry: `[vars]`
is readable from the dashboard and belongs in the repo, and this must be
neither. It never appears in the app bundle.

While you are in that console screen, check **Authorized JavaScript origins**
includes `https://notomii.web.app` — the same list that fixed the earlier
`origin_mismatch`. The popup code flow uses `postmessage` rather than a
redirect, so no redirect URI needs adding.

Then redeploy:

```bash
npx wrangler deploy
```

### Checking it worked

```bash
node check-drive.mjs
```

Signs up a throwaway account, calls the routes as that account, and deletes it
again. No Google consent, no client secret, nothing written to Drive.

`404` from `/drive/token` is the answer you want: the Worker is configured and
this brand-new account simply has no grant yet. `501` means the client secret or
the KV binding did not stick — re-running `./setup-drive.sh` is safe.

It stops early if `/health` does not answer, because that route takes no
authentication: a failure there is the network in the way rather than anything
about the configuration, and every check after it would be measuring the wrong
thing.

### What a student sees

Connecting Drive shows the Google consent dialog once. After that the card
reads "stays connected next time", and reloading, closing the tab, or signing in
on another device reconnects without a prompt — the grant belongs to the
account, not to the browser.

"Disconnect" now revokes the grant with Google and deletes it here, so it means
access is withdrawn everywhere rather than forgotten on one device. The card
says so.

### What it does not change

The scope is still `drive.file` and nothing else: Notomi can see the files it
created and the ones a student hands it through the picker, and no more. The
Worker refuses a grant that came back wider than that.
