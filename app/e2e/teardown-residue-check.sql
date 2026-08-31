-- Read-only diagnosis for a suspected E2E teardown residue.
--
-- Run from a worktree whose root .env points at the dev database:
--   PWTEST_NS=<six-hex-worktree-namespace> bash scripts/psql.sh -q -tAX \
--     -f e2e/teardown-residue-check.sql
--
-- This file never repairs or deletes. A residue is evidence first; a cleanup
-- command without the run's lock/ownership context could make it worse.

\getenv ns PWTEST_NS
\if :{?ns}
\else
\set ns ''
\endif

select case when btrim(:'ns') = '' then 'true' else 'false' end as ns_missing \gset
\if :ns_missing
\echo 'PWTEST_NS is required; refusing an unscoped diagnosis.'
select 'PWTEST_NS is required'::int;
\endif

with fixture_members as (
  select id
    from public.members
   where nickname like ('pwtest' || :'ns' || '%')
), fixture_activities as (
  select id
    from public.activities
   where title like ('pwtest' || :'ns' || '%')
      or created_by in (select id from fixture_members)
), fixture_attendance as (
  select a.id
    from public.attendance a
   where a.member_id in (select id from fixture_members)
      or a.activity_id in (select id from fixture_activities)
), cross_boundary_attendance as (
  select a.id
    from public.attendance a
    join public.members marker on marker.id = a.marked_by
   where marker.nickname like ('pwtest' || :'ns' || '%')
     and a.member_id not in (select id from fixture_members)
     and a.activity_id not in (select id from fixture_activities)
)
select json_build_object(
  'namespace', :'ns',
  'fixture_members', (select count(*) from fixture_members),
  'fixture_activities', (select count(*) from fixture_activities),
  'fixture_attendance', (select count(*) from fixture_attendance),
  'cross_boundary_attendance', (select count(*) from cross_boundary_attendance),
  'granted_seed_locks', (
    select count(*)
      from pg_locks
     where locktype = 'advisory'
       and classid = 0
       and objsubid = 1
       and objid = 728193647
       and granted
  )
);
