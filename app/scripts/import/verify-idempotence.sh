#!/usr/bin/env bash
# Does re-running the import leave the database alone?
#
#   bash scripts/import/verify-idempotence.sh <workbook.xlsx>
#
# WHY THIS EXISTS RATHER THAN A UNIT TEST.
#
# toSql.test.ts can only assert that the generated SQL string is deterministic,
# and it did. That passed while the import was rewriting real_name, activity
# title/date/details and attendance status on every run and bumping updated_at
# on every row it touched — because a deterministic script applied twice still
# performs two writes.
#
# Counting rows misses it for the same reason: an upsert that overwrites keeps
# the count identical. The count was stable, the claim "idempotent" was made,
# and the expensive half of it was never checked. This script checks the
# expensive half.
#
# WHAT IT COMPARES.
#
# One md5 over every club-owned row, INCLUDING updated_at. A fingerprint rather
# than a dump, so nothing here can print a member's name — the output is two
# hashes and a verdict.
#
# WHAT IT PROTECTS.
#
# Not just re-import cost. real_name and attendance status are both editable in
# the app, so a re-import that overwrites them silently reverts a member's or an
# admin's work. This is a one-time backfill of a paper register, not a sync:
# once a row exists, the app is the newer source.
. "$(dirname "$0")/../_env.sh"

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

WORKBOOK="${1:-}"
if [ -z "$WORKBOOK" ] || [ ! -f "$WORKBOOK" ]; then
  echo "usage: bash scripts/import/verify-idempotence.sh <workbook.xlsx>" >&2
  exit 2
fi

# Every column the import writes, plus updated_at. If a rerun touches any of
# them, this hash moves.
FINGERPRINT_SQL="
select coalesce(md5(string_agg(x, '|' order by x)), 'empty') from (
  select m.id::text || m.nickname || coalesce(m.real_name,'') || coalesce(m.short_name,'')
       || coalesce(m.gender,'') || coalesce(m.notes,'') || m.status || m.role
       || m.updated_at::text as x
    from public.members m
   where m.nickname not like 'pwtest%'
  union all
  select a.id::text || a.kind || a.title || a.activity_date::text || a.details::text
       || a.updated_at::text
    from public.activities a
   where a.details->>'source' = 'club-workbook'
  union all
  select t.id::text || t.status || t.marked_by::text || t.updated_at::text
    from public.attendance t
    join public.activities ac on ac.id = t.activity_id
   where ac.details->>'source' = 'club-workbook'
  union all
  select r.id::text || r.category || r.subcategory || r.stroke || r.event_name
       || r.result_display || r.metadata::text || r.updated_at::text
    from public.records r
   where r.metadata->>'source' = 'club-workbook'
) s;"

fingerprint() { psql -tAX -c "$FINGERPRINT_SQL"; }

echo "== run 1 =="
bash "$SCRIPT_DIR/import-club-workbook.sh" "$WORKBOOK" >/dev/null 2>&1
BEFORE="$(fingerprint)"
echo "fingerprint after run 1: $BEFORE"

# A second apart, so a bumped updated_at is guaranteed to differ rather than
# landing inside one clock tick and reading as unchanged.
sleep 1

echo "== run 2 =="
bash "$SCRIPT_DIR/import-club-workbook.sh" "$WORKBOOK" >/dev/null 2>&1
AFTER="$(fingerprint)"
echo "fingerprint after run 2: $AFTER"

echo
if [ "$BEFORE" = "$AFTER" ]; then
  echo "PASS: re-running the import changed nothing."
  exit 0
fi
echo "FAIL: the second run modified club rows."
echo "      The import is rewriting data that already exists, which also means"
echo "      it reverts edits made in the app. Use ON CONFLICT DO NOTHING."
exit 1
