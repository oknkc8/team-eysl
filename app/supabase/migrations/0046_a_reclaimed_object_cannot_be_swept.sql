-- ============================================================================
-- The sweeper must not delete an object that has been claimed again.
--
-- 0036 built the deletion queue and 0040 gave it triggers on all four claim
-- tables and an advisory lock. Both of those closed races BETWEEN DATABASE
-- TRANSACTIONS. This closes the one that is not in a transaction at all.
--
-- THE RACE, in the client:
--
--   media/api.ts:376-381   select storage_path from pending_object_deletions   <- snapshot
--   media/api.ts:408       storage.remove(paths)                               <- acts on it
--   media/api.ts:413       clear_object_deletions_v1(paths)
--
-- Between the select and the remove, another transaction may claim one of those
-- paths. Its release trigger deletes the queue entry and commits — correctly,
-- because the object is somebody's again. The sweeper is holding a list it read
-- before that happened, and deletes a LIVE file.
--
-- The advisory lock 0040 added does not reach this. It serialises claim-table
-- transactions with each other; an HTTP call to the storage service is not a
-- participant in any of them.
--
-- WHY A PREDICATE AND NOT A LEASE. The suggestion on the table was a server-side
-- lease serialising claim creation against deletion. That would work, and it
-- would introduce state whose own consistency becomes the next failure — which
-- is precisely what a sibling PR hit when a session lock survived its client
-- because a pooler kept the backend alive. A policy predicate needs no state: it
-- is evaluated inside the storage service AT THE MOMENT OF THE DELETE, so how
-- stale the sweeper's list is stops being a question anybody has to answer.
--
-- The window is not narrowed. It stops meaning anything.
--
-- SYMMETRY, which is the other half of the argument. team_files_update already
-- asks media_object_is_claimed (0040) — an object may only be overwritten while
-- a row claims it. team_files_delete never asked the mirror question. This is
-- not a new rule; it is the missing half of one that is already here.
-- ============================================================================

-- MEASURED BEFORE WRITING THIS, because "which code paths delete an object"
-- decides whether this policy breaks a screen. Every call that removes from this
-- bucket, across the whole client:
--
--   features/media/api.ts:408    remove() on MEDIA_BUCKET = 'team-files'   <- the sweeper
--   features/profile/api.ts:181  remove() on AVATAR_BUCKET                 ┐
--   features/profile/api.ts:185  remove() on AVATAR_BUCKET                 ├ another bucket
--   features/profile/api.ts:203  remove() on AVATAR_BUCKET                 ┘
--
-- The sweeper is the only one, and this policy is scoped to bucket_id
-- 'team-files', so the avatar paths are untouched. The three screens that delete
-- a file — 미디어, 자료실, 공지 첨부 — delete ROWS (media_files directly,
-- delete_media_folder_v1, deleteNotice's cascade); the object leaves later,
-- through the queue. So no live path deletes an object while a row still claims
-- it, and the new condition refuses nothing that works today.
--
-- `to authenticated` and the owner-or-staff arm are carried over from 0040
-- unchanged. Only the last line is new.
drop policy if exists team_files_delete on storage.objects;
create policy team_files_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'team-files'
    and ((storage.foldername(name))[1] = (public.current_member_id())::text
         or public.is_staff())
    and public.team_file_library_allows_me(name)
    -- The whole of this migration. A queued path is queued because nothing
    -- claimed it; if something claims it again before the sweep lands, the
    -- object is not garbage any more and the delete is refused. The entry stays
    -- in the queue and the next sweep re-evaluates — which is already how the
    -- client behaves, because sweepPaths deliberately ignores remove()'s answer
    -- and asks clear_object_deletions_v1 what actually left the bucket.
    and not public.media_object_is_claimed(name)
  );

comment on policy team_files_delete on storage.objects is
  '큐에 오른 객체만, 그리고 그 사이 아무도 다시 주장하지 않은 경우에만 지운다. sweeper가 큐를 언제 읽었는지와 무관하게 지우는 순간 판정한다.';

-- ---------------------------------------------------------------- known limit
-- THIS MIGRATION MAKES media_object_is_claimed LOAD-BEARING IN A SECOND PLACE.
-- It already gated INSERT and UPDATE on storage.objects; it now gates DELETE.
--
-- One consequence is good and worth stating so nobody re-derives it: the insert
-- gate and the delete gate now read the SAME function, so widening it for a new
-- claim table fixes both at once and they cannot drift apart. Chat attachments
-- will need `messages` added to it — when that happens, this policy follows for
-- free. (Until then, note that an object claimed only by a messages row would
-- look unclaimed here. No such object can exist, because the insert gate refuses
-- it for the same reason — but the two facts have to move together.)
--
-- The other consequence is a review finding left OPEN on purpose. The function
-- is SECURITY DEFINER with EXECUTE granted to `authenticated`, and it answers a
-- boolean about an exact path, so an unapproved authenticated caller can learn
-- whether a path they already know is claimed. Paths are uuids, so guessing is
-- impractical and `anon` cannot reach it at all — it was rated Low.
--
-- It is NOT closed here, and the reason is that this migration is not the place
-- to decide it: adding an approval check changes who can evaluate three storage
-- policies, and that deserves its own measurement rather than riding along with
-- a deletion fix. Written down so whoever picks it up knows it was seen, and
-- knows the surface grew on this date rather than finding it later and assuming
-- nobody noticed.


-- ============================================================ comment repair
-- enqueue_object_deletion is restated below with ONE paragraph of its comment
-- rewritten and not a line of its logic touched. The old paragraph named the
-- deadlock candidates as "multi-row deletes", which is narrower than the truth,
-- and too-narrow is the dangerous direction for a warning to be wrong in.
--
-- The body is taken verbatim from 0040 rather than retyped, and the edit was
-- checked mechanically before it was written here: every line differing between
-- the two versions begins with `--`. That check is the point. Restating a
-- function body from memory is how 0024 silently dropped a parameter, so the
-- safeguard is not care — it is a diff that refuses to be anything but comments.
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
  -- Deadlock is the thing to weigh against it. THIS NOTE USED TO SAY the only
  -- candidates were two concurrent MULTI-row deletes taking the same paths in
  -- opposite orders. That understated it: two SINGLE-row path UPDATEs qualify
  -- too, because moving a claim A -> B takes the lock for both paths, so one
  -- transaction doing A -> B against another doing B -> A can deadlock with one
  -- row each. The real bound is "any two transactions touching the same two
  -- paths in opposite orders", not "multi-row deletes".
  --
  -- Still worth the trade, and that reasoning is unchanged: no screen offers a
  -- path move today, deletes are one row or a cascade whose paths are per-notice
  -- UUIDs and so disjoint, and it swaps a silent permanent leak for a loud abort
  -- Postgres raises. Corrected rather than left standing, because a note that
  -- names too narrow a bound is how the next person concludes their case is
  -- safe.
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
