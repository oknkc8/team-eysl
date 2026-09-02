#!/usr/bin/env bash
# Apply supabase/migrations/*.sql in filename order, once each.
# Each migration and its ledger row commit together, so a failure leaves neither
# a partial schema nor a row claiming it succeeded.
#
# `set -e` is load-bearing and was missing. Without it, a psql that cannot start
# fails silently on every iteration and the loop still reaches the last line, so
# the script printed `done: 0 applied` and EXITED 0 while applying nothing.
# Measured 2026-09-03: libpq is keg-only on this machine, so `psql` was not on
# PATH, and running this reported success without touching the database.
#
# That is the same shape as the pg_cron note in CLAUDE.md — a green line meaning
# "there was no work" rather than "the work succeeded" — except here the work
# existed and was skipped.
#
# Not `set -u`: _env.sh may leave optional variables unset by design, and turning
# those into fatal errors is a different change from making failures fail.
#
# Run it as: PATH="/opt/homebrew/opt/libpq/bin:$PATH" ./scripts/migrate.sh
set -eo pipefail
. "$(dirname "$0")/_env.sh"

command -v psql >/dev/null 2>&1 || {
  echo "psql not found on PATH." >&2
  echo "  libpq is keg-only here; try: PATH=\"/opt/homebrew/opt/libpq/bin:\$PATH\" $0" >&2
  exit 1
}

MIG_DIR="$(cd "$(dirname "$0")/../supabase/migrations" && pwd)"

psql -v ON_ERROR_STOP=1 -q -c "
  create table if not exists public.schema_migrations (
    version    text primary key,
    applied_at timestamptz not null default now()
  );"

applied=0
for f in "$MIG_DIR"/*.sql; do
  [ -e "$f" ] || { echo "no migrations found"; break; }
  version="$(basename "$f" .sql)"
  exists="$(psql -tAX -c "select 1 from public.schema_migrations where version = '$version'")"
  if [ "$exists" = "1" ]; then
    echo "skip  $version"
    continue
  fi
  echo "apply $version"
  psql -v ON_ERROR_STOP=1 --single-transaction \
       -c "\\i $f" \
       -c "insert into public.schema_migrations(version) values ('$version')"
  applied=$((applied+1))
done
echo "done: $applied applied"
