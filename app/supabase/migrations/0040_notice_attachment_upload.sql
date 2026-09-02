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
declare
  v_path text;
begin
  -- THE PATH COLUMN IS NAMED BY THE TRIGGER, not assumed. messages calls its
  -- column attachment_path while the other three call theirs storage_path, and
  -- reading old.storage_path directly is what limited this function to the
  -- tables that happen to agree. to_jsonb(old) lets one function serve all
  -- four; the argument defaults to storage_path so the existing triggers keep
  -- working unchanged.
  v_path := to_jsonb(old) ->> coalesce(tg_argv[0], 'storage_path');

  -- Nullable on messages: a message with no attachment has nothing to queue.
  if v_path is null then
    return null;
  end if;

  -- Another table -- or another row of this one -- may still claim this exact
  -- path, and then the object is not garbage, it is theirs.
  --
  -- CLOSED — and it had to be, because the note that used to stand here was
  -- wrong about the one fact it rested on.
  --
  -- The race: two transactions deleting rows in DIFFERENT claim tables each
  -- still see the other's row, both skip the insert, and the object ends with no
  -- row and no queue entry. That was recorded as survivable on the grounds that
  -- "0036's adoption select recovers it". It does not. That adoption
  -- (0036:413-421) is a bare `insert … select` at MIGRATION level: it ran once,
  -- when 0036 was applied, and never runs again. The runtime sweeper reads only
  -- paths ALREADY in the queue. So an object reaching the no-row-no-queue state
  -- at any point after 0036 was applied is invisible to both, forever. The
  -- failure direction was still the safer one — a leak, not a live file deleted
  -- — but it was a PERMANENT leak, not the self-healing one described.
  --
  -- One transaction-scoped advisory lock per path closes it. The second
  -- transaction blocks until the first commits, then sees the first's delete and
  -- correctly finds the path unclaimed. Serialisable isolation or a lock ordered
  -- across four tables would also work and cost considerably more.
  --
  -- Deadlock is the thing to weigh against it, and it is bounded. A transaction
  -- takes one lock per deleted row, so two concurrent MULTI-row deletes touching
  -- the same paths in opposite orders could deadlock. Deletes here are one row
  -- from a screen, or a cascade whose paths are per-notice UUIDs and therefore
  -- disjoint between notices. And it trades a silent permanent leak for a loud
  -- abort: Postgres detects a deadlock and raises, where the old failure was a
  -- file nobody could see again and nobody would be told about.
  perform pg_advisory_xact_lock(hashtext(v_path));

  if exists (select 1 from public.media_files where storage_path = v_path)
     or exists (select 1 from public.notice_attachments where storage_path = v_path)
     or exists (select 1 from public.messages where attachment_path = v_path)
     or exists (select 1 from public.record_uploads where storage_path = v_path) then
    return null;
  end if;

  insert into public.pending_object_deletions (storage_path, requested_by)
  values (v_path, public.current_member_id())
  on conflict (storage_path) do nothing;

  return null;
end $$;

-- The same argument treatment for the release side, and for the same reason:
-- a messages row re-claiming a queued path has to take it back out of the
-- queue, and it could not while this function read new.storage_path.
create or replace function public.release_object_deletion()
returns trigger
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_path text;
begin
  v_path := to_jsonb(new) ->> coalesce(tg_argv[0], 'storage_path');
  if v_path is null then
    return null;
  end if;

  -- THE SAME LOCK, and here it guards the dangerous direction rather than the
  -- merely wasteful one. Without it: T1 deletes the last row claiming P and,
  -- seeing no claim, queues P; concurrently T2 inserts a row claiming P and its
  -- release deletes nothing, because T1's queue entry is not committed yet. T1
  -- commits. The queue now holds a path a LIVE row claims, and the next sweep
  -- deletes an object somebody owns.
  --
  -- Ordering the two under one lock per path makes the later transaction see the
  -- earlier one's work, whichever way round they arrive.
  perform pg_advisory_xact_lock(hashtext(v_path));

  delete from public.pending_object_deletions where storage_path = v_path;
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
  '같은 경로를 다시 가리키는 행이 생기면 삭제 대기열에서 뺀다. 경로 컬럼 이름은 트리거 인자로 받는다.';

