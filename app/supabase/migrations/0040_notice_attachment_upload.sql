-- 0040 — 공지 첨부파일 올리기: the write half that was never built.
--
-- ============================================================================
-- WHAT ALREADY EXISTS, WHICH IS MORE THAN IT LOOKS
-- ============================================================================
--
-- notice_attachments has been a table since 0004, its read policy admits every
-- approved member, and team_file_is_readable (0029, widened in 0036) already
-- names it. Members can SEE an attachment. Nothing in the app can create one,
-- so every notice shows 첨부 0 forever.
--
-- The row half is also already correct, and this migration does not touch it.
-- Measured against the live policy rather than assumed:
--
--   notice_attachments_write  ALL
--     USING       is_staff()
--     WITH CHECK  is_staff() AND is_my_team_file_path(storage_path)
--
-- Staff, writing under their own member id. Note the function: it is
-- is_my_team_file_path (`^<me>/[^/]`), NOT is_my_media_object_path. The two are
-- different and only the second is library-restricted, so a path shaped
-- `<me>/notices/<name>` already satisfies the table policy today.
--
-- ============================================================================
-- WHAT ACTUALLY BLOCKS AN UPLOAD: the storage policy, on both halves
-- ============================================================================
--
--   team_files_insert  WITH CHECK
--     bucket_id = 'team-files'
--     AND is_my_media_object_path(name)
--     AND media_object_is_claimed(name)
--
-- Each half refuses a notice attachment independently, which is why widening
-- one of them would have looked like progress and produced nothing:
--
--   is_my_media_object_path   `notices` is not in (media|resources)
--   media_object_is_claimed   looks at media_files only; a notice_attachments
--                             row does not count as a claim
--
-- ============================================================================
-- THE ORDERING THIS FORCES, AND WHY IT IS KEPT
-- ============================================================================
--
-- media_object_is_claimed means the ROW MUST EXIST BEFORE THE OBJECT. That is
-- 0021's whole design — the bucket may not hold bytes nothing points at — and
-- it is worth more than the convenience it costs. notice_attachments.notice_id
-- is NOT NULL, so the chain is forced:
--
--   save the notice  ->  insert the attachment row  ->  upload the object
--
-- An unsaved notice therefore cannot carry an attachment, and the screen has to
-- say so rather than pretend. Relaxing the claim gate to allow it would reopen
-- exactly the hole 0021 closed, for a form-flow nicety.
--
-- ============================================================================
-- THE FOUR PLACES, AND WHY ONLY TWO OF THEM MOVE
-- ============================================================================
--
-- 0036 left an instruction for whoever widens the claim gate: widen
-- media_object_is_claimed, team_file_is_readable, the enqueue trigger's guard
-- and the adoption select TOGETHER, because widening only the insert gate makes
-- the first uploaded file get classified as debris by the very next sweep.
--
-- That instruction was written for 결과지/record_uploads. For notice
-- attachments two of the four already know about the table, because
-- notice_attachments predates 0036 by thirty-two migrations:
--
--   media_object_is_claimed   media_files only          -> WIDENED HERE
--   team_file_is_readable     already names it          -> untouched, on purpose
--   enqueue trigger guard     already names it          -> widened the OTHER way
--   adoption select           already names it          -> untouched, on purpose
--
-- Leaving two of them alone is a decision, not an omission, and it is recorded
-- here so the next reader does not "fix" a function that is already right.

