#!/usr/bin/env bash
#
# ============================================================================
#  Container start: prove the volume is usable, then serve.
# ============================================================================
#
# The database file itself is the app's business — `lib/db.ts` creates it and
# applies `db/schema.sql` on first connection, and `instrumentation.ts` seeds the
# demo event on a database that has never been set up. What this script adds is
# the one failure the app cannot report clearly on its own: a volume that is not
# mounted, or mounted read-only. That surfaces from deep inside a route handler
# as `SQLITE_CANTOPEN`, which names neither the volume nor the mount.
#
# `set -e` is deliberate. A container that serves traffic on an unusable database
# is worse than one that fails to start: the first is a demo that breaks in front
# of an audience, the second is a deploy that says so.
set -euo pipefail

# `PRESENCE_DB` is the legacy name (the project shipped as Presence). It still
# resolves, so a deployment whose secrets have not been rotated yet finds its
# database — the *path* must not change either, or the app starts against an
# empty file on the volume. See lib/env.ts.
DB="${HUMANGATE_DB:-${PRESENCE_DB:-/data/presence.db}}"
DATA_DIR="$(dirname "$DB")"

echo "[humangate] database: $DB"
mkdir -p "$DATA_DIR"
if [[ ! -w "$DATA_DIR" ]]; then
  echo "[humangate] FATAL: $DATA_DIR is not writable." >&2
  echo "[humangate]        On Fly: fly volumes create presence_data -r <region> -s 1" >&2
  echo "[humangate]        and check the [[mounts]] block in fly.toml." >&2
  exit 1
fi

echo "[humangate] starting next on ${HOSTNAME:-0.0.0.0}:${PORT:-3000}"
exec node ./node_modules/next/dist/bin/next start -H "${HOSTNAME:-0.0.0.0}" -p "${PORT:-3000}"
