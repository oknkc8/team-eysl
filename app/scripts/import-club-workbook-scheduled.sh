#!/usr/bin/env bash
# The club workbook import, run unattended by a scheduler.
#
#   bash app/scripts/import-club-workbook-scheduled.sh
#
# Same import as import-club-workbook.sh with no argument — the published sheet
# named by EYSL_WORKBOOK_SHEET_ID in ./.env. This file adds only what running
# without a person in front of it needs: a log, a lock, and a PATH that survives
# launchd.
#
# ---------------------------------------------------------------------------
# WHY A MACHINE THAT ALREADY HOLDS THE CREDENTIALS, AND NOT THE TWO OBVIOUS
# ALTERNATIVES.
#
# GITHUB ACTIONS IS OUT, and the repository has already made this exact decision
# once. .github/workflows/app.yml:195-201 refuses to run the Playwright suite in
# CI because doing so would mean putting the dev database password into Actions
# secrets: "This repository is public. Putting the dev database password into
# Actions secrets to make those tests run in CI would recreate, by hand, exactly
# the exposure guard.yml exists to prevent — and it would do it on the one
# project we can actually damage." Every word of that applies here and one more
# thing does too: this job needs a SECOND credential, EYSL_WORKBOOK_SHEET_ID,
# which is a download link to forty people's names, birth dates and phone
# numbers requiring no authentication at all. And the run's own output is
# member data — the parser's warnings quote spreadsheet rows. Actions logs on a
# public repository are public. There is no arrangement of this job that is safe
# to run there.
#
# A SUPABASE EDGE FUNCTION IS OUT for a different reason, and it is worth being
# precise because it is otherwise the natural home for a scheduled job (pg_cron
# 1.6.4 and pg_net 0.20.4 are both installed on our project). The importer is
# 785 lines of parser plus a SQL generator, covered by 74 vitest tests that run
# in this repo's normal gate. Moving it to supabase/functions/ would move it into
# the tree CLAUDE.md describes as the shallowly-checked one — Deno is not
# installed here, its types are hand-written shims, and a wrong shim is a check
# that agrees with the mistake. It would also replace a reviewable SQL script
# piped through psql with a direct write from a function holding standing
# credentials, and it would need the sheet id as a Supabase secret. That is a
# large permanent surface for a job whose entire output is a few appended rows.
# The requirement was to automate the tested importer, not to rewrite it.
#
# WHAT THIS COSTS, SAID PLAINLY. The import only runs while this machine is
# awake and this user is logged in. launchd will run a missed job once at the
# next login rather than catching up on every one it slept through. If the
# import needs to run somewhere nobody is sitting, that is a hosting decision
# for the president to make with a private repository or a small always-on box,
# and it is not something this script can paper over.
#
# ---------------------------------------------------------------------------
# AND WHAT A SCHEDULE DOES NOT BUY, WHICH MATTERS MORE THAN THE SCHEDULE.
#
# Every statement the generator emits is ON CONFLICT DO NOTHING. This is a
# backfill, not a sync — read the header of scripts/import/toSql.ts for why that
# was deliberate. So a scheduled run picks up ADDITIONS only: a new member, a
# new training date, a new result. A CORRECTION made in the spreadsheet to a row
# that already reached the database will never arrive, silently, forever.
#
# That is the right trade — the alternative reverts members' own profile edits
# and admins' attendance corrections on every run — but anyone who reads
# "automatic import" as "the app follows the sheet" will be wrong, and will be
# wrong quietly. Say so when handing this to the president.
set -euo pipefail

# -P on both sides, so the "is the log inside the repo" comparison below is
# between two resolved paths and a symlink cannot slip between them.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"

