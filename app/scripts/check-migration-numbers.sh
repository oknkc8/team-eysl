#!/usr/bin/env bash
# Refuse two migrations that share a number.
#
# WHY THIS EXISTS. `schema_migrations` is keyed on the full filename, not the
# number, so `0036_a.sql` and `0036_b.sql` sit down as two perfectly ordinary
# rows. Nothing complains on apply, in CI, or in review — the only thing that
# has ever caught a collision here is a person reading two filenames side by
# side, and that has failed twice: `0020` and `0024` were each claimed twice on
# 2026-08-25, the second pair forty-eight seconds apart, by two people who had
# both just checked.
#
# A worktree cannot see another worktree's unmerged file and the ledger cannot
# see anything unapplied, so no single place answers the question before the
# fact. This answers it after: once both files are on a branch together, one
# machine looking once beats four people looking diligently.
#
# Run it by hand before pushing a migration, or read it off CI.

set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR=supabase/migrations

shopt -s nullglob
files=("$DIR"/*.sql)

# A check that finds nothing and then declares a pass is worse than no check.
# An empty directory means this ran somewhere it could not see the migrations —
# wrong working directory, bad checkout, a glob that matched nothing — and the
# honest answer to that is a failure, not a green tick. CLAUDE.md carries the
# general rule; this is it applied to the one input this script has.
if [ ${#files[@]} -eq 0 ]; then
  echo "FAIL: no migrations found under $DIR/" >&2
  echo "      This check cannot have found a collision, which makes a pass" >&2
  echo "      meaningless. Check the working directory rather than the result." >&2
  exit 1
fi

names=("${files[@]##*/}")
status=0

# Every file must be NNNN_something.sql before its number means anything. A file
# called `fix.sql` yields the prefix `fix.`, which compares unequal to
# everything and sails through a pure duplicate test — so a check that tolerates
# the name is a check you can defeat by choosing one.
#
# The reason this strictness is legitimate rather than merely tidy: migrate.sh
# runs `for f in "$MIG_DIR"/*.sql`, the same immediate-children glob this script
# uses. Every file it accepts is a file that WILL be executed as a migration, so
# requiring the name of exactly those files constrains exactly the set that
# runs. A subdirectory or a `.SQL` is checked by neither and applied by neither.
#
# The cost is deliberate: somebody who genuinely needs a differently-named
# migration has to change this script, which makes the exception a conversation
# rather than a file that quietly appeared.
for name in "${names[@]}"; do
  if [[ ! "$name" =~ ^[0-9]{4}_.+\.sql$ ]]; then
    echo "FAIL: '$name' is not named NNNN_description.sql" >&2
    status=1
  fi
done
[ "$status" -eq 0 ] || exit 1

dupes=$(printf '%s\n' "${names[@]}" | cut -c1-4 | sort | uniq -d)

if [ -n "$dupes" ]; then
  echo "FAIL: two migrations share a number." >&2
  while IFS= read -r n; do
    echo "  $n" >&2
    printf '%s\n' "${names[@]}" | grep "^$n" | sed 's/^/      /' >&2
  done <<< "$dupes"
  echo >&2
  echo "  If neither has been applied yet: rename one file and you are done." >&2
  echo >&2
  echo "  If one is already in schema_migrations: check that its content is" >&2
  echo "  unchanged, then UPDATE that row's version to the new filename in one" >&2
  echo "  statement. Or leave the file alone and correct it in a follow-up" >&2
  echo "  migration." >&2
  echo >&2
  echo "  Do not delete the ledger row and re-apply. Re-running SQL that has" >&2
  echo "  already run can conflict, duplicate data, or do something you cannot" >&2
  echo "  undo — and it is not what was done for the 0037 collision." >&2
  exit 1
fi

echo "ok: ${#files[@]} migrations, all numbers distinct"
