#!/usr/bin/env bash
# One-off queries against the dev database. Usage: npm run db:psql -- -c "select 1"
. "$(dirname "$0")/_env.sh"
exec psql "$@"