# ---------------------------------------------------------------------------
# THIS REFUSES TO RUN UNTIL SOMEBODY DECIDES THE QUESTION BELOW.
#
# The importer this wraps is WRITE-ONCE, not a sync. Every statement it emits is
# `on conflict ... do nothing` (13 of them), and toSql.ts:29-38 says so in as
# many words: "This is a one-time backfill of a paper register, not a sync. Once
# a row exists the app is the newer source, and the importer's job is finished."
#
# Run by hand that is correct, and deliberate — an earlier `do update` version
# silently reverted members' own profile edits and admins' attendance
# corrections. Put it on a SCHEDULE and the same property becomes a different
# thing: a job that loads the president's FIRST version of every fact and then
# ignores every correction he ever makes, forever, silently.
#
# The sharpest case, and it is not hypothetical. Activity ids are
# md5('eysl-import:training:<date>')::uuid (toSql.ts:75-80), so THE DATE IS THE
# IDENTITY. He corrects a training date — 1월 4일 to 1월 5일, about the most
# likely edit anyone ever makes to a spreadsheet — and the next run mints a NEW
# activity and loads the same people's attendance onto it. The old activity and
# its rows survive, because `do nothing` never deletes. Every member who was
# there is permanently +1 in 출석왕, and nobody spots a wrong number on a
# leaderboard by eye (0016:8 makes exactly that argument about a different bug).
#
# `records` has the same shape: result_centiseconds is in the dedup key
# (toSql.ts:308-310), so a corrected time inserts a second row and leaves the
# wrong one, and the 단축 rankings then compare a real time against a stale one.
#
# WHAT IS ALREADY CLOSED: the identity-drift guard catches a renamed MEMBER, and
# the double-count guard catches the legacy counters. Neither sees a moved DATE.
#
# WHAT WOULD CLOSE IT: refuse the import when the workbook's training-date set is
# not a superset of the dates already loaded. A date that vanished or moved is a
# correction, and a correction is a person's decision — this importer can only
# ever add. That guard is not written yet.
#
# So everything below works and is tested, and running it unattended is the one
# thing it must not do until that guard exists. Setting the variable is how you
# say you have read this.
# ---------------------------------------------------------------------------
if [ "${EYSL_IMPORT_SCHEDULED_OK:-}" != "yes" ]; then
  echo "refusing to run: the importer is write-once and this is the scheduled path." >&2
  echo "  A scheduled run loads his first version of every fact and ignores every" >&2
  echo "  correction after it. A corrected training DATE silently duplicates an" >&2
  echo "  activity and permanently inflates 출석왕; no guard catches that yet." >&2
  echo "" >&2
  echo "  Run it by hand instead:  npm run db:import" >&2
  echo "  Or, having read the header of this file and accepted it:" >&2
  echo "    EYSL_IMPORT_SCHEDULED_OK=yes $0" >&2
  exit 1
fi

# Logs go OUTSIDE the repository, and the check below is not decoration. The
# import's stderr carries the parser's warnings, which quote spreadsheet rows,
# and psql's errors name members — the double-count guard does so by design.
# This repository is public, so a log inside it is a leak waiting for one
# careless `git add -A`.
LOG_DIR="${EYSL_IMPORT_LOG_DIR:-$HOME/Library/Logs/team-eysl}"

refuse_log_dir() {
  echo "error: the log directory is inside the repository ($1)." >&2
  echo "       The log carries member data and this repository is public." >&2
  echo "       Set EYSL_IMPORT_LOG_DIR to somewhere outside it." >&2
  exit 1
}

# Checked twice, on the way in and again after resolving, and the first check is
# not redundant: without it the obvious mistake still creates a directory inside
# the repository before being told no.
case "$LOG_DIR" in "$REPO_ROOT"|"$REPO_ROOT"/*) refuse_log_dir "$LOG_DIR" ;; esac

# Owner-only, both the directory and everything written into it. The log is
# member data at rest.
umask 077
mkdir -p "$LOG_DIR"

# Now the real path, because `.../app/../logs` and a symlink both reach the
# repository while looking like they do not, and neither is caught above.
LOG_DIR="$(cd "$LOG_DIR" && pwd -P)"
case "$LOG_DIR" in "$REPO_ROOT"|"$REPO_ROOT"/*) refuse_log_dir "$LOG_DIR" ;; esac
LOG="$LOG_DIR/import.log"

# One at a time. Two overlapping runs would not corrupt anything — the
# statements are all DO NOTHING and psql is transactional — but they would
# double the pooler connections and interleave two runs into one log, which
# makes a failure unreadable. mkdir is the atomic primitive available in POSIX
# shell; flock is not on macOS.
LOCK="$LOG_DIR/import.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "$(date '+%Y-%m-%d %H:%M:%S')  skipped: another run holds $LOCK" >> "$LOG"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

{
  echo
  echo "=================================================================="
  echo "$(date '+%Y-%m-%d %H:%M:%S')  starting scheduled import"
} >> "$LOG"

# launchd hands a job a minimal PATH — /usr/bin:/bin:/usr/sbin:/sbin — which has
# neither node nor psql. The plist sets PATH for the common install locations;
# this is the belt to its braces, so running the script by hand from a normal
# shell and running it from launchd reach the same binaries.
for candidate in "$HOME/.nvm/versions/node/current/bin" /opt/homebrew/bin \
                 /opt/homebrew/opt/libpq/bin /usr/local/bin /usr/local/opt/libpq/bin; do
  [ -d "$candidate" ] && PATH="$candidate:$PATH"
done
export PATH

# Both failure modes are reported, because "the scheduler ran it" and "the
# import worked" are different claims and only the second one matters.
STATUS=0
bash "$REPO_ROOT/app/scripts/import-club-workbook.sh" >> "$LOG" 2>&1 || STATUS=$?

if [ "$STATUS" -eq 0 ]; then
  echo "$(date '+%Y-%m-%d %H:%M:%S')  ok" >> "$LOG"
else
  echo "$(date '+%Y-%m-%d %H:%M:%S')  FAILED with exit $STATUS" >> "$LOG"
fi
exit "$STATUS"
