# shellcheck shell=bash
# Shared connection setup. Sourced by the other scripts; never run directly.
set -euo pipefail

ENV_FILE="${ENV_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.env}"
if [ ! -f "$ENV_FILE" ]; then
  echo "error: $ENV_FILE not found. Copy .env.example and fill it in." >&2
  exit 1
fi
set -a; . "$ENV_FILE"; set +a

# ------------------------------------------------------------ which database
#
# app/src/lib/env.ts refuses to start the browser app against the president's
# project. These scripts had no equivalent, and they are the more dangerous half:
# the app only reads what RLS allows, while migrate.sh runs DDL as `postgres` and
# e2e/seed.sql creates an approved master_admin whose password sits in a public
# repository. A mistyped .env was therefore one command away from putting a
# known-credential administrator into the club's live database.
#
# So the target is checked here, once, where every script that connects passes
# through — rather than in the scripts that happen to look destructive today.
#
# The club president's LIVE project. Never, under any circumstance, and no
# override reaches this line.
FORBIDDEN_PROJECT_REF=rbghqyhzvczavtjwiocc

# Ours. Hardcoded on purpose: a positive allowlist is the only version that
# catches a .env whose variables all agree with each other and all point
# somewhere else. Anybody standing this repository up against their own Supabase
# project sets EYSL_ALLOW_PROJECT_REF deliberately — an env var is not something
# a typo produces, which is the whole distinction being drawn here.
ALLOWED_PROJECT_REF="${EYSL_ALLOW_PROJECT_REF:-gmhzpcxchtcxxkgijohv}"

# Lowercased throughout: hostnames are case-insensitive, so an uppercased ref
# reaches exactly the same database while sailing past a literal comparison.
# env.ts learned this one already.
#
# The trailing newline is load-bearing, not cosmetic. Written with `printf '%s'`
# the value arrives at sed without one, and GNU sed faithfully reproduces that —
# so two refs extracted from two variables came out concatenated into a single
# 40-character string that matched nothing and refused a perfectly good .env.
_eysl_lower() { printf '%s\n' "${1:-}" | tr '[:upper:]' '[:lower:]'; }

# Every project ref this .env names, one per line, from the values that actually
# decide where a connection lands plus the two that describe it.
#   postgres.<ref>          — pooler user, which is how this host connects
#   db.<ref>.supabase.co    — direct connection, IPv6-only on the free tier
#   https://<ref>.supabase.co
_eysl_project_refs() {
  _eysl_lower "${SUPABASE_PROJECT_REF:-}"
  _eysl_lower "${SUPABASE_DB_USER:-}" | sed -n 's/^postgres\.\([a-z0-9]\{16,\}\)$/\1/p'
  _eysl_lower "${SUPABASE_DB_HOST:-}" | sed -n 's/^db\.\([a-z0-9]\{16,\}\)\.supabase\.co$/\1/p'
  _eysl_lower "${SUPABASE_URL:-}" | sed -n 's#^https\{0,1\}://\([a-z0-9]\{16,\}\)\.supabase\.co/*$#\1#p'
}

# The blunt instrument first: the forbidden ref anywhere in any connection value,
# in any shape, including one these patterns do not parse. This runs before the
# allowlist so that a broken override cannot turn into a route to production.
_eysl_all_values="$(_eysl_lower "${SUPABASE_PROJECT_REF:-}${SUPABASE_DB_USER:-}${SUPABASE_DB_HOST:-}${SUPABASE_URL:-}")"
case "$_eysl_all_values" in
  *"$FORBIDDEN_PROJECT_REF"*)
    echo "error: $ENV_FILE names the production project ($FORBIDDEN_PROJECT_REF)." >&2
    echo "       That is the club president's live database, holding real member data." >&2
    echo "       Refusing to connect. Point .env at our own dev project." >&2
    exit 1
    ;;
esac

# Then the allowlist. Every ref the file names must be ours — one disagreeing
# value means the file is half-edited, which is exactly the state that produces
# an accident.
_eysl_seen_ref=0
while IFS= read -r _eysl_ref; do
  [ -n "$_eysl_ref" ] || continue
  _eysl_seen_ref=1
  if [ "$_eysl_ref" != "$ALLOWED_PROJECT_REF" ]; then
    echo "error: $ENV_FILE points at project '$_eysl_ref', not our dev project" >&2
    echo "       ('$ALLOWED_PROJECT_REF'). Refusing to connect." >&2
    echo "       Set EYSL_ALLOW_PROJECT_REF to use a different project on purpose." >&2
    exit 1
  fi
done <<EOF
$(_eysl_project_refs)
EOF

# A .env naming no ref at all is not a pass. It means neither the pooler user nor
# the host matched a shape this guard understands, so it has no idea where the
# connection would land — and "I could not tell" must not read as "go ahead".
if [ "$_eysl_seen_ref" -eq 0 ]; then
  echo "error: no Supabase project ref found in $ENV_FILE." >&2
  echo "       Expected SUPABASE_DB_USER=postgres.<ref> or SUPABASE_DB_HOST=db.<ref>.supabase.co." >&2
  echo "       Refusing to connect to a database this guard cannot identify." >&2
  exit 1
fi

unset _eysl_all_values _eysl_seen_ref _eysl_ref

export PGHOST="$SUPABASE_DB_HOST"
export PGPORT="$SUPABASE_DB_PORT"
export PGUSER="$SUPABASE_DB_USER"
export PGDATABASE="$SUPABASE_DB_NAME"
export PGPASSWORD="$SUPABASE_DB_PASSWORD"
export PGSSLMODE=require
export PGCONNECT_TIMEOUT=15
