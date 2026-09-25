#!/usr/bin/env bash
#
# ============================================================================
#  npm run dev — start the app, over the scheme this configuration needs
# ============================================================================
#
#   npm run dev            pick automatically (see below)
#   npm run dev:http       force plain HTTP
#   npm run dev:https      force TLS with a local self-signed certificate
#
# ── Why the scheme is not simply "http" ────────────────────────────────────
#
# The sandbox portal rejects an `http://` callback: "Use exact HTTPS callback
# URLs, one per line", and an http loopback URL is refused with "Check the values
# and try again." So once an OIDC client is registered, the callback has to be
# HTTPS even for a laptop-only demo.
#
# That makes "run dev:https, not dev" a footgun — the kind of instruction that
# gets forgotten under time pressure, where the server comes up looking perfectly
# healthy and the browser is only later redirected to a scheme nothing is
# listening on. So `npm run dev` asks `scripts/dev-scheme.ts` which scheme this
# configuration requires and starts that one.
#
# ── Why not `next dev --experimental-https` on its own ─────────────────────
#
# That flag downloads mkcert into ~/Library/Caches (or ~/.cache on Linux). It
# fails outright where that path is not writable, and it SILENTLY FALLS BACK TO
# HTTP — so the server looks fine and the scheme mismatch only surfaces much
# later as an `invalid_request` at the authorization endpoint. Generating the
# certificate ourselves removes both the dependency and the silent fallback.
#
# The certificate is self-signed, so the browser warns once: choose
# "Advanced" → "Proceed". Nothing in the OIDC flow needs it to be trusted.
#
# The key is written to ./certificates, which is gitignored. Never commit it.
set -euo pipefail

PORT="${PORT:-3000}"
CERT_DIR="./certificates"
KEY="$CERT_DIR/localhost-key.pem"
CRT="$CERT_DIR/localhost.pem"

# ── Decide the scheme ───────────────────────────────────────────────────────
REQUESTED="${1:-auto}"
case "$REQUESTED" in
  auto)
    DECISION="$(npx tsx scripts/dev-scheme.ts)"
    SCHEME="$(printf '%s' "$DECISION" | sed -E 's/.*"scheme":"([a-z]+)".*/\1/')"
    ;;
  http|https)
    SCHEME="$REQUESTED"
    ;;
  *)
    echo "usage: dev.sh [auto|http|https]" >&2
    exit 2
    ;;
esac

if [[ "$SCHEME" == "http" ]]; then
  # No TLS anywhere in this configuration, so every absolute URL the app builds
  # must be http too. Leaving an https redirect URI set while serving http is the
  # exact mismatch this script exists to prevent.
  export PRESENCE_PUBLIC_URL="${PRESENCE_PUBLIC_URL:-http://localhost:$PORT}"
  unset WORLDID_REDIRECT_URI_HTTPS 2>/dev/null || true

  cat <<BANNER

  PRESENCE · http dev server
  ────────────────────────────────────────────────────────────────
  url            http://localhost:$PORT

  Identity is simulated locally (no OIDC client registered), so no callback is
  involved and TLS would only add a certificate warning. Register a client at
  https://sandbox.auth.world.org/portal and this command switches to https on
  its own.

BANNER

  exec npx next dev -p "$PORT"
fi

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

# Every absolute URL the app builds — consent links, transfer links, the OIDC
# redirect_uri — must share one origin. `PRESENCE_PUBLIC_URL` is only forced here
# when nothing has declared one; when WORLDID_REDIRECT_URI is set the app derives
# the origin from it instead, so a stale PRESENCE_PUBLIC_URL cannot desync them.
if [[ -z "${WORLDID_REDIRECT_URI:-}" ]]; then
  export WORLDID_REDIRECT_URI="https://localhost:$PORT/api/auth/world/callback"
fi

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

# ── Teach this process to trust the certificate we just made ───────────────
#
# Node does not trust a self-signed certificate, so any request the server makes
# to its OWN https URL fails with a bare `fetch failed`. That broke every demo
# prop driven by a self-call — the bot army, the 40-account collapse, and the MCP
# agent — while leaving everything that only serves responses looking healthy.
#
# NODE_EXTRA_CA_CERTS rather than NODE_TLS_REJECT_UNAUTHORIZED=0, deliberately:
# this adds OUR certificate to the trust store and leaves verification on for
# everything else, so a real problem at sandbox.auth.world.org still surfaces.
#
# Absolute path, because the variable is read relative to the working directory
# of whichever process opens it.
export NODE_EXTRA_CA_CERTS="$PWD/$CRT"

# exec so Ctrl-C reaches Next directly rather than this wrapper.
exec npx next dev \
  --experimental-https \
  --experimental-https-key "$KEY" \
  --experimental-https-cert "$CRT" \
  -p "$PORT"
