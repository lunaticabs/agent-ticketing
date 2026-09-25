#!/usr/bin/env bash
#
# ============================================================================
#  npm run dev:https — run the app over HTTPS with a local certificate
# ============================================================================
#
# ── Why this exists ────────────────────────────────────────────────────────
#
# The sandbox portal rejects an `http://` callback. Its registration form says
# so in as many words: "Use exact HTTPS callback URLs, one per line." The
# integration guide is ambiguous on the point — it says HTTPS is required for
# "production and sandbox" but that "local, test, and staging also accept
# registered HTTP loopback callbacks" — and the live portal settles it: plain
# http loopback is refused with "Check the values and try again."
#
# So the callback has to be HTTPS even for a laptop-only demo. This script makes
# that a single command instead of a research project.
#
# ── Why not `next dev --experimental-https` on its own ─────────────────────
#
# That flag downloads mkcert into ~/Library/Caches (or ~/.cache on Linux). It
# fails outright in any environment where that path is not writable, and it
# silently falls back to HTTP — which looks like it worked and then produces an
# `invalid_request` at the authorization endpoint much later. Generating the
# certificate ourselves removes both the dependency and the silent fallback.
#
# The certificate is a self-signed one for localhost, so the browser will show a
# warning the first time. That is expected: choose "Advanced" → "Proceed".
# Nothing about the OIDC flow depends on the certificate being trusted.
#
# The key is written to ./certificates, which is gitignored. Never commit it.
set -euo pipefail

PORT="${PORT:-3000}"
CERT_DIR="./certificates"
KEY="$CERT_DIR/localhost-key.pem"
CRT="$CERT_DIR/localhost.pem"

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl not found. Install it, or register an HTTPS tunnel instead:" >&2
  echo "  cloudflared tunnel --url http://localhost:$PORT" >&2
  exit 1
fi

if [[ ! -f "$KEY" || ! -f "$CRT" ]]; then
  echo "· generating a self-signed certificate for localhost"
  mkdir -p "$CERT_DIR"

  # A SAN is mandatory: modern browsers reject a certificate whose only
  # identity is the legacy CN field, with no way to click through.
  cat > "$CERT_DIR/openssl.cnf" <<'CNF'
[req]
distinguished_name = dn
x509_extensions = v3_req
prompt = no
[dn]
CN = localhost
[v3_req]
subjectAltName = @alt
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
[alt]
DNS.1 = localhost
IP.1 = 127.0.0.1
IP.2 = ::1
CNF

  openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes \
    -keyout "$KEY" -out "$CRT" -config "$CERT_DIR/openssl.cnf" 2>/dev/null

  echo "· wrote $CRT (valid 365 days, self-signed)"
else
  echo "· reusing the existing certificate in $CERT_DIR"
fi

# The app builds absolute URLs — consent links, transfer links, and the OIDC
# redirect_uri — from PRESENCE_PUBLIC_URL. Left at its http default they would
# all point at a scheme the server is no longer listening on.
export PRESENCE_PUBLIC_URL="${PRESENCE_PUBLIC_URL:-https://localhost:$PORT}"
export WORLDID_REDIRECT_URI="${WORLDID_REDIRECT_URI:-https://localhost:$PORT/api/auth/world/callback}"

echo
echo "  PRESENCE · https dev server"
echo "  ────────────────────────────────────────────────────────────────"
echo "  url            https://localhost:$PORT"
echo "  redirect URI   $WORLDID_REDIRECT_URI"
echo
echo "  Register that exact redirect URI at https://sandbox.auth.world.org/portal"
echo "  The browser will warn about the self-signed certificate once —"
echo "  choose Advanced → Proceed."
echo

# exec so Ctrl-C reaches Next directly rather than this wrapper.
exec npx next dev \
  --experimental-https \
  --experimental-https-key "$KEY" \
  --experimental-https-cert "$CRT" \
  -p "$PORT"
