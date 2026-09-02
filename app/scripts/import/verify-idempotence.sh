#!/usr/bin/env bash
# Does re-running the import leave the database alone?
#
#   bash scripts/import/verify-idempotence.sh                    the sheet in .env
#   bash scripts/import/verify-idempotence.sh <workbook.xlsx>    a local file
#   bash scripts/import/verify-idempotence.sh <url>              an explicit URL
#
# The no-argument form is the one that matters now that the import can run on a
# schedule: it exercises the same source the scheduled run uses. A file argument
# proves nothing about the URL path, which is a different fetch and a different
# set of bytes.
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

# Empty means "whatever import-club-workbook.sh resolves", which with no
# argument is the published sheet named by EYSL_WORKBOOK_SHEET_ID in .env.
WORKBOOK="${1:-}"
case "$WORKBOOK" in
  ''|http://*|https://*) ;;
  *)
    if [ ! -f "$WORKBOOK" ]; then
      echo "usage: bash scripts/import/verify-idempotence.sh [<workbook.xlsx>|<url>]" >&2
      exit 2
    fi ;;
esac

# Same reason as the wrapper's: an empty positional must not become an empty
# path argument under `set -u`.
run_once() {
  if [ -n "$WORKBOOK" ]; then
    bash "$SCRIPT_DIR/import-club-workbook.sh" "$WORKBOOK" >/dev/null 2>&1
  else
    bash "$SCRIPT_DIR/import-club-workbook.sh" >/dev/null 2>&1
  fi
}

# Every column the import writes, plus updated_at. If a rerun touches any of
# them, this hash moves.
#
# THAT SENTENCE WAS FALSE UNTIL 2026-09-03 AND THE OMISSION WAS THE DANGEROUS
# HALF. The list below used to carry nine of the members columns and eight of
# the records ones, against fifteen and eleven the importer actually writes.
# Missing from members: birth_year, birth_date_text, join_date_text,
# join_reason, lesson_level, swim_experience and both legacy counters. Missing
# from records: member_id, distance_m, event_date, created_by — and
# result_centiseconds, which is the swim time itself.
#
# So a rerun that changed a recorded time moved no hash and this script printed
# PASS. A fingerprint exists precisely to catch the write that leaves row counts
# alone, and it was blind to the column that matters most in the table where it
# matters most.
#
# The check that finds nothing has to be able to find something, and the way to
# keep this one honest is mechanical: the column list here must be the union of
# every insert column list in toSql.ts. When you add a column there, add it
# here, or this file goes back to agreeing with whatever you did.
FINGERPRINT_SQL="
select coalesce(md5(string_agg(x, '|' order by x)), 'empty') from (
  select m.id::text || m.nickname || coalesce(m.real_name,'') || coalesce(m.short_name,'')
       || coalesce(m.birth_year::text,'') || coalesce(m.birth_date_text,'')
       || coalesce(m.gender,'') || coalesce(m.join_date_text,'')
       || coalesce(m.join_reason,'') || coalesce(m.lesson_level,'')
       || coalesce(m.swim_experience,'') || coalesce(m.notes,'')
       || m.status || m.role
       || m.historical_attendance_count_legacy::text
       || m.historical_late_count_legacy::text
       || m.updated_at::text as x
    from public.members m
   where m.nickname not like 'pwtest%'
  union all
  select a.id::text || a.kind || a.title || a.activity_date::text || a.details::text
       || coalesce(a.created_by::text,'') || a.updated_at::text
    from public.activities a
   where a.details->>'source' = 'club-workbook'
  union all
  select t.id::text || t.activity_id::text || t.member_id::text
       || t.status || t.marked_by::text || t.updated_at::text
    from public.attendance t
    join public.activities ac on ac.id = t.activity_id
   where ac.details->>'source' = 'club-workbook'
  union all
  select r.id::text || r.member_id::text || r.category || r.subcategory || r.stroke
       || r.distance_m::text || r.event_name || r.event_date::text
       || r.result_display || r.result_centiseconds::text
       || r.metadata::text || coalesce(r.created_by::text,'') || r.updated_at::text
    from public.records r
   where r.metadata->>'source' = 'club-workbook'
) s;"

fingerprint() { psql -tAX -c "$FINGERPRINT_SQL"; }

echo "== run 1 =="
run_once
BEFORE="$(fingerprint)"
echo "fingerprint after run 1: $BEFORE"

# A second apart, so a bumped updated_at is guaranteed to differ rather than
# landing inside one clock tick and reading as unchanged.
sleep 1

echo "== run 2 =="
run_once
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
