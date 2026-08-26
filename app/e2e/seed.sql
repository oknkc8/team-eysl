-- Test accounts for the Playwright suite.
--
-- Every row this file creates is prefixed `pwtest`, which is what cleanup.sql
-- matches on. The dev database is shared with other agents, so the prefix is the
-- contract: nothing here touches a row it did not create, and cleanup removes
-- exactly what this file inserts.
--
-- Run with:  PWTEST_PASSWORD=<something> bash scripts/psql.sh -v ON_ERROR_STOP=1 -f e2e/seed.sql
--            (or just `npm run test:e2e`, which generates one and passes it in)
--
-- Accounts are created directly rather than through the app because creating an
-- auth user through the API needs the service role key, which is not in .env and
-- has no business being there.
--
-- THE PASSWORD COMES FROM THE ENVIRONMENT, never from this file. It used to be
-- the literal `pwtest-password-1`, which — in a PUBLIC repository, on a file that
-- creates an approved master_admin — published working administrator credentials
-- for whatever database this last ran against. global-setup.ts now generates one
-- per run into the git-ignored e2e/.auth/password and passes it here.
\getenv pwtest_password PWTEST_PASSWORD

-- \getenv leaves the variable unset when the environment has nothing, and an
-- unset :'var' reaches the server as literal text and fails with a syntax error
-- naming the wrong thing. Default it, then refuse deliberately.
\if :{?pwtest_password}
\else
\set pwtest_password ''
\endif

-- Checked in plain SQL, NOT in a `do $$ ... $$` block. psql substitutes :'var'
-- everywhere except inside a quoted string, and a dollar-quoted body is a quoted
-- string — so the plpgsql version of this check shipped `:'pwtest_password'`
-- verbatim to the server and died on `syntax error at or near ":"`, which names
-- neither the variable nor the reason.
--
-- 'true'/'false' as text rather than a bare boolean because \if accepts those
-- spellings, while psql renders a boolean as t/f.
select
  case when btrim(:'pwtest_password') = '' then 'true' else 'false' end as pw_missing,
  -- The same two bounds register_member_v1 enforces, so a bad generator surfaces
  -- here rather than as four accounts nobody can sign in to. Bytes for the upper
  -- bound: bcrypt truncates at 72 bytes, and a Korean character is three.
  case when length(:'pwtest_password') < 8
         or octet_length(:'pwtest_password') > 72
       then 'true' else 'false' end as pw_unusable
\gset

\if :pw_missing
\echo ''
\echo 'e2e/seed.sql: PWTEST_PASSWORD is not set.'
\echo 'Run `npm run test:e2e`, which generates one per run into e2e/.auth/password,'
\echo 'or export one yourself before running this file by hand.'
-- Deliberate failure, so ON_ERROR_STOP turns this into a non-zero exit. The cast
-- is what carries the sentence into the error text itself, for whoever sees only
-- the captured stderr and not the \echo lines above.
select 'PWTEST_PASSWORD is not set'::int;
\endif

\if :pw_unusable
\echo ''
\echo 'e2e/seed.sql: PWTEST_PASSWORD must be 8 to 72 bytes.'
select 'PWTEST_PASSWORD must be 8 to 72 bytes'::int;
\endif

begin;

-- Idempotent: reseeding after a crashed run must not collide on
-- members_nickname_lower_uq.
\i e2e/cleanup.sql

-- Member ids are fixed rather than generated because the route table in
-- fixtures.ts has to name them: /members/:memberId and /chat/dm/:memberId
-- cannot be visited without one, and a spec that queried for the id first would
-- need database credentials in the browser process.
create temporary table pwtest_accounts (
  nickname   text primary key,
  status     text not null,
  role       text not null,
  member_id  uuid not null,
  auth_id    uuid not null default gen_random_uuid()
) on commit drop;

