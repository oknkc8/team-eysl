-- 0017 — take TRUNCATE, REFERENCES and TRIGGER off authenticated, everywhere.
--
-- 0014 stripped anon and deliberately left authenticated alone, because
-- authenticated genuinely needs SELECT/INSERT/UPDATE/DELETE on most of these
-- tables — that is what the policies gate. Three of Supabase's default grants
-- are not like the others, and all ten tables still carry them:
--
--   authenticated = arwdDxtm    -- D = TRUNCATE, x = REFERENCES, t = TRIGGER
--
-- **TRUNCATE is not subject to row-level security.** RLS filters rows; TRUNCATE
-- does not touch rows individually, so no policy is consulted and none can
-- refuse it. Every other privilege authenticated holds here is answerable to a
-- policy. This one empties the table regardless of what the policies say, which
-- makes it categorically different from the surplus grants 0013 and 0014
-- removed — those were inert while RLS held, and this one is not gated at all.
--
-- Nothing reaches it today: PostgREST offers no way to issue TRUNCATE, and no
-- SECURITY INVOKER function in this schema runs one. It is the reachability
-- that is absent, not the permission — and reachability is the half that
-- changes when somebody adds a helper function later.
--
-- REFERENCES and TRIGGER go with it. REFERENCES lets a role point a foreign key
-- at the table, which then constrains what the owner may delete; TRIGGER lets a
-- role attach code to another role's writes. Both are schema-authoring rights.
-- A browser session has no business with either, and neither is used: every FK
-- and trigger in this schema is created by postgres inside a migration.
--
-- What authenticated keeps: SELECT, INSERT, UPDATE, DELETE — each one answerable
-- to a policy, which is the arrangement the whole schema is built on.

do $$
declare t record;
begin
  for t in
    select c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format(
      'revoke truncate, references, trigger on public.%I from authenticated',
      t.relname);
  end loop;
end $$;

-- Same root cause 0014 fixed for anon: without this the next `create table` in
-- public arrives with all three attached again, and a migration six months from
-- now quietly reintroduces what this one removed.
alter default privileges in schema public
  revoke truncate, references, trigger on tables from authenticated;