-- ------------------------------------------ the other two claim tables
-- 0036 said to widen media_object_is_claimed, team_file_is_readable, the
-- enqueue guard and the adoption select together. That instruction was about
-- RECOGNISING a claim and said nothing about the LIFECYCLE, so the triggers
-- stayed on media_files alone and this migration added notice_attachments —
-- two of the four claim tables with an enqueue, two without.
--
-- The gap is not theoretical. A notice and a message claiming one path: delete
-- the notice and the guard correctly skips because the message still claims it,
-- then delete the message and nothing fires at all — the object ends with no
-- row and no queue entry. The reverse strands it too, because a messages row
-- re-claiming an already-queued path never released it, so a live object was
-- queued for sweeping.
--
-- record_uploads has no delete path in the app yet, and that is exactly why it
-- goes in now: 0036 called it "a landmine, not a live defect", and a trigger
-- added before the feature is a trigger nobody has to remember afterwards.
drop trigger if exists messages_enqueue_object_deletion on public.messages;
create trigger messages_enqueue_object_deletion
  after delete on public.messages
  for each row execute function public.enqueue_object_deletion('attachment_path');

drop trigger if exists messages_release_object_deletion on public.messages;
create trigger messages_release_object_deletion
  after insert on public.messages
  for each row execute function public.release_object_deletion('attachment_path');

drop trigger if exists record_uploads_enqueue_object_deletion on public.record_uploads;
create trigger record_uploads_enqueue_object_deletion
  after delete on public.record_uploads
  for each row execute function public.enqueue_object_deletion();

drop trigger if exists record_uploads_release_object_deletion on public.record_uploads;
create trigger record_uploads_release_object_deletion
  after insert on public.record_uploads
  for each row execute function public.release_object_deletion();

-- ------------------------------------------ and when a row CHANGES its path
-- The direct descendant of the widening above, and the half it missed. That
-- change took the TABLE set from two to four and left the EVENT set at two.
-- DELETE and INSERT are not the only ways a claim moves: an UPDATE that
-- rewrites the path column retires one path and takes up another in a single
-- statement, and neither trigger fires for it.
--
-- What that costs, concretely. Move a claim from A to B where B is already
-- queued: B's queue entry is never released, so the next sweep deletes B out
-- from under the row that now legitimately claims it — a live file, which is
-- the failure direction this whole mechanism exists to prevent. Meanwhile A,
-- which nothing claims any more, is never enqueued and leaks permanently. One
-- UPDATE produces both halves at once.
--
-- No third function is needed, and writing one would have been the mistake:
-- enqueue reads OLD, release reads NEW, and an UPDATE trigger has both. So the
-- existing pair is reused exactly as it stands and only the triggers are new —
-- which also means the advisory lock added above covers this path for free.
--
-- `after update of <col>` narrows the trigger to statements that mention the
-- column; the WHEN clause then narrows it to those that actually change it,
-- because naming a column in SET is not the same as altering its value.
-- `is distinct from` rather than `<>` so a nullable path (messages) compares
-- correctly instead of yielding NULL and never firing.
drop trigger if exists notice_attachments_enqueue_on_path_change on public.notice_attachments;
create trigger notice_attachments_enqueue_on_path_change
  after update of storage_path on public.notice_attachments
  for each row when (old.storage_path is distinct from new.storage_path)
  execute function public.enqueue_object_deletion();

drop trigger if exists notice_attachments_release_on_path_change on public.notice_attachments;
create trigger notice_attachments_release_on_path_change
  after update of storage_path on public.notice_attachments
  for each row when (old.storage_path is distinct from new.storage_path)
  execute function public.release_object_deletion();

drop trigger if exists media_files_enqueue_on_path_change on public.media_files;
create trigger media_files_enqueue_on_path_change
  after update of storage_path on public.media_files
  for each row when (old.storage_path is distinct from new.storage_path)
  execute function public.enqueue_object_deletion();