insert into pwtest_accounts (nickname, status, role, member_id) values
  -- 총관리자: reaches every screen, including the three master-admin ones.
  ('pwtestadmin',   'approved', 'master_admin', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  -- An ordinary approved member: the refusal case for the admin routes.
  ('pwtestmember',  'approved', 'member',       'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  -- Signed up, not yet admitted. The state a real first user meets, so it gets
  -- an account rather than being tested only as an absence.
  ('pwtestpending', 'pending',  'member',       'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  -- A second ordinary member, which only the write suite needs.
  --
  -- Two of the legacy app's data-loss bugs are races between two people, and a
  -- race needs two people who are both *ordinary*: pairing a member with the
  -- 총관리자 would test a path where one side is staff, and staff take different
  -- branches through apply_to_activity() and every RLS policy they touch. The
  -- bug the president's members actually hit is two members, so the fixture is
  -- two members.
  ('pwtestmember2', 'approved', 'member',       'dddddddd-dddd-4ddd-8ddd-dddddddddddd');

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data,
  -- These four are nullable with no default, and leaving them null is what makes
  -- GoTrue answer every sign-in with `500 unexpected_failure / "Database error
  -- querying schema"` — it scans them into plain Go strings, which cannot hold
  -- NULL. Their siblings (email_change_token_current, phone_change,
  -- phone_change_token, reauthentication_token) default to '' and are fine.
  -- The message names neither the table nor the column, so this costs an hour if
  -- it is not written down.
  confirmation_token, recovery_token, email_change_token_new, email_change
)
select
  -- The instance id GoTrue stamps on every user in a single-tenant project.
  '00000000-0000-0000-0000-000000000000',
  a.auth_id,
  'authenticated',
  'authenticated',
  a.nickname || '@eysl.local',
  -- bcrypt, the hash GoTrue itself writes. A plaintext value here would make
  -- signInWithPassword fail with nothing but "invalid credentials".
  --
  -- Cost 10 explicitly, for the reason 0029 gives at length: gen_salt('bf') with
  -- no second argument is cost 6, and seeding fixtures at a weaker cost than the
  -- product writes would quietly make the tests a poor model of the real thing.
  crypt(:'pwtest_password', gen_salt('bf', 10)),
  -- Confirmed inline: this project has no mail transport, so an unconfirmed
  -- user could never sign in.
  now(), now(), now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  -- Read by 0027's trigger, which takes `nickname` and nothing else out of this
  -- object. The fallback it would otherwise use is the address local part, which
  -- happens to be the same string — being explicit says the nickname is chosen
  -- rather than incidental.
  jsonb_build_object('nickname', a.nickname),
  '', '', '', ''
from pwtest_accounts a;

-- GoTrue resolves an email login through this table, not through auth.users
-- alone. Without the identity row, sign-in fails even though the user exists.
insert into auth.identities (
  provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at
)
select
  a.auth_id::text,
  a.auth_id,
  jsonb_build_object(
    'sub', a.auth_id::text,
    'email', a.nickname || '@eysl.local',
    'email_verified', true,
    'phone_verified', false
  ),
  'email',
  now(), now(), now()
from pwtest_accounts a;

-- The members rows already exist by this point: 0027 put an AFTER INSERT trigger
-- on auth.users (on_auth_user_created -> handle_new_auth_user), which creates
-- one inside the same transaction. Inserting here as well is what a first draft
-- of this file did, and it failed on members_auth_user_id_key.
--
-- So this promotes what the trigger made rather than competing with it. The
-- trigger deliberately refuses to read status or role out of client metadata —
-- a signup claiming master_admin gets a pending member like everybody else —
-- which is exactly right, and means the only way to seed an approved admin is
-- to set those columns here, with database credentials, outside any request.
--
-- id is rewritten too, so fixtures.ts can name the ids literally. Safe only
-- because these rows are seconds old and nothing references them yet.
update public.members m
set id        = a.member_id,
    real_name = a.nickname || ' 테스트',
    status    = a.status,
    role      = a.role
from pwtest_accounts a
where m.auth_user_id = a.auth_id;

-- One row apiece for the three detail routes, at fixed ids the spec files import
-- from fixtures.ts. Without them /notices/:noticeId, /schedule/:activityId and
-- /media/:folderId could only ever be visited with an id that does not exist,
-- which tests the not-found branch and never the screen itself.
--
-- Titles carry the pwtest prefix so cleanup.sql's predicate is the same one it
-- uses everywhere else, and so a human looking at the dev database can see at a
-- glance which rows are ours.
insert into public.notices (id, title, body, created_by)
select
  '11111111-1111-4111-8111-111111111111',
  'pwtest 공지 제목',
  E'pwtest 공지 본문입니다.\n두 번째 줄.',
  m.id
from public.members m where m.nickname = 'pwtestadmin';

insert into public.activities (id, kind, title, activity_date, start_time, place, capacity, created_by)
select
  '22222222-2222-4222-8222-222222222222',
  'training',
  'pwtest 훈련',
  current_date + 7,
  '19:00',
  'pwtest 수영장',
  10,
  m.id
from public.members m where m.nickname = 'pwtestadmin';

insert into public.media_folders (id, name, created_by)
select
  '33333333-3333-4333-8333-333333333333',
  'pwtest 폴더',
  m.id
from public.members m where m.nickname = 'pwtestadmin';

-- ---------------------------------------------------------------------------
-- Fixtures the write suite owns (writes.spec.ts).
--
-- One row per test rather than one shared row for all of them. The suite runs
-- fullyParallel, so two tests writing to the same activity would interleave and
-- the failure would read as a product bug rather than as a fixture collision.
-- Every id below is used by exactly one test.
-- ---------------------------------------------------------------------------

-- 정원 1. The capacity race needs an activity where one seat exists and two
-- people want it; anything larger cannot tell "the server arbitrated" from
-- "there was room for both".
insert into public.activities (id, kind, title, activity_date, start_time, place, capacity, created_by)
select
  '44444444-4444-4444-8444-444444444444',
  'training',
  'pwtest 정원1 훈련',
  current_date + 8,
  '20:00',
  'pwtest 수영장',
  1,
  m.id
from public.members m where m.nickname = 'pwtestadmin';

-- The attendance roster. Since 0030 attendance_for_activity_v1 lists the union
-- of application_type = 'participant' and anyone already marked, so an activity
-- with neither shows 신청자가 없습니다 and there is nothing to check anyone in
-- against. Exactly one member applies below, and the write test marks that same
-- member, which is why the roster it reads back is one row and not two.
insert into public.activities (id, kind, title, activity_date, start_time, place, capacity, created_by)
select
  '55555555-5555-4555-8555-555555555555',
  'training',
  'pwtest 출석 훈련',
  current_date + 9,
  '21:00',
  'pwtest 수영장',
  10,
  m.id
from public.members m where m.nickname = 'pwtestadmin';

insert into public.activity_applications (activity_id, member_id, application_type)
select
  '55555555-5555-4555-8555-555555555555',
  m.id,
  'participant'
from public.members m where m.nickname = 'pwtestmember';

-- Its own notice, so the concurrent-comment test counts the comments it wrote
-- and not whatever else the run has left on the shared one.
insert into public.notices (id, title, body, created_by)
select
  '66666666-6666-4666-8666-666666666666',
  'pwtest 댓글 공지',
  'pwtest 동시 댓글 시험용 공지입니다.',
  m.id
from public.members m where m.nickname = 'pwtestadmin';

commit;

select nickname, status, role from public.members where nickname like 'pwtest%' order by nickname;
