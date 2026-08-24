#!/usr/bin/env bash
# Regenerate src/types/database.ts from the live dev schema.
# This is the one place a connection URL is unavoidable, so the password is
# percent-encoded here rather than passed raw.
. "$(dirname "$0")/_env.sh"

OUT="$(cd "$(dirname "$0")/.." && pwd)/src/types/database.ts"

ENC_PW="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$PGPASSWORD")"
DB_URL="postgresql://${PGUSER}:${ENC_PW}@${PGHOST}:${PGPORT}/${PGDATABASE}"

npx --yes supabase@latest gen types typescript --db-url "$DB_URL" > "$OUT"
echo "wrote $OUT ($(wc -l < "$OUT") lines)"
