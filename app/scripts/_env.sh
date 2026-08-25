# shellcheck shell=bash
# Shared connection setup. Sourced by the other scripts; never run directly.
set -euo pipefail

ENV_FILE="${ENV_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.env}"
if [ ! -f "$ENV_FILE" ]; then
  echo "error: $ENV_FILE not found. Copy .env.example and fill it in." >&2
  exit 1
fi
set -a; . "$ENV_FILE"; set +a

export PGHOST="$SUPABASE_DB_HOST"
export PGPORT="$SUPABASE_DB_PORT"
export PGUSER="$SUPABASE_DB_USER"
export PGDATABASE="$SUPABASE_DB_NAME"
export PGPASSWORD="$SUPABASE_DB_PASSWORD"
export PGSSLMODE=require
export PGCONNECT_TIMEOUT=15
