-- 0018 — take MAINTAIN off authenticated, finishing what 0017 started.
--
-- After 0017 the ten tables read `authenticated = arwdm`. The `m` is MAINTAIN,
-- new in PostgreSQL 17 (this project runs 17.6), and it carries VACUUM, ANALYZE,
-- CLUSTER, REFRESH MATERIALIZED VIEW and REINDEX.
--
-- It exposes no data. What it does is hand out ACCESS EXCLUSIVE locks: VACUUM
-- FULL, CLUSTER and REINDEX each take one, and a table under ACCESS EXCLUSIVE
-- answers nobody — every read and write on it blocks until the operation
-- finishes. On `members` or `activities` that is the whole app stopped.
--
-- The reachability argument is exactly 0017's, and so is the answer to it.
-- PostgREST cannot issue VACUUM, so nothing reaches this today. 0017 removed
-- TRUNCATE on the reasoning that the missing half is reachability rather than
-- permission, and that reasoning does not stop applying one privilege later.
--
-- After this, authenticated holds `arwd` and nothing else: SELECT, INSERT,
-- UPDATE, DELETE — the four that RLS policies actually gate. Every privilege
-- this role has left is answerable to a policy, which is the property worth
-- being able to state plainly about the schema.

do $$
declare t record;
begin
  for t in
    select c.relname
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('revoke maintain on public.%I from authenticated', t.relname);
  end loop;
end $$;

alter default privileges in schema public
  revoke maintain on tables from authenticated;

-- anon was left with no table privileges at all by 0014, so there is nothing
-- here to revoke from it — but the default still needs closing for the same
-- reason, or the next table arrives with MAINTAIN attached for anon too.
alter default privileges in schema public
  revoke maintain on tables from anon;
