#!/usr/bin/env bash
# Import the club master workbook into the dev database.
#
#   bash scripts/import-club-workbook.sh <workbook.xlsx>              apply
#   bash scripts/import-club-workbook.sh <workbook.xlsx> --summary    parse only
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

WORKBOOK="${1:-}"
if [ -z "$WORKBOOK" ]; then
  echo "usage: bash scripts/import-club-workbook.sh <workbook.xlsx> [--summary|--print]" >&2
  exit 2
fi
if [ ! -f "$WORKBOOK" ]; then
  echo "error: $WORKBOOK not found" >&2
  exit 1
fi
shift

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
    node "$SCRIPT_DIR/import/run.ts" "$WORKBOOK" --summary
    ;;
  apply)
    # Straight down a pipe into psql: the SQL is never a file, not even briefly.
    # pipefail is set by _env.sh, so a parser failure fails the pipeline rather
    # than feeding psql a truncated script.
    node "$SCRIPT_DIR/import/run.ts" "$WORKBOOK" | psql -v ON_ERROR_STOP=1 -X -f -
    ;;
esac
