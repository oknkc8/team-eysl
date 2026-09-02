-- 0036 — a media deletion must not strand its object in the bucket.
--
-- THE DEFECT. Every file deletion leaves an object nobody can ever remove.
-- Measured on the dev project before writing this: five objects in `team-files`,
-- 70 bytes each, no row anywhere pointing at them, and no session — member or
-- 총관리자 — able to see or delete a single one.
--
-- THE MECHANISM is a coupling between two policies that were each written
-- correctly and never read together.
--
--   team_files_read   (0029)  bucket_id = 'team-files'
--                             and current_member_id() is not null
--                             and team_file_is_readable(name)
--   team_files_delete (0021)  bucket_id = 'team-files'
--                             and (foldername[1] = current_member_id() or is_staff())
--
-- team_file_is_readable() answers yes only where some row claims the path. So
-- **the claiming row is the capability to see the object**, and deleteMediaFile()
-- (media/api.ts) removed the row first. After that the object is invisible to
-- everybody, staff included.
--
-- Invisible is the same as undeletable here, and the reason is PostgreSQL rather
-- than storage-api. The storage service deletes with
-- `delete ... where bucket_id = ? and name = any(?) returning *`, and a DELETE
-- whose WHERE and RETURNING read columns has the SELECT policy applied to it as
-- well as the DELETE policy. No visible row, nothing to delete, and the call
-- answers 200 with an empty array — success, having done nothing.
--
-- MEASURED, as a master_admin, on one object, twice, changing one thing:
--
--   claim row deleted first  ->  remove() = []                      object survives
--   claim row still present  ->  remove() = [{...the object...}]     object gone
--
-- Same session, same path, same call. So team_files_delete is not the problem —
-- it permits staff and always did. The read gate is.
--
-- WHY NOT SIMPLY REVERSE THE ORDER. Because "destroy the bytes, then ask
-- permission to drop the record" is not a rule worth having, and a crash between
-- the two steps leaves a row pointing at nothing. It also fixes only the happy
-- path: a folder deletion cascades away rows belonging to several members at
-- once, and nothing about ordering helps there.
--
-- WHAT THIS DOES INSTEAD: mark, then sweep. The claim is not destroyed, it is
-- *transferred* — from media_files to a queue that exists for no other purpose
-- than to keep the object reachable until it is gone. The row disappears from
-- every screen immediately, which is what a deletion means to the person who
-- asked for it; the capability to finish the job outlives it.
--
-- A SEPARATE TABLE RATHER THAN A `deleted_at` COLUMN, for two reasons. A column
-- would have to be filtered out of every read of media_files that exists now and
-- every one written later, and the failure mode of forgetting one is a deleted
-- file reappearing on a screen. And media_files_read is club-wide, so a
-- tombstoned row would keep the object readable by every member; the queue's own
-- policy is owner-or-staff, so a file being deleted becomes *less* readable
-- rather than more.
--
-- ---------------------------------------------------------------------------
-- WHY THE SWEEPER IS NOT A pg_cron JOB. This was the intended design and it
-- cannot work, for a reason worth writing down because the failed version would
-- have looked like a success.
--
-- Supabase installs this on storage.objects, and it is on this project now:
--
--   CREATE TRIGGER protect_objects_delete BEFORE DELETE ON storage.objects
--     FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete()
--   -> 'Direct deletion from storage tables is not allowed. Use the Storage API
--       instead.'  HINT: 'This prevents accidental data loss from orphaned
--       objects.'
--
-- The hint is the whole story. storage.objects is metadata; the bytes live in
-- S3, and only the Storage API deletes both. A cron job can reach the table and
-- cannot reach the bytes. It can even switch the guard off —
-- `set local storage.allow_delete_query = 'true'` — and that is the dangerous
-- version: `select count(*) from storage.objects` would reach zero, the report
-- would say the orphans were swept, and the bytes would still be there, now
-- unreachable by SQL as well as by the app. A false green of exactly the kind
-- this project keeps being caught by.
--
-- So the sweep has to be an HTTP call to the Storage API, carrying a session
-- that satisfies team_files_delete. pg_net and Vault are installed and could
-- carry a service-role key, and an Edge Function could hold one too — but
-- neither can be deployed or verified from this machine (no supabase CLI, no
-- deno), and an unverified sweeper is the thing being argued against above.
--
-- The sweeper is therefore every signed-in session that opens 미디어 or 자료실,
-- and the queue is drained by whoever can act on it: the member whose prefix the
-- object sits under, or any staff member. The limitation this leaves is stated
-- plainly rather than papered over — an entry whose owner never returns sits in
-- the queue until a staff member opens the screen. It is a row somebody can find
-- and a count somebody can read, which is the entire difference from today.
-- ---------------------------------------------------------------------------