drop trigger if exists media_files_release_on_path_change on public.media_files;
create trigger media_files_release_on_path_change
  after update of storage_path on public.media_files
  for each row when (old.storage_path is distinct from new.storage_path)
  execute function public.release_object_deletion();

drop trigger if exists messages_enqueue_on_path_change on public.messages;
create trigger messages_enqueue_on_path_change
  after update of attachment_path on public.messages
  for each row when (old.attachment_path is distinct from new.attachment_path)
  execute function public.enqueue_object_deletion('attachment_path');

drop trigger if exists messages_release_on_path_change on public.messages;
create trigger messages_release_on_path_change
  after update of attachment_path on public.messages
  for each row when (old.attachment_path is distinct from new.attachment_path)
  execute function public.release_object_deletion('attachment_path');

drop trigger if exists record_uploads_enqueue_on_path_change on public.record_uploads;
create trigger record_uploads_enqueue_on_path_change
  after update of storage_path on public.record_uploads
  for each row when (old.storage_path is distinct from new.storage_path)
  execute function public.enqueue_object_deletion();

drop trigger if exists record_uploads_release_on_path_change on public.record_uploads;
create trigger record_uploads_release_on_path_change
  after update of storage_path on public.record_uploads
  for each row when (old.storage_path is distinct from new.storage_path)
  execute function public.release_object_deletion();

-- ------------------------------------------ who may write a notice object
-- The storage policies ask two questions — is this path mine, and does a row
-- claim it — and neither of them asks whether the caller is still staff. So a
-- member demoted out of 운영진 kept the ability to upsert over, or delete, the
-- objects on notices they had written: their member id is still the prefix and
-- the notice_attachments row still claims the path. Creating anything new was
-- already refused, because notice_attachments_write checks is_staff(); role
-- revocation simply did not reach bytes that were already uploaded.
--
-- Asked per library rather than globally. media and resources are open to every
-- approved member by 0021's deliberate decision, and widening this to all of
-- team-files would quietly reverse that.
create or replace function public.team_file_library_allows_me(p_path text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select case
           when p_path ~ '^[^/]+/notices/' then public.is_staff()
           else true
         end
$$;

comment on function public.team_file_library_allows_me(text) is
  '경로가 속한 라이브러리에 지금도 쓸 자격이 있는지. notices는 운영진만이며 나머지는 승인 회원 모두에게 열려 있다.';

-- The three write policies gain the conjunct. Copied from 0021 and 0036 with
-- one clause added rather than rewritten, so nothing else about them moves.
drop policy if exists team_files_insert on storage.objects;
create policy team_files_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'team-files'
    and public.is_my_media_object_path(name)
    and public.media_object_is_claimed(name)
    and public.team_file_library_allows_me(name)
  );

drop policy if exists team_files_update on storage.objects;
create policy team_files_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'team-files'
    and public.is_my_media_object_path(name)
    and public.media_object_is_claimed(name)
    and public.team_file_library_allows_me(name)
  )
  with check (
    bucket_id = 'team-files'
    and public.is_my_media_object_path(name)
    and public.media_object_is_claimed(name)
    and public.team_file_library_allows_me(name)
  );

-- delete keeps its owner-or-staff shape from 0021 and gains the same clause, so
-- a demoted member can no longer take down a notice attachment they wrote while
-- staff remain able to.
drop policy if exists team_files_delete on storage.objects;
create policy team_files_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'team-files'
    and ((storage.foldername(name))[1] = (public.current_member_id())::text
         or public.is_staff())
    and public.team_file_library_allows_me(name)
  );

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

revoke all on function public.team_file_library_allows_me(text) from public, anon, authenticated;

grant execute on function public.is_my_media_object_path(text) to authenticated;
grant execute on function public.media_object_is_claimed(text) to authenticated;
grant execute on function public.team_file_library_allows_me(text) to authenticated;

