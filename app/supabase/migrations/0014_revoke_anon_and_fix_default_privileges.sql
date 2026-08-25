-- 0014 — take anon off every table in public, and stop the defaults handing it
-- back on the next table anybody creates.
--
-- A full audit after 0013 found ten tables still carrying Supabase's default
-- arwdDxtm grant to anon:
--
--   activities, activity_applications, media_files, media_folders, members,
--   notice_attachments, notice_comments, notices, record_uploads, records
--
-- Nothing leaks through them today, and this is not a leak fix. Every one of
-- the 26 policies in this schema was checked: all of them gate on
-- current_member_id(), is_staff(), is_master_admin() or can_manage_records(),
-- and none evaluates true without a session. current_member_id() is stricter
-- still — it requires status = 'approved', so a signed-in member awaiting
-- approval is as shut out as a stranger. Zero policies admit anon.
--
-- Two things are fixed anyway.
--
-- First the standing grants, because they are the half of the pair that has to
-- stay wrong for a mistake to become a breach. A policy is written once and
-- read by whoever edits it next; a grant is invisible at the point of use. The
-- day somebody adds a read policy and forgets that anon is a role too, the
-- grant is already in place and the leak ships with the feature.
--
-- Second, and this is the actual bug, the default privileges that keep putting
-- it back. 0002 revoked what existed at the time. 0004 then created notices,
-- records, media and chat — and they arrived with anon grants already attached,
-- because ALTER DEFAULT PRIVILEGES had never been touched. That is why the
-- same hole has now been closed three times. Revoking the default is what
-- makes 0015 not have to do this again.
--
-- Only the defaults owned by postgres are altered here: migrations run as
-- postgres, so tables created by this project inherit exactly these. The
-- supabase_admin defaults belong to Supabase's own schemas and are left alone.

revoke all on public.activities             from anon;
revoke all on public.activity_applications  from anon;
revoke all on public.media_files            from anon;
revoke all on public.media_folders          from anon;
revoke all on public.members                from anon;
revoke all on public.notice_attachments     from anon;
revoke all on public.notice_comments        from anon;
revoke all on public.notices                from anon;
revoke all on public.record_uploads         from anon;
revoke all on public.records                from anon;

-- The two views are already clean (anon holds nothing on activity_seats_v or
-- member_public_v after 0010), but say so explicitly so a future re-grant has
-- to be deliberate rather than inherited.
revoke all on public.activity_seats_v from anon;
revoke all on public.member_public_v  from anon;

-- The root cause. Without this, the next `create table` in public arrives with
-- anon holding INSERT/UPDATE/DELETE again.
alter default privileges in schema public revoke all on tables    from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke all on functions from anon;

-- anon keeps exactly one thing: the ability to reach the schema at all, which
-- PostgREST needs to answer a request before deciding it is unauthorised. A
-- request that gets no further than "permission denied for schema public"
-- reports a different error than one denied by RLS, and the login screen reads
-- better for the difference.
grant usage on schema public to anon;
