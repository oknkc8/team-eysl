-- Removes every row seed.sql creates, and nothing else.
--
-- The dev database is shared with other agents and now also holds the real club
-- roster, so what this file matches on is a safety property rather than a
-- convenience. seed.sql runs it first, so a crashed session can be reseeded
-- without colliding on the members_nickname_lower_uq index.
--
-- Run with:  bash scripts/psql.sh -v ON_ERROR_STOP=1 -f e2e/cleanup.sql
--
-- WHY FIXED IDS RATHER THAN `nickname like ('pwtest' || :'ns' || '%')`.
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
\getenv ns PWTEST_NS
\if :{?ns}
\else
\set ns ''
\endif

-- REFUSED RATHER THAN DEFAULTED, and this is the only silent failure this
-- design has. An empty namespace is not a harmless fallback: every worktree
-- would seed and delete the SAME ids again, which is exactly the collision
-- this file was namespaced to end -- and it would look like it worked.
select case when btrim(:'ns') = '' then 'true' else 'false' end as ns_missing \gset
\if :ns_missing
\echo ''
\echo 'PWTEST_NS is not set.'
\echo 'Run `npm run test:e2e`, which derives it from the worktree path, or export'
\echo 'one yourself (six hex characters) before running this file by hand.'
select 'PWTEST_NS is not set'::int;
\endif

-- Dynamic signup accounts are owned by exact ids written locally by the test
-- that created them. Empty is valid; malformed input must fail before deletes.
\getenv owned_member_ids PWTEST_OWNED_SIGNUP_MEMBER_IDS
\if :{?owned_member_ids}
\else
\set owned_member_ids ''
\endif
\getenv owned_auth_ids PWTEST_OWNED_SIGNUP_AUTH_IDS
\if :{?owned_auth_ids}
\else
\set owned_auth_ids ''
\endif

create temporary table pwtest_member_ids (id uuid primary key);

-- The six sign-in accounts, at the ids fixtures.ts imports.
insert into pwtest_member_ids (id) values
  (('aa' || :'ns' || '-aaaa-4aaa-8aaa-aaaaaaaaaaaa')::uuid),  -- pwtestadmin
  (('bb' || :'ns' || '-bbbb-4bbb-8bbb-bbbbbbbbbbbb')::uuid),  -- pwtestmember
  (('cc' || :'ns' || '-cccc-4ccc-8ccc-cccccccccccc')::uuid),  -- pwtestpending
  (('dd' || :'ns' || '-dddd-4ddd-8ddd-dddddddddddd')::uuid),  -- pwtestmember2
  (('0f' || :'ns' || '-0000-4000-8000-000000000001')::uuid),  -- pwtest 명단 회원 (no login)
  -- Named here even though the signup block further down would also reach them
  -- through the pwtest%@eysl.local auth join. That reach is incidental — it
  -- exists for accounts whose ids are random because a button made them — and
  -- leaning on it for a fixture whose id we chose ourselves would be depending
  -- on a coincidence. These two are seeded exactly like the four above, so they
  -- are removed exactly like the four above.
  (('ee' || :'ns' || '-eeee-4eee-8eee-eeeeeeeeeeee')::uuid),  -- pwtestrejected
  (('ff' || :'ns' || '-ffff-4fff-8fff-ffffffffffff')::uuid);  -- pwtestblocked