-- ------------------------------------------------------------------ the queue

create table if not exists public.pending_object_deletions (
  storage_path text primary key,
  -- Nullable and NOT a foreign key on purpose. The queue has to outlive the
  -- member: e2e/cleanup.sql deletes its fixtures' media_files rows and then the
  -- members themselves, and a cascade here would delete the very entry that
  -- keeps those objects reachable — recreating the defect at teardown. It is
  -- recorded for whoever reads the queue, and nothing depends on it.
  requested_by uuid,
  requested_at timestamptz not null default now()
);

comment on table public.pending_object_deletions is
  '버킷에서 지워야 하는 객체 경로. 행이 사라진 뒤에도 객체를 볼 수 있게 해 주는 유일한 근거다.';
comment on column public.pending_object_deletions.requested_by is
  '삭제를 요청한 회원. 참고용이며 정책은 경로의 첫 세그먼트로 판단한다.';

alter table public.pending_object_deletions enable row level security;

-- Read and delete are the same question — may this caller finish this job? — so
-- they get the same predicate, and it is the one team_files_delete already uses.
-- Anything narrower would let a session see an entry it cannot act on; anything
-- wider would hand somebody a readable object they have no claim to.
--
-- split_part rather than storage.foldername: this is a public-schema table and
-- has no business depending on a helper in somebody else's schema, and the first
-- segment is all either of them looks at.
drop policy if exists pending_object_deletions_read on public.pending_object_deletions;
create policy pending_object_deletions_read on public.pending_object_deletions
  for select to authenticated
  using (
    split_part(storage_path, '/', 1) = public.current_member_id()::text
    or public.is_staff()
  );

-- NO DELETE POLICY EITHER, and this is a correction to the first draft of this
-- migration rather than an original thought. That draft granted DELETE to
-- `authenticated` behind the same predicate as SELECT, on the reasoning that
-- reading an entry and clearing it are the same question. They are not.
--
-- The database never checked that the object had actually gone, so clearing was
-- a promise the client made and the server took on trust. One statement —
-- `DELETE /rest/v1/pending_object_deletions?storage_path=eq.<path>` — put the
-- object back into exactly the unreachable state this migration exists to fix,
-- and a staff session could do it to anybody's object. The people the fix was
-- written for were the people who could undo it.
--
-- clear_object_deletions_v1 below is the only way an entry leaves the queue, and
-- it clears one only when storage.objects no longer holds that path.
--
-- The drop is not decoration. This migration was applied to the dev project in
-- its first form, which created that policy, and a create-less file would have
-- left it standing there — correct on a fresh database and wrong on the one
-- database that actually had the hole. Removing a grant means naming the thing
-- being removed.
drop policy if exists pending_object_deletions_delete on public.pending_object_deletions;

-- NO INSERT POLICY, AND THIS IS THE LOAD-BEARING PART. An entry here grants read
-- access to an object, so a client that could write one could name somebody
-- else's path and mint a signed URL for it — precisely the hole 0029 closed on
-- the message side. Entries are made only by the trigger below, which fires on a
-- row the caller had already been permitted to delete. Same shape as
-- media_folders having no DELETE policy because delete_media_folder_v1 is the
-- only way through, and notice_comments having no INSERT policy because
-- append_notice_comment is.
--
-- No UPDATE policy either: nothing edits an entry, it is created and it is
-- cleared.

-- A table created by postgres in `public` inherits authenticated=arwd from
-- pg_default_acl — INSERT and UPDATE included. The missing policies already
-- refuse both, but a privilege nobody needs is a privilege worth not holding,
-- and the grant is the layer that survives somebody adding a policy later
-- without thinking about this comment.
revoke all on public.pending_object_deletions from public, anon, authenticated;
grant select on public.pending_object_deletions to authenticated;