-- ------------------------------------------------------------ the path shape
-- A third library beside media and resources. Everything else about the shape
-- is 0021's and stays: the caller's own member id, one library segment, and a
-- file name with no separator in it, anchored at both ends.
--
-- `notices` rather than `notice-attachments` because path.ts already builds two
-- segments from a short lowercase word, and a third spelling style would be a
-- thing to remember.
create or replace function public.is_my_media_object_path(p_path text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select p_path is not null
     and public.current_member_id() is not null
     and p_path ~ ('^' || public.current_member_id()::text || '/(media|resources|notices)/[^/]+$')
$$;

comment on function public.is_my_media_object_path(text) is
  '경로가 <내 member id>/(media|resources|notices)/<파일명> 형태인지. 테이블 정책과 스토리지 정책이 함께 쓴다.';

-- ----------------------------------------------------------- the claim gate
-- The second arm. Without it the storage policy refuses an object whose
-- notice_attachments row already exists, which is the only order the row can be
-- created in.
--
-- SECURITY DEFINER is preserved and is why the new arm needs no thought about
-- who may see what: the question is "does any row claim this path", not "may
-- you read that row". notice_attachments_write already decided who may put a
-- claim there, and it is staff.
create or replace function public.media_object_is_claimed(p_path text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.media_files where storage_path = p_path)
      or exists (select 1 from public.notice_attachments where storage_path = p_path)
$$;

comment on function public.media_object_is_claimed(text) is
  '해당 경로를 가리키는 media_files 또는 notice_attachments 행이 이미 있는지. 버킷에 행 없는 객체가 생기는 것을 막는다.';

-- ------------------------------------------------------ deletion, both ways
-- notices -> notice_attachments is ON DELETE CASCADE (0004), so deleting a
-- notice ALREADY destroys its attachment rows. Without an enqueue trigger the
-- objects are stranded — the identical defect 0036 fixed for media_files, and
-- it is latent rather than absent only because no screen could create an
-- attachment until now. 0036 called record_uploads "a landmine, not a live
-- defect"; this is the same landmine, and building the upload screen is what
-- steps on it.
--
-- THE GUARD IS WIDENED IN THE OTHER DIRECTION, and this is the part that would
-- be easy to miss. 0036's guard asks whether notice_attachments, messages or
-- record_uploads still claim the path — correct for a trigger on media_files,
-- and incomplete the moment the same function also runs on notice_attachments,
-- because then nothing asks about media_files. Two tables claiming one path is
-- unusual, but "unusual" is the wrong standard for a function whose failure
-- mode is deleting a file somebody still owns.
--
-- Asking about all four covers both triggers. For the table the row was deleted
-- from, the row is already gone at AFTER DELETE time, so the exists() over its
-- own table asks the right question: does a SIBLING row still claim this path?
create or replace function public.enqueue_object_deletion()
returns trigger
language plpgsql volatile security definer set search_path = public
as $$
begin
  -- Another table -- or another row of this one -- may still claim this exact
  -- path, and then the object is not garbage, it is theirs.
  if exists (select 1 from public.media_files where storage_path = old.storage_path)
     or exists (select 1 from public.notice_attachments where storage_path = old.storage_path)
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
  'media_files 또는 notice_attachments 행이 사라지면 그 객체를 삭제 대기열에 올린다. 다른 표가 같은 경로를 아직 주장하면 올리지 않는다.';

drop trigger if exists notice_attachments_enqueue_object_deletion on public.notice_attachments;
create trigger notice_attachments_enqueue_object_deletion
  after delete on public.notice_attachments
  for each row execute function public.enqueue_object_deletion();

-- The mirror image, for the same hazard 0036 named: delete an attachment, then
-- upload a new one that lands on the same path, and a surviving queue entry
-- would have the next sweep delete the object out from under the row that
-- legitimately claims it.
--
-- It matters MORE here than it did for media, because the claim gate forces the
-- row to be inserted before the object exists. release_object_deletion reads
-- new.storage_path and notice_attachments has that column, so the function is
-- reused unchanged; only the trigger is new.
drop trigger if exists notice_attachments_release_object_deletion on public.notice_attachments;
create trigger notice_attachments_release_object_deletion
  after insert on public.notice_attachments
  for each row execute function public.release_object_deletion();

comment on function public.release_object_deletion() is
  '같은 경로를 다시 가리키는 media_files 또는 notice_attachments 행이 생기면 삭제 대기열에서 뺀다.';

-- ------------------------------------------------------------- execute rights
-- Restated for the reason 0011 and 0029 restate theirs: `create or replace`
-- keeps an existing ACL, but a fresh apply against a database that somehow
-- lacks the earlier file would otherwise leave these unreachable — after 0026
-- an ungranted function is unreachable rather than public. The live ACL is
-- queried back after this migration applies; reading correctly here is not
-- evidence.
--
-- Both are read by policies rather than called from a browser, so they are
-- granted to authenticated exactly as 0021 granted them.
revoke all on function public.is_my_media_object_path(text) from public, anon, authenticated;
revoke all on function public.media_object_is_claimed(text) from public, anon, authenticated;

grant execute on function public.is_my_media_object_path(text) to authenticated;
grant execute on function public.media_object_is_claimed(text) to authenticated;

-- enqueue_object_deletion and release_object_deletion stay granted to nobody:
-- they are trigger functions, and 0036 revoked them by name because a browser
-- calling enqueue directly is the one way it could queue somebody else's file.
revoke all on function public.enqueue_object_deletion() from public, anon, authenticated;
revoke all on function public.release_object_deletion() from public, anon, authenticated;
