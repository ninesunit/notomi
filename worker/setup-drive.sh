#!/usr/bin/env bash
#
# Turns on the permanent Google Drive connection.
#
# Three things have to happen and all of them need your Cloudflare login, which
# is why this is a script you run rather than something the app can do: it
# creates the KV namespace that holds refresh tokens, stores the Google client
# secret as a Worker secret, and redeploys.
#
# The secret is read from a prompt and handed straight to wrangler on stdin. It
# is never written to a file, never passed as an argument (which would put it in
# your shell history and in `ps`), and never echoed back.
#
# Safe to run twice: an existing namespace is reused and the secret is
# overwritten with whatever you type.
#
#   cd worker && ./setup-drive.sh

set -euo pipefail
cd "$(dirname "$0")"

BOLD=$(tput bold 2>/dev/null || true)
DIM=$(tput dim 2>/dev/null || true)
RESET=$(tput sgr0 2>/dev/null || true)

step() { printf '\n%s==> %s%s\n' "$BOLD" "$1" "$RESET"; }
note() { printf '%s    %s%s\n' "$DIM" "$1" "$RESET"; }
die() { printf '\nerror: %s\n' "$1" >&2; exit 1; }

command -v npx >/dev/null || die "npx not found. Install Node.js first."

# ---------------------------------------------------------------------------
# 0. The name has to match the hostname the app calls
# ---------------------------------------------------------------------------

step "Checking the worker name"

# `|| true` on every one of these: under `set -e` a command substitution that
# fails takes the whole script with it, and grep "fails" whenever a file is
# absent or a pattern does not match — both of which are ordinary here. With
# `pipefail`, `head -1` closing the pipe early can do the same to grep.
worker_name=$(grep -oE '^name = "[^"]+"' wrangler.toml 2>/dev/null | head -1 | cut -d'"' -f2 || true)
app_url=$(grep -hoE '^EXPO_PUBLIC_R2_WORKER_URL=.*' ../.env.production ../.env 2>/dev/null | head -1 | cut -d= -f2- || true)

[ -n "$worker_name" ] || die "could not read the worker name from wrangler.toml"

if [ -n "$app_url" ]; then
  app_host=${app_url#https://}
  app_name=${app_host%%.*}

  if [ "$worker_name" != "$app_name" ]; then
    printf '\nwrangler.toml deploys a worker named "%s",\n' "$worker_name"
    printf 'but the app calls "%s" (%s).\n\n' "$app_name" "$app_url"
    printf 'Deploying now would publish to a second worker nothing talks to —\n'
    printf 'the namespace, the secret and the Drive routes would all land there.\n\n'
    printf 'Fix wrangler.toml to read:  name = "%s"\n' "$app_name"
    die "name mismatch; nothing was changed"
  fi
  note "\"$worker_name\" matches $app_url"
else
  note "could not read EXPO_PUBLIC_R2_WORKER_URL; skipping the name check"
fi

bindings=$(grep -cE '^[[:space:]]*binding[[:space:]]*=[[:space:]]*"DRIVE_TOKENS"' wrangler.toml || true)
if [ "${bindings:-0}" -gt 1 ]; then
  printf '\nwrangler.toml binds DRIVE_TOKENS %s times. Wrangler refuses that,\n' "$bindings"
  printf 'and this script cannot tell which one you meant to keep.\n\n'
  printf 'Delete the extra [[kv_namespaces]] block so exactly one remains, or\n'
  printf 'take the committed version:  git checkout -- wrangler.toml\n'
  die "duplicate DRIVE_TOKENS binding; nothing was changed"
fi
note "one DRIVE_TOKENS binding"

step "Checking your Cloudflare login"
if ! npx wrangler whoami >/dev/null 2>&1; then
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
    die "CLOUDFLARE_API_TOKEN is set but was refused. Check the token's permissions."
  fi

  # `wrangler login` redirects to http://localhost:8976, which only works when
  # the browser and wrangler are on the same machine. In a Codespace, a remote
  # container or over SSH they are not, so the approval lands on the wrong
  # localhost and the login hangs. A token avoids the round trip entirely and
  # survives the container being rebuilt.
  if [ -n "${CODESPACES:-}${SSH_CONNECTION:-}${REMOTE_CONTAINERS:-}" ] || ! command -v xdg-open >/dev/null; then
    cat <<'TOKEN'

Not logged in, and this looks like a remote environment where the browser
login cannot complete — its callback goes to localhost on the machine
running the browser, not this one.

Use an API token instead:

  1. https://dash.cloudflare.com/profile/api-tokens
  2. Create Token > "Edit Cloudflare Workers" template > Continue > Create
  3. export CLOUDFLARE_API_TOKEN=<the token>
  4. re-run this script

The token needs Workers Scripts:Edit, Workers KV Storage:Edit and
Account Settings:Read, all of which that template includes.

TOKEN
    die "no Cloudflare credentials"
  fi

  note "Not logged in. A browser window will open."
  npx wrangler login
fi
npx wrangler whoami | sed -n '/Account Name/,+1p' || true

# ---------------------------------------------------------------------------
# 1. Somewhere to keep the refresh tokens
# ---------------------------------------------------------------------------

step "Creating the DRIVE_TOKENS namespace"


# Tolerant of leading whitespace and of the binding sitting in any block: an
# anchored match missed an indented one, decided there was no namespace, and
# appended a second — which wrangler refuses outright, because two bindings
# cannot share a name.
if grep -qE '^[[:space:]]*binding[[:space:]]*=[[:space:]]*"DRIVE_TOKENS"' wrangler.toml; then
  note "wrangler.toml already binds DRIVE_TOKENS — leaving it alone."
else
  # Look before creating. A previous run may have made the namespace and then
  # had its config edit lost — to a failed pull, a clean clone, a discarded
  # branch — and `create` would fail on the duplicate title, leaving the script
  # stuck on a namespace that already exists.
  existing=$(npx wrangler kv namespace list 2>/dev/null || true)
  kv_id=$(printf '%s' "$existing" | python3 -c '
import json, sys
try:
    entries = json.loads(sys.stdin.read() or "[]")
except Exception:
    entries = []
for entry in entries:
    if "DRIVE_TOKENS" in entry.get("title", ""):
        print(entry["id"])
        break
' 2>/dev/null || true)

  if [ -n "$kv_id" ]; then
    note "reusing the DRIVE_TOKENS namespace that already exists"
  else
    # wrangler prints the binding block on success; the id is what we need out
    # of it. Captured rather than shown, because the raw output also suggests a
    # config edit that this script is about to make itself.
    created=$(npx wrangler kv namespace create DRIVE_TOKENS 2>&1) || {
      printf '%s\n' "$created" >&2
      die "could not create the namespace (see above)"
    }

    kv_id=$(printf '%s' "$created" | grep -oE '"[0-9a-f]{32}"' | head -1 | tr -d '"' || true)
  fi

  [ -n "$kv_id" ] || {
    printf '%s\n' "${created:-$existing}" >&2
    die "could not determine the namespace id from the output above"
  }

  note "id: $kv_id"

  # Replace the commented placeholder block rather than appending, so running
  # this twice cannot leave two of them.
  python3 - "$kv_id" <<'PY'
import re, sys

kv_id = sys.argv[1]
path = 'wrangler.toml'
config = open(path).read()

block = f'[[kv_namespaces]]\nbinding = "DRIVE_TOKENS"\nid = "{kv_id}"\n'
commented = re.compile(
    r'# \[\[kv_namespaces\]\]\n# binding = "DRIVE_TOKENS"\n# id = "<paste the id wrangler prints>"\n'
)

if commented.search(config):
    config = commented.sub(block, config)
else:
    config = config.rstrip() + '\n\n' + block

open(path, 'w').write(config)
print('    wrangler.toml updated')
PY
fi

# ---------------------------------------------------------------------------
# 2. Ship it, so the worker exists
# ---------------------------------------------------------------------------

step "Deploying \"$worker_name\""
npx wrangler deploy

# ---------------------------------------------------------------------------
# 3. The client secret, onto a worker that is now certainly there
# ---------------------------------------------------------------------------

step "Storing the Google client secret on \"$worker_name\""
note "Deployed first on purpose: setting a secret on a worker that does not"
note "exist yet makes wrangler create a placeholder to hold it, which the"
note "next deploy then replaces — taking the secret with it."
note "Google Cloud console > APIs & Services > Credentials > your Web"
note "application OAuth client > Client secret."
note ""
note "Nothing is echoed as you type or paste."

# -s so it is not shown, -r so a backslash is not treated as an escape.
printf '    Client secret: '
read -rs client_secret
printf '\n'

[ -n "$client_secret" ] || die "no secret entered; nothing was changed"
case "$client_secret" in
  GOCSPX-*) ;;
  *) note "warning: Google web client secrets normally start with GOCSPX-" ;;