-- ------------------------------------------------- clearing an entry

-- The only way a queue entry is removed, and the whole of its authority is the
-- one condition a client could not be trusted to check: the object is actually
-- gone from the bucket.
--
-- SECURITY DEFINER because storage.objects is behind team_files_read, and the
-- question here is not "may this caller see the object" but "does it exist" —
-- which is a fact about the bucket, not about the caller. A caller-evaluated
-- version answers "not visible to me" and calls it "absent", and that confusion
-- is the exact family of mistake this project keeps paying for: grep's missing
-- matches, `gh pr list`'s empty array, and an orphan no session could name are
-- all one bug wearing different clothes. Asked as the owner, the answer is the
-- truth rather than a projection of it.
--
-- Authorisation is still the caller's: same predicate the SELECT policy uses, so
-- a member clears their own prefix and staff clear anything, and neither can
-- clear an entry whose object still stands.
--
-- Takes an array and returns what it cleared, so one sweep is one round trip and
-- the caller can count the difference rather than assume it.
create or replace function public.clear_object_deletions_v1(p_paths text[])
returns setof text
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_me    uuid    := public.current_member_id();
  v_staff boolean := public.is_staff();
begin
  if v_me is null then
    raise exception 'not an approved member' using errcode = '42501';
  end if;

  return query
  delete from public.pending_object_deletions q
   where q.storage_path = any(p_paths)
     and (split_part(q.storage_path, '/', 1) = v_me::text or v_staff)
     and not exists (
       select 1 from storage.objects o
        where o.bucket_id = 'team-files' and o.name = q.storage_path
     )
  returning q.storage_path;
end $$;

comment on function public.clear_object_deletions_v1(text[]) is
  '객체가 실제로 사라진 대기열 항목만 지우고, 지운 경로를 돌려준다. 대기열에서 항목을 빼는 유일한 경로.';

-- ------------------------------------------------- the claim changes hands

-- A TRIGGER RATHER THAN A DELETE RPC. Every path that removes a media_files row
-- has to enqueue, and there are more of them than a rewrite of deleteMediaFile()
-- would cover: the browser's own DELETE, delete_media_folder_v1's bulk delete,
-- the ON DELETE CASCADE from media_folders, e2e/cleanup.sql, and whatever gets
-- written next. Routing them all through one function means remembering; a
-- trigger means the invariant holds whether anybody remembered or not.
create or replace function public.enqueue_object_deletion()
returns trigger
language plpgsql volatile security definer set search_path = public
as $$
begin
  -- Another table may still claim this exact path, and then the object is not
  -- garbage — it is theirs. Only media_files rows reach this trigger, but the
  -- shape of a path is a convention rather than a constraint, so the question is
  -- asked rather than assumed.
  if exists (select 1 from public.notice_attachments where storage_path = old.storage_path)
     or exists (select 1 from public.messages where attachment_path = old.storage_path)
     or exists (select 1 from public.record_uploads where storage_path = old.storage_path) then
    return null;
  end if;

  insert into public.pending_object_deletions (storage_path, requested_by)
  values (old.storage_path, public.current_member_id())
  on conflict (storage_path) do nothing;

  return null;
end $$;

comment on function public.enqueue_object_deletion() is
  'media_files 행이 사라지면 그 객체를 삭제 대기열에 올린다. 행이 사라진 뒤에도 객체가 보이도록 하는 장치.';

drop trigger if exists media_files_enqueue_object_deletion on public.media_files;
create trigger media_files_enqueue_object_deletion
  after delete on public.media_files
  for each row execute function public.enqueue_object_deletion();

-- The mirror image, and it closes a real hazard rather than tidying up. Delete a
-- file, then upload a new one that lands on the same path: without this the
-- stale queue entry survives, and the next sweep deletes the object out from
-- under a row that legitimately claims it. A path that is claimed again is a
-- path that must not be swept.
create or replace function public.release_object_deletion()
returns trigger
language plpgsql volatile security definer set search_path = public
as $$
begin
  delete from public.pending_object_deletions where storage_path = new.storage_path;
  return null;
end $$;