-- The twelve roster/waitlist/ranking dummies, built by the same expression
-- seed.sql uses so the two cannot drift apart silently.
insert into pwtest_member_ids (id)
select ('e0' || :'ns' || '-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
from generate_series(1, 12) as n;

-- Accounts signup.spec.ts creates after seed have random ids. Their ids arrive
-- from the local ownership ledger, not from a nickname or email shape: people
-- own those strings, whereas this run owns only the records it wrote down.
insert into pwtest_member_ids (id)
select btrim(entry.id)::uuid
  from regexp_split_to_table(:'owned_member_ids', ',') as entry(id)
 where btrim(entry.id) <> ''
on conflict (id) do nothing;

-- Captured before the member rows go, because auth_user_id is the only link
-- from a seeded member to the auth.users row 0027's trigger created for it.
create temporary table pwtest_auth_ids (id uuid primary key);

insert into pwtest_auth_ids (id)
select m.auth_user_id as id
  from public.members m
 where m.id in (select id from pwtest_member_ids)
   and m.auth_user_id is not null
on conflict (id) do nothing;

-- A member row could already be gone when an interrupted run resumes. Its Auth
-- id is still explicit in the same ledger, so remove it without guessing from
-- its email address.
insert into pwtest_auth_ids (id)
select btrim(entry.id)::uuid
  from regexp_split_to_table(:'owned_auth_ids', ',') as entry(id)
 where btrim(entry.id) <> ''
on conflict (id) do nothing;

-- The case the arm above deliberately does not cover, made loud instead of silent.
--
-- A pwtest staffer marking a REAL member on a REAL activity leaves a row this file
-- must not delete (it may be the club's) and cannot leave (attendance_marked_by_fkey
-- is ON DELETE NO ACTION, so the members delete below would fail with a bare 23503
-- naming a constraint instead of the problem). Neither outcome should be reached by
-- accident, so refuse here with a sentence that says what to do.
--
-- The real fix is upstream and belongs to seed.sql: there is no login-less member
-- fixture, so any test that touches the 명단 추가 panel reaches the 36 real members.
-- Until that fixture exists, this check is what stands between a stray tap and the
-- club register.
do $$
declare n int;
begin
  select count(*) into n
    from public.attendance a
   where a.marked_by in (select id from pwtest_member_ids)
     and a.member_id not in (select id from pwtest_member_ids)
     and a.activity_id not in (select id from public.activities
                               where created_by in (select id from pwtest_member_ids));
  if n > 0 then
    raise exception
      'cleanup refuses: % attendance row(s) are the club''s but were last marked by a pwtest account. A test marked a real member on a real activity. Deleting them would destroy real data and leaving them wedges the members delete. Fix the test, then repair marked_by on those rows by hand.', n;
  end if;
end $$;

delete from public.notice_comments where member_id in (select id from pwtest_member_ids);
delete from public.notices where created_by in (select id from pwtest_member_ids);
-- board_posts.author_id is NOT NULL and carries no cascade (0033), so a post a
-- pwtest member wrote raises 23503 on the members delete below and wedges the
-- whole teardown — including the auth.users rows, whose email is UNIQUE, so the
-- next run would then fail to seed at all. One statement, and it has to be here
-- rather than "when the board suite runs": teardown is shared.
delete from public.board_posts where author_id in (select id from pwtest_member_ids);
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
-- These two delete rows, not bucket objects, and that used to be a leak: an
-- object whose media_files row is gone is invisible to every session (0036
-- explains the mechanism), so nothing could ever remove it. The suite uploads
-- nothing today, which is the only reason it has not been paying for one.
--
-- 0036 makes the leak survivable rather than silent — media_files_enqueue_object
-- _deletion queues each storage_path as its row goes, and the queue entry keeps
-- the object reachable — but it does not close it here. psql cannot finish the
-- job: storage.protect_delete() refuses a direct DELETE from storage.objects,
-- and going around it would drop the metadata and leave the bytes in S3.
--
-- So the objects leave the queue when a staff session next opens 미디어, not at
-- teardown. WHOEVER ADDS A MEDIA-UPLOAD TEST should close it properly instead:
-- sweep through the Storage API as pwtestadmin after the media_files delete and
-- before the members delete below, because after that the only account that
-- could have swept is gone.
delete from public.media_files where uploader_id in (select id from pwtest_member_ids);
delete from public.media_folders where created_by in (select id from pwtest_member_ids);
-- REFUSE RATHER THAN DESTROY. This used to delete on `marked_by in (ours)` too,
-- with the reasoning that marked_by is the staffer who tapped and the write suite
-- creates rows where only member_id is ours. That reasoning is true about rows the
-- suite CREATES and false about rows it UPDATES, and attendance_mark_v1 cannot tell
-- you which happened:
--
--     on conflict (activity_id, member_id) do update
--       set ..., marked_by = excluded.marked_by
--
-- A pwtest staff account tapping a member who was ALREADY marked rewrites marked_by
-- on a row the club owns. The row then looks like ours, and this predicate deleted it.
--
-- HOW FAR THAT IS ESTABLISHED, because the two halves are not equally proven.
-- Fifteen real attendance rows ARE gone -- 249 on 2026-08-26 against 234 now, with
-- members, no_login and with_login identical in both snapshots, so neither reading
-- was taken mid-run (a run would show 11 with_login, not 5) and no member was
-- removed. The split matches too: 198 -> 188 for members who never log in, 51 -> 46
-- for those who do, and 10 + 5 = 15.
--
-- The MECHANISM above is verified by construction and has not been shown to be what
-- took them. Every attendance-writing spec was read afterwards and all of them mark
-- a fixture member on a fixture activity, so this path has no live trigger today.
-- The route those fifteen rows took is unknown; a deleted activity cascading is the
-- likelier candidate and was not confirmed. Arithmetic proves the loss. It does not
-- name the cause, and this comment used to claim it did.
--
-- The change stands anyway, because the hazard is real and cheap to close, and
-- because the fixture work now in flight -- a login-less member fixture, so tests
-- stop reaching the 36 real ones -- is what would give this path its first trigger.
--
-- So key on what the row IS, not on who last touched it. member_id and activity_id
-- are identity and no foreign write can change them; marked_by is a mutable column
-- another statement can stamp.
--
-- Both arms below are strictly redundant -- attendance_member_id_fkey and
-- attendance_activity_id_fkey are both ON DELETE CASCADE, so the members and
-- activities deletes further down would take these rows anyway. They stay because
-- they say out loud which rows this file considers its own, and because a future
-- change to either FK would otherwise silently widen what cleanup leaves behind.
delete from public.attendance
where member_id in (select id from pwtest_member_ids)
   or activity_id in (select id from public.activities
                      where created_by in (select id from pwtest_member_ids));

-- Applications onto activities we did not create. The suite only applies to its
-- own fixtures, where the activity delete below cascades — this is the belt to
-- that braces, so a test that ever points at a club activity cannot strand a row
-- and wedge every later cleanup.
delete from public.activity_applications where member_id in (select id from pwtest_member_ids);
-- Same reasoning as activity_applications above: activity_comments.activity_id
-- cascades when its own activity goes, but a pwtest member's comment on a real
-- club activity would not, and member_id has no cascade at all (0050).
delete from public.activity_comments where member_id in (select id from pwtest_member_ids);
delete from public.activities where created_by in (select id from pwtest_member_ids);

-- members before auth.users: members_auth_user_id_fkey is ON DELETE SET NULL, so
-- dropping the users first would strand the member rows with a null link instead
-- of removing them.
delete from public.members where id in (select id from pwtest_member_ids);

-- The auth side follows the same explicit id list. Do not add an email fallback:
-- a nickname-derived address belongs to the person who registered it, not to an
-- arbitrary later Playwright run.
delete from auth.identities
where user_id in (select id from pwtest_auth_ids);

delete from auth.users
where id in (select id from pwtest_auth_ids);

-- The signup rate limiter's bookkeeping, which the suite fills and nothing else
-- empties.
--
-- WHY THIS BELONGS TO CLEANUP, AND ON WHAT GROUNDS. Not foreign-key ordering:
-- signup_attempt_quota has no FK to members at all (0028:84 — the key is a
-- client IP, not a member), so it can never block the members delete above, and
-- justifying it that way would fall apart on the first look. The grounds are
-- narrower and hold: signup.spec.ts drives real signups, every one of them
-- writes here, and this is residue the suite created. A suite that cleans up
-- after itself cleans this up too.
--
-- UNCONDITIONAL, AND NOT "the two keys". The rows are keyed by
-- signup_client_key() — the client IP — and our traffic does not leave by one
-- address. Two keys were observed at first and a third appeared later the same
-- day, so any predicate naming a count would have gone stale within hours. All
-- rows on this database are ours: dev has no real members signing up, and
-- scripts/_env.sh is what keeps this pointed away from production.
--
-- THAT GUARD IS LOAD-BEARING. If _env.sh ever stops refusing a production ref,
-- this delete stops being safe — it would clear a real person's rate-limit
-- window, which is a security control and not bookkeeping. Revisit this
-- statement if that changes.
delete from public.signup_attempt_quota;

drop table pwtest_auth_ids;
drop table pwtest_member_ids;
