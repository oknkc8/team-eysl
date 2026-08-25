-- Removes every row seed.sql creates, and nothing else.
--
-- The dev database is shared with other agents, so the `pwtest` prefix is the
-- whole contract: this file matches on it and never on a broader predicate.
-- seed.sql runs this first, so a crashed session can be reseeded without
-- colliding on the members_nickname_lower_uq index.
--
-- Run with:  bash scripts/psql.sh -v ON_ERROR_STOP=1 -f e2e/cleanup.sql

-- Nine foreign keys onto members are ON DELETE NO ACTION, so anything a test
-- account authored has to go before the account does or the delete raises 23503.
-- The suite is almost entirely read-only, but a flow test that files a notice or
-- an activity would otherwise wedge every later cleanup.
create temporary table pwtest_member_ids as
select id from public.members where nickname like 'pwtest%';

delete from public.notice_comments where member_id in (select id from pwtest_member_ids);
delete from public.notices where created_by in (select id from pwtest_member_ids);
delete from public.messages
where sender_id in (select id from pwtest_member_ids)
   or recipient_id in (select id from pwtest_member_ids);
delete from public.records where created_by in (select id from pwtest_member_ids);
delete from public.record_uploads where uploaded_by in (select id from pwtest_member_ids);
delete from public.media_files where uploader_id in (select id from pwtest_member_ids);
delete from public.media_folders where created_by in (select id from pwtest_member_ids);
delete from public.attendance where marked_by in (select id from pwtest_member_ids);
delete from public.activities where created_by in (select id from pwtest_member_ids);

-- members before auth.users: members_auth_user_id_fkey is ON DELETE SET NULL, so
-- dropping the users first would strand the member rows with a null link instead
-- of removing them.
delete from public.members where id in (select id from pwtest_member_ids);

drop table pwtest_member_ids;

delete from auth.identities
where user_id in (select id from auth.users where email like 'pwtest%@eysl.local');

delete from auth.users where email like 'pwtest%@eysl.local';
