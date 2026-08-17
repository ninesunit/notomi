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

step "Checking your Cloudflare login"
if ! npx wrangler whoami >/dev/null 2>&1; then
  note "Not logged in. A browser window will open."
  npx wrangler login
fi
npx wrangler whoami | sed -n '/Account Name/,+1p' || true

# ---------------------------------------------------------------------------
# 1. Somewhere to keep the refresh tokens
# ---------------------------------------------------------------------------

step "Creating the DRIVE_TOKENS namespace"

if grep -qE '^\[\[kv_namespaces\]\]' wrangler.toml; then
  note "wrangler.toml already declares a namespace — leaving it alone."
else
  # wrangler prints the binding block on success; the id is what we need out
  # of it. Captured rather than shown, because the raw output also suggests a
  # config edit that this script is about to make itself.
  created=$(npx wrangler kv namespace create DRIVE_TOKENS 2>&1) || {
    printf '%s\n' "$created" >&2
    die "could not create the namespace (see above)"
  }

  kv_id=$(printf '%s' "$created" | grep -oE '"[0-9a-f]{32}"' | head -1 | tr -d '"')
  [ -n "$kv_id" ] || {
    printf '%s\n' "$created" >&2
    die "created the namespace but could not read its id from the output above"
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
# 2. The client secret
# ---------------------------------------------------------------------------

step "Storing the Google client secret"
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

# ---------------------------------------------------------------------------
# 3. Ship it
# ---------------------------------------------------------------------------

step "Deploying the Worker"
npx wrangler deploy

worker_url=$(grep -oE 'EXPO_PUBLIC_R2_WORKER_URL=.*' ../.env.production 2>/dev/null | cut -d= -f2- || true)

step "Checking it came up"
if [ -n "$worker_url" ]; then
  if curl -fsS "$worker_url/health" >/dev/null 2>&1; then
    note "$worker_url/health is answering"
  else
    note "could not reach $worker_url/health — check the deploy output above"
  fi
fi

cat <<'DONE'

Done.

The /drive/* routes are live. Open Notomi, go to the Drive card and press
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
