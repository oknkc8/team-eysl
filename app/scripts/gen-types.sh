#!/usr/bin/env bash
# Regenerate src/types/database.ts from the live dev schema.
# This is the one place a connection URL is unavoidable, so the password is
# percent-encoded here rather than passed raw.
. "$(dirname "$0")/_env.sh"

OUT="$(cd "$(dirname "$0")/.." && pwd)/src/types/database.ts"

ENC_PW="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$PGPASSWORD")"
DB_URL="postgresql://${PGUSER}:${ENC_PW}@${PGHOST}:${PGPORT}/${PGDATABASE}"

# Write to a temporary file and move it into place only after the generator has
# both succeeded and produced something plausible.
#
# The previous form was `... > "$OUT"`, and the shell truncates $OUT when it sets
# the redirect up — BEFORE the command runs. So any failure destroyed the file it
# was meant to replace, and this script has no `set -e`, so the echo below still
# ran and the exit code was still 0. Measured 2026-09-03: with the Docker daemon
# down, `npm run db:types` cut database.ts from 1874 lines to 1 and reported
# success. `supabase gen types --db-url` runs postgres-meta in a container, so a
# machine without Docker running hits this every time.
#
# Recovering it needed a backup somebody had thought to take. Now it needs
# nothing: on failure the old file is untouched and the exit code says so.
set -o pipefail
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

if ! npx --yes supabase@latest gen types typescript --db-url "$DB_URL" > "$TMP"; then
  echo "gen types failed; $OUT left unchanged" >&2
  echo "  (needs a running Docker daemon — supabase gen types runs postgres-meta in a container)" >&2
  exit 1
fi

# A successful run is thousands of lines. Anything under 50 is a truncated or
# empty response that happened to exit 0, and overwriting a good file with it
# would be the same loss by a slower route.
LINES="$(wc -l < "$TMP" | tr -d ' ')"
if [ "$LINES" -lt 50 ]; then
  echo "gen types returned only $LINES lines; refusing to overwrite $OUT" >&2
  head -5 "$TMP" >&2
  exit 1
fi

mv "$TMP" "$OUT"
trap - EXIT
echo "wrote $OUT ($LINES lines)"