-- enqueue_object_deletion and release_object_deletion stay granted to nobody:
-- they are trigger functions, and 0036 revoked them by name because a browser
-- calling enqueue directly is the one way it could queue somebody else's file.
revoke all on function public.enqueue_object_deletion() from public, anon, authenticated;
revoke all on function public.release_object_deletion() from public, anon, authenticated;

-- ============================================================================
-- SAVING A NOTICE AND ITS ATTACHMENTS TOGETHER
-- ============================================================================
--
-- THE UX DECISION, AND WHY THE OTHER ONE WAS REJECTED.
--
-- The claim gate forces the row before the object, and notice_id is NOT NULL,
-- so something has to exist before an attachment can. The obvious reading is
-- "save the notice, then come back and attach" — and it was rejected.
--
-- A two-step flow makes the member responsible for returning. Somebody writes a
-- notice, submits it, and the attachment simply never happens; nothing is
-- broken, nothing is reported, the file is just missing. It also puts the
-- database's ordering constraint in front of the member as an instruction,
-- which is the thing the constraint should have spared them.
--
-- Single screen instead: 등록 creates the notice AND its attachment rows in one
-- transaction, then the client uploads the objects. That is the shape
-- uploadMediaFiles already uses (media/api.ts) and it accepts the same failure —
-- a row whose object never arrived. That failure is the better one on purpose:
-- it is VISIBLE, as an attachment the uploader can see and delete, whereas an
-- object with no row is unreachable debris nobody can find. The president's app
-- attaches during composition too, so this is also what members expect.
--
-- THE CLIENT DOES NOT CHOOSE THE PATH. It sends file names and types; this
-- function derives `<caller's member id>/notices/<uuid>` itself. Two things
-- fall out of that. A caller cannot name a path under somebody else's member id
-- — not because a check refuses it, but because there is no parameter to say it
-- in. And the member-supplied file name never reaches the object path, so no
-- sanitising rule has to be right: `../`, a null byte, a name that is entirely
-- dots, none of them are in a position to matter. The name is stored in
-- file_name for display, which is a rendering problem and is solved where
-- rendering happens.
--
-- NO EXTENSION ON THE OBJECT. mime_type is on the row and file_name carries the
-- name a member sees; putting an extension in the path would mean deriving one
-- from member input, which is the sanitising problem this design just avoided.
--
-- THE ATTACHMENT LIST IS THE DESIRED FINAL SET, not a delta. Rows not named in
-- it are deleted, which routes their objects through the enqueue trigger above
-- rather than through anything the client has to remember. Passing a delta
-- would mean the client and the server each holding half of the truth about
-- what a notice has.
-- ON p_expected_updated_at, WHICH IS NOT OPTIONAL FOR AN EDIT.
--
-- Without it this function was the lost update again, and with more to lose
-- than the board post it was first found on: A saves an attachment, B saves
-- from a screen loaded before that, and B's call overwrites A's body AND
-- deletes A's attachment — because the desired-final-set semantics below mean
-- B's stale id list is authoritative. Both callers are told they succeeded.
--
-- The comparison is lifted from update_board_post_v1 (0037), read out of that
-- file rather than rebuilt: same PT409 errcode so a client can tell "changed
-- elsewhere" from "gone", same DETAIL payload so the screen can show the
-- current text from this one answer instead of a refetch that could itself
-- land after a third edit.
create or replace function public.save_notice_v1(
  p_notice_id           uuid,
  p_title               text,
  p_body                text,
  p_attachments         jsonb,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_me       uuid;
  v_notice   public.notices;
  v_title    text;
  v_body     text;
  v_keep     uuid[];
  v_item     jsonb;
  v_kept     jsonb;
  v_path     text;
  v_new_id   uuid;
  v_name     text;
  v_mime     text;
  v_result   jsonb := '[]'::jsonb;
begin
  -- SECURITY DEFINER means notices_write and notice_attachments_write are not
  -- consulted, so this line is the whole of the enforcement. Same gate they
  -- carry: is_staff().
  if not public.is_staff() then
    raise exception 'only staff may write a notice' using errcode = '42501';
  end if;

  v_me := public.current_member_id();

  v_title := btrim(coalesce(p_title, ''));
  v_body  := coalesce(p_body, '');
  if v_title = '' then
    raise exception '제목을 입력해주세요' using errcode = '22023';
  end if;

  -- A cap, not a guess: notice_attachments has no constraint of its own and a
  -- client loop with a bug should meet a number rather than fill the bucket.
  if jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)) > 10 then
    raise exception '첨부파일은 한 번에 10개까지 올릴 수 있습니다' using errcode = '22023';
  end if;

  if p_notice_id is null then
    -- Creating: there is no version to be stale against, and accepting one
    -- would let a caller believe it had checked something.
    if p_expected_updated_at is not null then
      raise exception 'expected updated_at must be null when creating'
        using errcode = '22023';
    end if;
    insert into public.notices (title, body, created_by)
    values (v_title, v_body, v_me)
    returning * into v_notice;
  else
    if p_expected_updated_at is null then
      raise exception 'expected updated_at is required' using errcode = '22023';
    end if;

    -- LOCKED FIRST, then compared, then written — all three inside one
    -- transaction, so nothing can slip between the comparison and the UPDATE.
    -- The lock also covers the attachment reconciliation below, which is the
    -- half that made this worse than the board case.
    select * into v_notice from public.notices where id = p_notice_id for update;
    if not found then
      raise exception 'no such notice' using errcode = '42704';
    end if;

    if v_notice.updated_at <> p_expected_updated_at then
      raise exception 'notice changed elsewhere'
        using errcode = 'PT409',
              detail  = jsonb_build_object(
                          'title',      v_notice.title,
                          'body',       v_notice.body,
                          'updated_at', v_notice.updated_at
                        )::text;
    end if;

    update public.notices
       set title = v_title,
           body  = v_body,
           -- greatest(...), not a bare now(): now() is transaction-start time,
           -- so two updates beginning in the same microsecond would stamp the
           -- same value and a stale third write would then compare equal and be
           -- accepted. One microsecond past the value being replaced makes the
           -- column strictly increasing per row by construction. 0037's
           -- reasoning, and it applies here for the same reason.
           updated_at = greatest(now(), v_notice.updated_at + interval '1 microsecond')
     where id = p_notice_id
    returning * into v_notice;
  end if;

  -- Existing rows the caller is keeping. Anything else on this notice goes, and
  -- its object is queued by the trigger rather than by the client.
  select coalesce(array_agg((e->>'id')::uuid), '{}')
    into v_keep
    from jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb)) e
   where e->>'id' is not null;

  delete from public.notice_attachments
   where notice_id = v_notice.id
     and not (id = any (v_keep));

  for v_item in
    select e from jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb)) e
  loop
    if v_item->>'id' is not null then
      -- Kept as it stands. file_name and mime_type are not re-read from the
      -- client: renaming an existing attachment is not something this screen
      -- offers, and accepting the fields anyway would let a caller rewrite a
      -- row it only meant to keep.
      select jsonb_build_object(
               'id', a.id, 'storage_path', a.storage_path,
               'file_name', a.file_name, 'mime_type', a.mime_type,
               'is_new', false)
        into v_kept
        from public.notice_attachments a
       where a.id = (v_item->>'id')::uuid and a.notice_id = v_notice.id;
      if v_kept is null then
        raise exception 'attachment does not belong to this notice' using errcode = '42501';
      end if;
      v_result := v_result || jsonb_build_array(v_kept);
    else
      -- The path is built here, from the caller's identity and a fresh uuid.
      v_new_id := gen_random_uuid();
      v_path   := v_me::text || '/notices/' || v_new_id::text;
      -- Trimmed and bounded; stored for display only. It is never part of the
      -- object path, so this is a tidiness rule rather than a safety one.
      v_name   := left(btrim(coalesce(nullif(v_item->>'file_name', ''), '파일')), 200);
      v_mime   := coalesce(nullif(v_item->>'mime_type', ''), 'application/octet-stream');

      insert into public.notice_attachments
        (id, notice_id, storage_path, file_name, mime_type, sort_order)
      values (v_new_id, v_notice.id, v_path, v_name, v_mime,
              coalesce((v_item->>'sort_order')::int, 0));

      v_result := v_result || jsonb_build_array(jsonb_build_object(
        'id', v_new_id, 'storage_path', v_path,
        'file_name', v_name, 'mime_type', v_mime,
        -- The client uploads exactly the entries flagged here, so it never has
        -- to work out which of them are new by comparing lists.
        'is_new', true));
    end if;
  end loop;

  return jsonb_build_object(
    'notice', jsonb_build_object(
      'id', v_notice.id, 'title', v_notice.title, 'body', v_notice.body,
      'created_at', v_notice.created_at, 'updated_at', v_notice.updated_at,
      'created_by', v_notice.created_by),
    'attachments', v_result);