comment on function public.release_object_deletion() is
  '같은 경로를 다시 가리키는 media_files 행이 생기면 삭제 대기열에서 뺀다.';

drop trigger if exists media_files_release_object_deletion on public.media_files;
create trigger media_files_release_object_deletion
  after insert on public.media_files
  for each row execute function public.release_object_deletion();

-- --------------------------------------------------------- the read gate

-- 0029's function with one arm added, copied from that file rather than
-- rewritten from a description of it — the whole predicate is the security
-- boundary and re-deriving it is how an arm goes missing.
--
-- SECURITY INVOKER is preserved, and it is why the new arm needs no thought
-- about who may see what: the queue's own RLS answers, exactly as media_files'
-- and messages' do for theirs. An object being deleted is readable by the
-- people who can finish deleting it, and by nobody else.
-- record_uploads is the fourth claim table and 0029 did not list it. Its
-- storage_path (0004:53) is a legitimate team-files reference — 결과지, the meet
-- result sheets the record importer reads — and every place in this file that
-- asks "does any row claim this path?" has to know about it or the answer is
-- wrong in the direction that deletes things.
--
-- NOTHING IS AT RISK TODAY, and saying so is the point rather than a hedge:
-- `select count(*) from public.record_uploads` is 0, the rebuild has no upload
-- feature (record_uploads appears in app/src only in the generated types), and
-- media_object_is_claimed (0021) checks media_files alone, so team_files_insert
-- would refuse such an object anyway. This is a landmine, not a live defect.
--
-- WHY IT WAS INVISIBLE, which is the part worth remembering: the table is empty
-- on dev, so every test of the adoption clause passes whether or not it knows
-- about record_uploads. An empty table cannot fail a test about non-empty ones.
--
-- FOR WHOEVER BUILDS 결과지 UPLOAD: widening media_object_is_claimed is not
-- enough on its own. Widen it, and this predicate, and the adoption select
-- below, together — widening only the insert gate means the first result sheet
-- uploaded is classified as debris by the very next sweep.
--
-- AND THAT LIST WAS INCOMPLETE, which 0040 found the hard way. Those four are
-- about RECOGNISING a claim. They say nothing about the LIFECYCLE, and a claim
-- table also needs the enqueue and release TRIGGERS or its rows can disappear
-- without queueing their object. 0040 added notice_attachments and hit exactly
-- that: a notice and a message claiming one path, delete the notice and the
-- guard correctly skips because the message claims it, delete the message and
-- nothing fires — no row, no queue entry, an object nobody can reach.
--
-- So the rule is FIVE places, not four: the claim gate, this predicate, the
-- adoption select, the enqueue trigger, and the release trigger. 0040 put
-- triggers on all four claim tables, so a new one only has to join the list.
--
-- The arm stays narrow on its own account: record_uploads_read is
-- can_manage_records() (0004:208), and this function is SECURITY INVOKER, so a
-- result sheet is readable by the people who may manage records and by nobody
-- else. Adding it widens the bucket for staff, not for the club.
create or replace function public.team_file_is_readable(p_path text)
returns boolean
language sql stable security invoker set search_path = public
as $$
  select p_path is not null
     and (
       exists (select 1 from public.media_files
                where storage_path = p_path)
       or exists (select 1 from public.notice_attachments
                   where storage_path = p_path)
       or exists (select 1 from public.messages
                   where attachment_path = p_path)
       or exists (select 1 from public.record_uploads
                   where storage_path = p_path)
       or exists (select 1 from public.pending_object_deletions
                   where storage_path = p_path)
     )
$$;

comment on function public.team_file_is_readable(text) is
  '이 호출자가 해당 경로를 가리키는 행을 볼 수 있는지. SECURITY INVOKER라서 각 테이블의 RLS가 그대로 답한다. 삭제 대기열도 포함한다.';

-- ---------------------------------------------------- folder deletion, again

-- 0021's function verbatim except for the comment inside it — restated because
-- CREATE OR REPLACE rewrites the whole body, and reconstructing one from memory
-- is how 0024 lost a parameter. Read out of 0021 and confirmed identical to
-- pg_get_functiondef on the live project before editing.
--
-- No enqueue call is added here. The bulk `delete from public.media_files` now
-- fires the trigger once per row, so the paths this returns are already queued
-- by the time it returns them.
create or replace function public.delete_media_folder_v1(p_folder_id uuid)
returns setof text
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_me     uuid := public.current_member_id();
  v_folder public.media_folders%rowtype;
  v_paths  text[];
