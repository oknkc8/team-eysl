-- Removes every row seed.sql creates, and nothing else.
--
-- The dev database is shared with other agents and now also holds the real club
-- roster, so what this file matches on is a safety property rather than a
-- convenience. seed.sql runs it first, so a crashed session can be reseeded
-- without colliding on the members_nickname_lower_uq index.
--
-- Run with:  bash scripts/psql.sh -v ON_ERROR_STOP=1 -f e2e/cleanup.sql
--
-- WHY FIXED IDS RATHER THAN `nickname like 'pwtest%'`.
--
-- The prefix was doing load-bearing work it was never designed for. It meant
-- "test-owned, delete it and everything filed against it" — and it decided that
-- from a *nickname*, which is real club data the president maintains in the
-- master workbook. One nickname edit, or one importer that failed to refuse the
-- prefix, and a real member plus their whole attendance and record history would
-- be deleted by the next Playwright run. Silently, because cleanup removing rows
-- is cleanup working.
--
-- The importer now refuses the prefix outright (scripts/import/parse.ts,
-- ReservedNicknameError). This is the other half: cleanup no longer infers
-- ownership from a name at all. It names the exact rows seed.sql creates.
--
-- Safe to be this strict because seed.sql wraps cleanup and its own inserts in
-- a single transaction, so there is no partial state for a looser predicate to
-- mop up — a failed seed rolls back rather than stranding half a fixture.
--
-- Keep this list in step with seed.sql's pwtest_accounts and pwtest_dummies.

-- Nine foreign keys onto members are ON DELETE NO ACTION, so anything a test
-- account authored has to go before the account does or the delete raises 23503.
-- The suite is almost entirely read-only, but a flow test that files a notice or
-- an activity would otherwise wedge every later cleanup.
create temporary table pwtest_member_ids (id uuid primary key);

-- The four sign-in accounts, at the ids fixtures.ts imports.
insert into pwtest_member_ids (id) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),  -- pwtestadmin
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),  -- pwtestmember
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),  -- pwtestpending
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd');  -- pwtestmember2

-- The twelve roster/waitlist/ranking dummies, built by the same expression
-- seed.sql uses so the two cannot drift apart silently.
insert into pwtest_member_ids (id)
select ('e0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
from generate_series(1, 12) as n;

-- Captured before the member rows go, because auth_user_id is the only link
-- from a seeded member to the auth.users row 0027's trigger created for it.
create temporary table pwtest_auth_ids as
select m.auth_user_id as id
  from public.members m
 where m.id in (select id from pwtest_member_ids)
   and m.auth_user_id is not null;

delete from public.notice_comments where member_id in (select id from pwtest_member_ids);
delete from public.notices where created_by in (select id from pwtest_member_ids);
delete from public.messages
where sender_id in (select id from pwtest_member_ids)
   or recipient_id in (select id from pwtest_member_ids);
-- Both columns, not just created_by. A record is filed *against* a member by
-- somebody else — that is the whole shape of 기록 추가 — so a row whose author is
-- outside the prefix can still be a pwtest member's record, and deleting the
-- member without it raises 23503 on records_member_id_fkey.
delete from public.records
where created_by in (select id from pwtest_member_ids)
   or member_id in (select id from pwtest_member_ids);
delete from public.record_uploads where uploaded_by in (select id from pwtest_member_ids);
delete from public.media_files where uploader_id in (select id from pwtest_member_ids);
delete from public.media_folders where created_by in (select id from pwtest_member_ids);
-- Same reasoning: marked_by is the staffer who tapped, member_id is who was
-- marked, and the write suite creates rows where only the second is ours.
delete from public.attendance
where marked_by in (select id from pwtest_member_ids)
   or member_id in (select id from pwtest_member_ids);
-- Applications onto activities we did not create. The suite only applies to its
-- own fixtures, where the activity delete below cascades — this is the belt to
-- that braces, so a test that ever points at a club activity cannot strand a row
-- and wedge every later cleanup.
delete from public.activity_applications where member_id in (select id from pwtest_member_ids);
delete from public.activities where created_by in (select id from pwtest_member_ids);

-- members before auth.users: members_auth_user_id_fkey is ON DELETE SET NULL, so
-- dropping the users first would strand the member rows with a null link instead
-- of removing them.
delete from public.members where id in (select id from pwtest_member_ids);

-- auth rows by the ids captured above, plus the seeded email shape as a belt.
--
-- Two predicates because they fail in different directions. The id list misses
-- an auth.users row whose member is already gone; the email pattern catches
-- that, and auth.users.email is UNIQUE, so a stranded row would otherwise make
-- the next seed collide on an address rather than on a nickname.
--
-- The email predicate stays narrow ON PURPOSE. `@eysl.local` alone is NOT safe:
-- the dev database's own 관리자 account uses that domain, and it is the
-- master_admin recorded as marked_by on every imported attendance row. Deleting
-- it would either wedge cleanup on a foreign key or take the club register with
-- it. `pwtest%@eysl.local` is a shape only seed.sql produces.
delete from auth.identities
where user_id in (select id from pwtest_auth_ids)
   or user_id in (select id from auth.users where email like 'pwtest%@eysl.local');

delete from auth.users
where id in (select id from pwtest_auth_ids)
   or email like 'pwtest%@eysl.local';

drop table pwtest_auth_ids;
drop table pwtest_member_ids;
