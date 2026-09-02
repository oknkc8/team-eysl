#!/usr/bin/env bash
# Import the club master workbook into the dev database.
#
#   bash scripts/import-club-workbook.sh                              apply, from the sheet
#   bash scripts/import-club-workbook.sh --summary                    parse only, from the sheet
#   bash scripts/import-club-workbook.sh <workbook.xlsx>              apply, from a file
#   bash scripts/import-club-workbook.sh <url> --summary              parse only, from a URL
#
# WITH NO ARGUMENT the source is the published sheet named by
# EYSL_WORKBOOK_SHEET_ID in ./.env, which _env.sh sources below. The id is not
# in this repository and must not be put here: the export URL takes no
# credentials, so the id is the only thing standing between a public repo and
# forty people's names, birth dates and phone numbers. See scripts/import/source.ts.
#
# THERE IS NO --print. It existed to eyeball the generated SQL, and that SQL
# carries every member's name and birth date in plain text — so its whole job
# was to put personal data on stdout, one `> out.sql` away from being a tracked
# file in a public repository. --summary answers the same question (what did the
# parser see, and what will it write) in counts and warnings that name nobody.
# Anyone who genuinely needs the statements can read toSql.ts, which generates
# them from synthetic input under test.
#
# Safe to run twice: every statement the generator emits is an upsert, and the
# activity ids are md5 of a stable key rather than random. The script reads the
# counts back after committing, so what it prints at the end is a SELECT rather
# than the INSERT's own opinion of itself.
#
# THE WORKBOOK STAYS WHERE IT IS. It holds the names, birth dates and phone
# numbers of forty real people and this repository is public, so it is never
# copied in — and neither is the SQL, which carries the same data. The generated
# statements exist only as a pipe between node and psql; --print is there for
# review and writes to a terminal rather than a file.
#
# _env.sh is sourced for the connection, which is also the safety gate: it
# refuses any .env naming a project ref that is not our dev one, so a mistyped
# file cannot put club data into the president's live project. Connections go
# through the session pooler because free-tier direct connections are IPv6-only
# and unreachable from this host.
. "$(dirname "$0")/_env.sh"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# The workbook, if one was named. Empty means "the sheet in .env", which run.ts
# resolves — the wrapper deliberately does not build that URL itself, so there
# is one place that knows how.
WORKBOOK=""
case "${1:-}" in
  '') ;;                       # nothing at all: the sheet
  --*) ;;                      # only options: also the sheet, leave them for the loop
  http://*|https://*)
    WORKBOOK="$1"; shift ;;
  *)
    if [ ! -f "$1" ]; then
      echo "error: $1 not found (and it is not an http(s) URL)" >&2
      exit 1
    fi
    WORKBOOK="$1"; shift ;;
esac

# One place that decides whether a positional argument is passed on, so `set -u`
# never meets an empty "$WORKBOOK" that node would read as an empty path.
run_import() {
  if [ -n "$WORKBOOK" ]; then
    node "$SCRIPT_DIR/import/run.ts" "$WORKBOOK" "$@"
  else
    node "$SCRIPT_DIR/import/run.ts" "$@"
  fi
}

MODE=apply
for arg in "$@"; do
  case "$arg" in
    --summary) MODE=summary ;;
    --print)
      echo "error: --print was removed. It wrote every member's name and birth date" >&2
      echo "       to stdout, one redirect away from a tracked file in a public repo." >&2
      echo "       Use --summary, which reports counts and warnings that name nobody." >&2
      exit 2
      ;;
    *) echo "error: unknown option $arg" >&2; exit 2 ;;
  esac
done

case "$MODE" in
  summary)
    # Parses and reports without emitting SQL, and without connecting.
    run_import --summary
    ;;
  apply)
    # Straight down a pipe into psql: the SQL is never a file, not even briefly.
    # pipefail is set by _env.sh, so a parser failure fails the pipeline rather
    # than feeding psql a truncated script.
    run_import | psql -v ON_ERROR_STOP=1 -X -f -
    ;;
esac