begin
  if v_me is null then
    raise exception 'not an approved member' using errcode = '42501';
  end if;

  select * into v_folder from public.media_folders where id = p_folder_id for update;
  if not found then
    raise exception 'no such folder' using errcode = '42704';
  end if;

  -- Owner only, matching canManageMediaOwner (upstream:2930). Staff are not an
  -- exception here because he removed that exception.
  if v_folder.created_by <> v_me then
    raise exception 'not your folder' using errcode = '42501';
  end if;

  -- Explicit rather than left to the cascade: the cascade would delete these
  -- rows without telling anyone which objects they pointed at, and those objects
  -- are exactly what the caller has to clean up afterwards. Each delete also
  -- fires media_files_enqueue_object_deletion, so the objects stay reachable to
  -- whoever can remove them even after this transaction commits.
  with gone as (
    delete from public.media_files where folder_id = p_folder_id returning storage_path
  )
  select coalesce(array_agg(storage_path), '{}') into v_paths from gone;

  delete from public.media_folders where id = p_folder_id;

  return query select unnest(v_paths);
end $$;

comment on function public.delete_media_folder_v1(uuid) is
  '폴더와 그 안의 파일 행을 한 트랜잭션에서 지우고, 버킷에서 지워야 할 객체 경로를 돌려준다. 폴더 주인만 호출할 수 있다.';

-- ------------------------------------------------ adopt what is already lost

-- The five objects this migration was written for, plus anything else the same
-- defect stranded before it. They have no row of any kind, so no session can see
-- them and nothing in the app could ever have reached them; giving each a queue
-- entry is what makes them visible to a sweeper for the first time.
--
-- Sound because 0021 made it sound: team_files_insert admits an object only
-- where a media_files row already claims the path, so an object no table claims
-- cannot be anything but debris. Idempotent, and a no-op on a fresh database.
--
-- requested_by is null — nobody asked for these, they are the bill for a defect.
-- All four claim tables, not three. record_uploads is the one 0029 forgot, and
-- an adoption select that forgets it does not merely fail to help — it queues a
-- live 결과지 for deletion. See the note on team_file_is_readable above.
insert into public.pending_object_deletions (storage_path, requested_by)
select o.name, null
  from storage.objects o
 where o.bucket_id = 'team-files'
   and not exists (select 1 from public.media_files        f where f.storage_path    = o.name)
   and not exists (select 1 from public.notice_attachments a where a.storage_path    = o.name)
   and not exists (select 1 from public.messages           m where m.attachment_path = o.name)
   and not exists (select 1 from public.record_uploads     r where r.storage_path    = o.name)
on conflict (storage_path) do nothing;

-- ------------------------------------------------------------- execute rights
-- By name, not from PUBLIC alone: 0002's expire_stale_offers ended up
-- anonymously callable exactly that way, and 0014 traced it to default
-- privileges rather than to the revoke.
--
-- The two trigger functions are granted to nobody. A trigger function is invoked
-- by the executor, not by the caller, so EXECUTE is not needed for the triggers
-- to fire — and withholding it is what stops a client calling
-- enqueue_object_deletion() directly, which is the one way a browser could
-- otherwise forge the read capability the queue confers.
revoke all on function public.enqueue_object_deletion() from public, anon, authenticated;
revoke all on function public.release_object_deletion() from public, anon, authenticated;

revoke all on function public.clear_object_deletions_v1(text[]) from public, anon, authenticated;
grant execute on function public.clear_object_deletions_v1(text[]) to authenticated;

-- Unchanged from 0029/0021, restated because CREATE OR REPLACE keeps the
-- existing ACL and a reader should not have to know that to be sure.
revoke all on function public.team_file_is_readable(text) from public, anon, authenticated;
grant execute on function public.team_file_is_readable(text) to authenticated;

revoke all on function public.delete_media_folder_v1(uuid) from public, anon, authenticated;
grant execute on function public.delete_media_folder_v1(uuid) to authenticated;
