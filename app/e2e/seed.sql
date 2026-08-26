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
-- short_name / birth_year / gender are here because 0032's signup guard reads
-- them. The workbook importer fills those three columns for every member it
-- creates, and they are what makes a returning member recognisable when they
-- sign up under the 이름/출생년도/성별/지역 format — a fixture without them looks
-- like nothing the club actually has, and the guard would have no row to catch.
--
-- `location` is deliberately left null, matching the import: the spreadsheet
-- carried no region column, which is exactly why the guard ignores that segment.
create temporary table pwtest_accounts (
  nickname   text primary key,
  status     text not null,
  role       text not null,
  member_id  uuid not null,
  birth_year smallint not null,
  gender     text not null,
  auth_id    uuid not null default gen_random_uuid()
) on commit drop;

insert into pwtest_accounts (nickname, status, role, member_id, birth_year, gender) values
  -- 총관리자: reaches every screen, including the three master-admin ones.
  ('pwtestadmin',   'approved', 'master_admin', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1980, '남'),
  -- An ordinary approved member: the refusal case for the admin routes, and the
  -- roster row 0032's signup guard is tested against. 1970 so the two-digit year
  -- in that test (`70`) is unambiguous.
  ('pwtestmember',  'approved', 'member',       'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 1970, '남'),
  -- Signed up, not yet admitted. The state a real first user meets, so it gets
  -- an account rather than being tested only as an absence.
  ('pwtestpending', 'pending',  'member',       'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 1990, '여'),
  -- A second ordinary member, which only the write suite needs.
  --
  -- Two of the legacy app's data-loss bugs are races between two people, and a
  -- race needs two people who are both *ordinary*: pairing a member with the
  -- 총관리자 would test a path where one side is staff, and staff take different
  -- branches through apply_to_activity() and every RLS policy they touch. The
  -- bug the president's members actually hit is two members, so the fixture is
  -- two members.
  ('pwtestmember2', 'approved', 'member',       'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 1995, '여'),
  -- Turned away, and shown the door after being let in. Neither is a variant of
  -- 'pending': all three are simply "not approved", and that is the point —
  -- current_member_id() is the single predicate every RPC in this schema leans
  -- on, and this repository has lost it once already (restored in 0010). Three
  -- rows here is what lets a test say so in three states rather than one.
  ('pwtestrejected','rejected', 'member',       'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 1988, '남'),
  ('pwtestblocked', 'blocked',  'member',       'ffffffff-ffff-4fff-8fff-ffffffffffff', 1992, '여');

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
set id         = a.member_id,
    real_name  = a.nickname || ' 테스트',
    status     = a.status,
    role       = a.role,
    -- The three the workbook importer fills, and that 0032's signup guard
    -- matches on. short_name is the nickname because for an imported member it
    -- is: the spreadsheet's 이름 column becomes both.
    short_name = a.nickname,
    birth_year = a.birth_year,
    gender     = a.gender
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
--
-- That covers the applied-and-marked path only. The walk-in path — marked
-- without ever applying, which is the case 0030 exists for — has its own
-- activity further down, because keeping this roster at one row is the whole
-- point of it.
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

-- The walk-in roster. Since 0030, attendance_for_activity_v1 returns the union
-- of the participant list and everyone already marked — two arms that can break
-- independently, so this fixture seeds one member into each.
--
-- pwtestmember applies here and the test never marks them: the application arm.
-- pwtestmember2 is deliberately left out of activity_applications and the test
-- marks them: the attendance arm, and the row the pre-0030 function dropped.
--
-- Its own activity rather than 출석 훈련 above, whose roster has to stay at one
-- row for the test that owns it.
insert into public.activities (id, kind, title, activity_date, start_time, place, capacity, created_by)
select
  '77777777-7777-4777-8777-777777777777',
  'training',
  'pwtest 워크인 훈련',
  current_date + 10,
  '22:00',
  'pwtest 수영장',
  10,
  m.id
from public.members m where m.nickname = 'pwtestadmin';

insert into public.activity_applications (activity_id, member_id, application_type)
select
  '77777777-7777-4777-8777-777777777777',
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

-- ---------------------------------------------------------------------------
-- A roster with depth: twelve synthetic members.
--
-- The four accounts above are enough to test permissions and two-party races,
-- and not enough to test anything that only appears in bulk — a roster that
-- scrolls, a waitlist with an order to get wrong, a ranking with a tie in it.
-- These twelve exist for that, and they are DATA rather than accounts: no
-- auth.users row, no password, auth_user_id left null. Nothing signs in as them,
-- so nothing here weakens the point 0029 makes about seeded credentials in a
-- public repository.
--
-- Names are unmistakably fake. The dev database also holds the real club roster
-- imported from the club workbook, and a plausible-looking Korean name in a
-- committed file would be indistinguishable from one of those at a glance —
-- 'pwtest더미01' cannot be mistaken for a person.
--
-- The pwtest prefix is the same contract as everywhere else: cleanup.sql
-- matches on it and removes every row below.
-- ---------------------------------------------------------------------------

create temporary table pwtest_dummies (
  n          int primary key,
  nickname   text not null,
  gender     text not null,
  birth_year smallint not null,
  member_id  uuid not null
) on commit drop;

insert into pwtest_dummies (n, nickname, gender, birth_year, member_id)
select n,
       'pwtest더미' || to_char(n, 'FM00'),
       case when n % 2 = 0 then '여' else '남' end,
       (1985 + n)::smallint,
       -- Fixed and readable, for the same reason the four accounts above have
       -- fixed ids: a spec that needs /members/:memberId cannot query for one.
       ('e0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
from generate_series(1, 12) as n;

insert into public.members (
  id, nickname, short_name, real_name, birth_year, gender, lesson_level, status, role
)
select d.member_id,
       d.nickname,
       d.nickname,
       '테스트더미 ' || to_char(d.n, 'FM00'),
       d.birth_year,
       d.gender,
       case d.n % 3 when 0 then '상급' when 1 then '중급' else '연수' end,
       'approved',
       'member'
from pwtest_dummies d;

-- ------------------------------------------------------------------ 대기 순번
--
-- Capacity 3 with 8 applicants, so the waitlist is five deep and has an order
-- that can be read back. 'pwtest 정원1 훈련' above is capacity 1 and answers a
-- different question — whether the server arbitrates a single seat — which is
-- why it cannot also be the fixture for an ordered queue.
--
-- Rows are written directly rather than through apply_to_activity(): this is a
-- starting state, and going through the RPC would make the fixture depend on
-- the very seat handout the tests exist to check.
insert into public.activities (id, kind, title, activity_date, start_time, place, capacity, created_by)
select
  '88888888-8888-4888-8888-888888888888',
  'training',
  'pwtest 대기 훈련',
  current_date + 11,
  '20:30',
  'pwtest 수영장',
  3,
  m.id
from public.members m where m.nickname = 'pwtestadmin';

insert into public.activity_applications (activity_id, member_id, application_type, wait_order)
select
  '88888888-8888-4888-8888-888888888888',
  d.member_id,
  case when d.n <= 3 then 'participant' else 'waitlist' end,
  -- wait_order_only_for_waitlist (0001) refuses an order on a participant, and
  -- activity_applications_wait_order_uq refuses a repeated one on a waitlist.
  case when d.n <= 3 then null else d.n - 3 end
from pwtest_dummies d
where d.n <= 8;

-- -------------------------------------------------------------------- 랭킹
--
-- team_event_rankings_v1 (0016) scopes 상반기/하반기 to the calendar year of
-- now() in Asia/Seoul, so these dates are anchored to the current year rather
-- than offset from today. `current_date - 60` would drift into the previous
-- year whenever the suite runs in the first two months and the ranking would
-- quietly see nothing.
create temporary table pwtest_rank_days (slot int primary key, activity_id uuid, on_date date)
on commit drop;

insert into pwtest_rank_days (slot, activity_id, on_date) values
  (1, '99999999-9999-4999-8999-999999999991',
      make_date(extract(year from current_date)::int, 3, 2)),   -- 상반기
  (2, '99999999-9999-4999-8999-999999999992',
      make_date(extract(year from current_date)::int, 7, 20)),  -- 하반기
  (3, '99999999-9999-4999-8999-999999999993',
      make_date(extract(year from current_date)::int, 7, 30));  -- 하반기

insert into public.activities (id, kind, title, activity_date, place, capacity, created_by)
select r.activity_id, 'training', 'pwtest 랭킹 훈련 ' || r.slot, r.on_date, 'pwtest 수영장', 20, m.id
from pwtest_rank_days r
cross join public.members m
where m.nickname = 'pwtestadmin';

-- The tallies are deliberately uneven, and deliberately not all distinct:
--
--   더미01  present x3            출석 3, 지각 0
--   더미02  present x2, late x1   출석 3, 지각 1   <- ties 더미01 at the top
--   더미03  late x2               출석 2, 지각 2   <- top of 지각왕
--   더미04  present x1            출석 1
--   더미05  late x1               출석 1, 지각 1
--
-- The tie at the top is the point. 0016 ranks with rank() so ties share a place
-- and the next distinct count skips one; a fixture where every total differed
-- would pass whether or not that held.
insert into public.attendance (activity_id, member_id, status, marked_by)
select r.activity_id, d.member_id, v.status, adm.id
from (values
  (1, 1, 'present'), (1, 2, 'present'), (1, 3, 'late'), (1, 4, 'present'), (1, 5, 'late'),
  (2, 1, 'present'), (2, 2, 'present'), (2, 3, 'late'),
  (3, 1, 'present'), (3, 2, 'late')
) as v(slot, n, status)
join pwtest_rank_days r on r.slot = v.slot
join pwtest_dummies d on d.n = v.n
cross join (select id from public.members where nickname = 'pwtestadmin') adm;

-- 단축왕 reads records, not attendance, and only category='meet',
-- subcategory='personal', stroke in the four pool strokes. It builds two lists:
-- within_year (first swim of the year minus the year's best) and yoy_pb (last
-- year's best minus this year's), so the fixture seeds one of each.
--
--   더미01  자유형 50  35.00 → 33.50 this year        within_year, -1.50
--   더미02  배영   50  42.00 last year → 40.50 this   yoy_pb,      -1.50
--   더미03  평영   50  48.00 → 47.00 this year        within_year, -1.00
insert into public.records (
  member_id, category, subcategory, stroke, distance_m,
  event_name, event_date, result_display, result_centiseconds, created_by
)
select d.member_id, 'meet', 'personal', v.stroke, 50,
       v.event_name, v.event_date, v.result_display, v.result_centiseconds, adm.id
from (values
  (1, '자유형', 'pwtest 봄 대회',
      make_date(extract(year from current_date)::int, 3, 2), '35.00', 3500),
  (1, '자유형', 'pwtest 여름 대회',
      make_date(extract(year from current_date)::int, 7, 20), '33.50', 3350),
  (2, '배영', 'pwtest 작년 대회',
      make_date(extract(year from current_date)::int - 1, 6, 15), '42.00', 4200),
  (2, '배영', 'pwtest 여름 대회',
      make_date(extract(year from current_date)::int, 7, 20), '40.50', 4050),
  (3, '평영', 'pwtest 봄 대회',
      make_date(extract(year from current_date)::int, 3, 2), '48.00', 4800),
  (3, '평영', 'pwtest 여름 대회',
      make_date(extract(year from current_date)::int, 7, 20), '47.00', 4700)
) as v(n, stroke, event_name, event_date, result_display, result_centiseconds)
join pwtest_dummies d on d.n = v.n
cross join (select id from public.members where nickname = 'pwtestadmin') adm;

-- ---------------------------------------------------------------------------
-- 나의 성과 · 배지 fixture (0034)
-- ---------------------------------------------------------------------------
-- The dummies above are ranked against each other and never sign in, so none of
-- them can show what 마이페이지 looks like for the person reading it. This block
-- gives pwtestmember — an account that does sign in — enough history for both
-- halves of the achievements screen to render with content rather than with
-- their empty states.
--
-- FIVE attendance marks, deliberately: the badge ladder's first tier is 5회, so
-- four would leave every tile locked and the screen would never exercise the
-- unlocked branch. Three of the five reuse the rank-day activities; two more
-- activities are created here because there is nothing else in the current year
-- to hang them on.
--
-- One of the five is 지각. my_achievement_v1 counts 출석 AND 지각 (0034,
-- following 0016:86-88), so a fixture of five 출석 would pass whether or not
-- that rule holds. With this one, 5회 is reached only if 지각 counts.
insert into public.activities (id, kind, title, activity_date, created_by)
select v.id::uuid, 'training', v.title, v.on_date, adm.id
from (values
  ('99999999-9999-4999-8999-0000000000a1', 'pwtest 성과 훈련 1',
      make_date(extract(year from current_date)::int, 3, 9)),
  ('99999999-9999-4999-8999-0000000000a2', 'pwtest 성과 훈련 2',
      make_date(extract(year from current_date)::int, 3, 16))
) as v(id, title, on_date)
cross join (select id from public.members where nickname = 'pwtestadmin') adm;

insert into public.attendance (activity_id, member_id, status, marked_by)
select v.activity_id::uuid, mem.id, v.status, adm.id
from (values
  ('99999999-9999-4999-8999-999999999991', 'present'),
  ('99999999-9999-4999-8999-999999999992', 'present'),
  ('99999999-9999-4999-8999-999999999993', 'late'),
  ('99999999-9999-4999-8999-0000000000a1', 'present'),
  ('99999999-9999-4999-8999-0000000000a2', 'present')
) as v(activity_id, status)
cross join (select id from public.members where nickname = 'pwtestmember') mem
cross join (select id from public.members where nickname = 'pwtestadmin') adm;

-- Three swims of the same event across two years, so my_achievement_v1 finds
-- exactly TWO PB moments in the current year:
--
--   작년      40.00   baseline, and not itself a moment — nothing precedes it
--   올해 3/9   38.50   moment, old_pb 40.00, down 1.50
--   올해 7/20  37.25   moment, old_pb 38.50, down 1.25
--
-- The second moment's old_pb is the first moment's new_pb, which is the chain
-- that proves the baseline looks back over every earlier day rather than only
-- at the previous calendar year.
insert into public.records (
  member_id, category, subcategory, stroke, distance_m,
  event_name, event_date, result_display, result_centiseconds, created_by
)
select mem.id, 'meet', 'personal', '자유형', 50,
       v.event_name, v.event_date, v.result_display, v.result_centiseconds, adm.id
from (values
  ('pwtest 작년 대회',
      make_date(extract(year from current_date)::int - 1, 6, 15), '40.00', 4000),
  ('pwtest 봄 대회',
      make_date(extract(year from current_date)::int, 3, 9), '38.50', 3850),
  ('pwtest 여름 대회',
      make_date(extract(year from current_date)::int, 7, 20), '37.25', 3725)
) as v(event_name, event_date, result_display, result_centiseconds)
cross join (select id from public.members where nickname = 'pwtestmember') mem
cross join (select id from public.members where nickname = 'pwtestadmin') adm;

commit;

select nickname, status, role from public.members where nickname like 'pwtest%' order by nickname;
