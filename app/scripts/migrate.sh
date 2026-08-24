#!/usr/bin/env bash
# Apply supabase/migrations/*.sql in filename order, once each.
# Each migration and its ledger row commit together, so a failure leaves neither
# a partial schema nor a row claiming it succeeded.
. "$(dirname "$0")/_env.sh"

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
