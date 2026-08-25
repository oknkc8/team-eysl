-- 0019 — close a live privilege escalation through public.member_public_v.
--
-- This one was exploitable, unlike everything 0013/0014/0017/0018 removed.
--
-- Four facts had to hold at once, and all four did, verified live:
--
--   columns  : id, nickname, short_name, avatar_path, team_role, role, status
--   updatable: pg_relation_is_updatable = 28  (INSERT | UPDATE | DELETE)
--   grants   : authenticated = arwdDxtm
--   security : DEFINER — no security_invoker, so base-table RLS is bypassed
--
-- A view over a single table with no aggregate is auto-updatable, and a view
-- without security_invoker executes with its owner's rights. So a write aimed
-- at the view never meets `members`' policies at all:
--
--   PATCH /rest/v1/member_public_v?id=eq.<own id>   {"role": "master_admin"}
--
-- Any approved member could promote themselves, then call every master-admin
-- RPC in the schema. The same path could rewrite another member's role or
-- status. `members` itself was never the weak point — its policies are sound
-- and were checked — the view was simply a second door into the same rows with
-- no lock on it.
--
-- Why this was missed three audits running: the grant audits printed the views
-- alongside the tables, and `authenticated=arwdDxtm` on a view reads exactly
-- like `authenticated=arwdDxtm` on a table. On a table it is unremarkable —
-- RLS is what refuses. On a view there is no RLS, so the same string means the
-- opposite thing. **A view's grants are the whole gate.**
--
-- Two fixes, and one deliberate non-fix.

-- 1. DML goes. Nothing in the app writes through either view; both exist to be
--    read. `grant select` alone would not have helped — GRANT adds, it does not
--    replace, so the existing UPDATE would have survived it. Revoke first.
revoke all on public.member_public_v  from authenticated;
revoke all on public.activity_seats_v from authenticated;

grant select on public.member_public_v  to authenticated;
grant select on public.activity_seats_v to authenticated;

-- 2. The caller gate the view never had. `where status = 'approved'` filters
--    which rows are exposed; it says nothing about who may ask. A member whose
--    own status is pending, rejected or blocked still holds a valid session,
--    and could read the entire roster through this view — the approval gate the
--    rest of the schema enforces via current_member_id() simply was not here.
--
--    current_member_id() returns null unless the caller has an approved member
--    row, so this is all-or-nothing: an unapproved caller now sees zero rows.
--    It is evaluated once per query, not per row.
--
--    The view stays DEFINER on purpose. Turning on security_invoker would apply
--    members_read (`auth_user_id = auth.uid() or is_staff()`) and a member would
--    see only themselves — that policy is what this view exists to widen, for
--    the member directory. Widening reads is the view's job; allowing writes
--    never was.
create or replace view public.member_public_v as
  select id, nickname, short_name, avatar_path, team_role, role, status
    from public.members
   where status = 'approved'
     and public.current_member_id() is not null;

-- CREATE OR REPLACE preserves the ACL, so re-assert the intent rather than
-- assuming: after this migration both views must read select-only.
revoke all on public.member_public_v from authenticated;
grant select on public.member_public_v to authenticated;

-- 3. The non-fix, stated so the next person does not have to rediscover it.
--    ALTER DEFAULT PRIVILEGES cannot separate views from tables — both are
--    'TABLES' to it. authenticated keeping default arwd is correct for tables,
--    where policies decide, and wrong for every view, where nothing does. So
--    there is no default that makes the next view safe.
--
--    The rule that replaces it: **every new view in this schema must revoke DML
--    from authenticated explicitly in the same migration that creates it.**
