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
# called `fix.sql` yields the prefix `fix.`, which would compare unequal to
# everything and pass silently.
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
  echo "  Renaming one of them means renaming the file, deleting its" >&2
  echo "  schema_migrations row and re-applying. Cheaper before the merge." >&2
  exit 1
fi

echo "ok: ${#files[@]} migrations, all numbers distinct"