esac

# Piped on stdin, so it never becomes a command-line argument.
printf '%s' "$client_secret" | npx wrangler secret put GOOGLE_CLIENT_SECRET
unset client_secret

# Secrets belong to one worker and do not follow a rename, so confirm it landed
# on the one the app calls rather than trusting the upload message.
if ! npx wrangler secret list 2>/dev/null | grep -q GOOGLE_CLIENT_SECRET; then
  die "the secret did not appear on \"$worker_name\" — check the output above"
fi
note "confirmed on \"$worker_name\""

worker_url=$(grep -hoE '^EXPO_PUBLIC_R2_WORKER_URL=.*' ../.env.production ../.env 2>/dev/null | head -1 | cut -d= -f2- || true)

step "Checking it came up"
if [ -n "$worker_url" ]; then
  # A deploy takes a moment to propagate, so one immediate request proves
  # nothing. Curl also may not share the proxy settings the rest of the
  # toolchain uses, which is why a failure here is reported as inconclusive
  # rather than as a problem: the deploy output above is the real evidence.
  reached=""
  for attempt in 1 2 3 4 5; do
    if curl -fsS --max-time 10 "$worker_url/health" >/dev/null 2>&1; then
      reached="yes"
      break
    fi
    sleep "$attempt"
  done

  if [ -n "$reached" ]; then
    note "$worker_url/health is answering"
  else
    note "could not reach $worker_url/health from here."
    note "That is often just this shell's network, not the deploy — the"
    note "bindings listed above are what actually matter. Confirm with:"
    note "  node check-drive.mjs"
  fi
fi

cat <<'DONE'

Done.

Confirm it with:

    node check-drive.mjs

"the worker can hold a Drive grant" is the line that matters; 404 there means
configured with no grant yet, which is exactly right for a fresh account.

Then open Notomi, go to the Drive card and press
Connect — you will see Google's consent screen once. After that the card should
read "stays connected next time", and reloading should not ask again.

If it still says "Connected for this session", the Worker could not hold the
grant. Check `npx wrangler tail` while you press Connect: a 501 means the secret
or the namespace did not stick, and re-running this script is safe.

One last thing: rotate the secret you just used if it has been pasted anywhere
it should not live — a chat window, a ticket, a commit. Google Cloud console >
Credentials > your client > "Add secret", then re-run this script with the new
one and delete the old.
DONE