end $$;

comment on function public.save_notice_v1(uuid, text, text, jsonb, timestamptz) is
  '공지와 첨부 목록을 한 트랜잭션에서 저장한다. 첨부 경로는 호출자가 정하지 않고 이 함수가 <내 member id>/notices/<uuid>로 만든다. 목록에 없는 기존 첨부는 삭제되고 객체는 삭제 대기열로 간다.';

-- The four-argument form is DROPPED rather than left beside the new one.
-- `create or replace` cannot change a signature, so without this the old
-- version would still exist and still be callable — and it is precisely the
-- version with no conflict check. An overload that silently accepts the unsafe
-- call is worse than no migration at all.
drop function if exists public.save_notice_v1(uuid, text, text, jsonb);

revoke all on function public.save_notice_v1(uuid, text, text, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.save_notice_v1(uuid, text, text, jsonb, timestamptz)
  to authenticated;

-- ============================ 4. the version check is only worth what the
-- ============================    policies around it leave standing
--
-- save_notice_v1 is SECURITY DEFINER, so it does not consult these policies.
-- That cuts both ways: it means the RPC keeps working however tight they get,
-- and it means everything they still permit is a way AROUND the conflict check
-- rather than a way to use it. Two doors stood open, and the second is worse
-- than the first.
--
-- notices_write was `for all`, so a staff session could UPDATE title and body
-- directly. That write never passes through the greatest(now(), …) stamp, so a
-- form holding the pre-UPDATE version still compares equal on its next save and
-- overwrites the edit without ever reporting a conflict.
--
-- notice_attachments_write was `for all` too, and there the damage is not a
-- lost edit but a lost FILE. An attachment row inserted directly does not touch
-- notices.updated_at at all. A form that loaded BEFORE that insert therefore
-- passes the version check cleanly, and its reconciliation — which takes the
-- desired final set and deletes everything else — removes the new attachment as
-- though the editor had asked for that. The save looks correct, reports
-- success, and destroys somebody else's upload.
--
-- So both tables lose their direct write path and the RPC becomes the only way
-- in. DELETE stays on notices alone, because deleteNotice() is a real screen
-- action with no RPC behind it; notice_attachments needs no delete arm of its
-- own, since notice_attachments.notice_id is ON DELETE CASCADE (0004:27) and a
-- cascade fires the row triggers exactly as a direct delete would.
--
-- The dead client functions go with it. updateNotice() and createNotice() had
-- no callers left after saveNotice() landed, and an exported writer that
-- bypasses the check is a thing the next screen calls by accident — which is
-- the whole reason this finding exists rather than being theoretical.
drop policy if exists notices_write on public.notices;
drop policy if exists notices_delete on public.notices;
create policy notices_delete on public.notices
  for delete using (public.is_staff());

-- No write policy at all. RLS with no policy denies by default, which is the
-- same shape 0028 used for signup_attempt_quota: bookkeeping that exactly one
-- SECURITY DEFINER function is allowed to touch.
drop policy if exists notice_attachments_write on public.notice_attachments;

