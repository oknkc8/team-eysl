#!/usr/bin/env bash
# Apply supabase/migrations/*.sql in filename order, once each.
# Each migration and its ledger row commit together, so a failure leaves neither
# a partial schema nor a row claiming it succeeded.
#
# THE COMMENT THAT USED TO STAND HERE WAS WRONG, AND HOW IT GOT WRITTEN IS THE
# useful part. It claimed this script lacked `set -e` and therefore reported
# `done: 0 applied` and exited 0 when psql was missing. Neither half is true:
# `_env.sh:3` runs `set -euo pipefail` in this shell, sourced on the line below
# and before any psql call, so a missing psql has always aborted with 127.
#
# The measurement behind the claim was `./scripts/migrate.sh 2>&1 | tail -20`,
# and a pipeline's status is the LAST command's — tail's, which is 0. This file
# was being edited to record one trap while its author sat in another one that
# CLAUDE.md already describes. Verified afterwards by running the original from
# a path where its globs resolve: exit 127.
#
# So there is nothing to fix here about failure handling. What is kept is the
# check below, because 127 with `psql: command not found` sends a reader to
# their connection settings rather than to their PATH, and libpq is keg-only on
# this machine.
#
. "$(dirname "$0")/_env.sh"

command -v psql >/dev/null 2>&1 || {
  echo "psql not found on PATH." >&2
  # Derived, not hardcoded: /opt/homebrew is Apple Silicon only, and printing it
  # to a Linux or Intel-Mac reader hands them a command that also fails.
  if command -v brew >/dev/null 2>&1; then
    echo "  libpq is keg-only. Try: PATH=\"$(brew --prefix libpq)/bin:\$PATH\" $0" >&2
  else
    echo "  Install the PostgreSQL client (Debian/Ubuntu: postgresql-client)," >&2
    echo "  or add its bin directory to PATH." >&2
  fi
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
