-- 0020 — make the database say what the media screens say, and say what the
-- president's app says.
--
-- The finding: MediaFolderPage hid folder creation and upload behind isStaff()
-- while media_folders_insert / media_files_insert (0004:230,244) admitted any
-- approved member, and team_files_insert (0009:151) only checked that the object
-- path began with the caller's own id. That is the legacy app's defining flaw —
-- isMasterAdmin() hiding a menu while the server allowed everything — rebuilt.
--
-- Two separate questions had to be answered before writing a policy, and they
-- have different answers.
--
-- WHO MAY CREATE. His app: anybody approved. `createFolder()` (upstream:2939),
-- `uploadToFolder()` (upstream:2946) and `uploadResourceFiles()` (upstream:2960)
-- carry no role check, the buttons that call them are always rendered
-- (upstream:1185-1187), and applyRole() (upstream:1984-1994) never touches a
-- media control. So the 미디어 grid and the 자료실 are a club album that every
-- member posts to. That is the spec; our isStaff() gate on the upload panel was
-- narrower than both his app and our own database, and it is the screen that
-- moves, not the policy.
--
-- WHO MAY MANAGE WHAT EXISTS. His app: the owner, and nobody else.
-- canManageMediaOwner() reads `ownerId === currentUser.memberId`
-- (upstream:2930) where the frozen legacy copy still reads
-- `isAdminUser() || ownerId === ...` (index.html:2731) — he removed the admin
-- bypass deliberately. Ours was owner-or-staff, and the staff half was ours, not
-- his. It goes.
--
-- The cost of following him, stated so nobody has to rediscover it: no admin can
-- rename or delete another member's folder or file from inside the app any more.
-- If something has to come down, it is the uploader who takes it down, or it is
-- done in the dashboard. That is his call to revisit, not ours.
--
-- WHAT THE OBJECT AND THE ROW HAVE TO AGREE ON is ours, and is new. A path is
-- pinned to a shape, one helper decides that shape for both layers, and an
-- object may only be written where a row already claims it.

-- ---------------------------------------------------------------- helpers

-- The one definition of a legal media object path, shared by the table policy
-- and the storage policy so the two cannot drift apart. Exactly three segments:
-- the caller's own member id, the library, and a file name with no separator in
-- it — which is what path.ts builds and all it may build. Anchoring both ends is
-- what stops `<me>/anything/at/all` and, with it, a bucket a member can shape
-- however they like.
create or replace function public.is_my_media_object_path(p_path text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select p_path is not null
     and public.current_member_id() is not null
     and p_path ~ ('^' || public.current_member_id()::text || '/(media|resources)/[^/]+$')
$$;

comment on function public.is_my_media_object_path(text) is
  '경로가 <내 member id>/(media|resources)/<파일명> 형태인지. 테이블 정책과 스토리지 정책이 함께 쓴다.';

-- Security definer because the storage policy asks this question, and a policy
-- on storage.objects has no business depending on whether media_files_read
-- happens to be readable by whoever is asking.
create or replace function public.media_object_is_claimed(p_path text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.media_files where storage_path = p_path)
$$;

comment on function public.media_object_is_claimed(text) is
  '해당 경로를 가리키는 media_files 행이 이미 있는지. 버킷에 행 없는 객체가 생기는 것을 막는다.';

-- One row per object, so "delete the row, then delete the object" is a statement
-- about one thing rather than about however many rows happen to name it. It also
-- means a member cannot stake a second claim on a path they already own.
create unique index if not exists media_files_storage_path_uq
  on public.media_files (storage_path);

-- ------------------------------------------------------------ table policies

-- Unchanged in effect, restated so this file holds the whole rule: any approved
-- member may create a folder, and only in their own name. current_member_id()
-- is null for anyone not approved, and `created_by = null` is null, not true.
drop policy if exists media_folders_insert on public.media_folders;
create policy media_folders_insert on public.media_folders
  for insert with check (created_by = public.current_member_id());

-- Owner only, both halves closed: the WITH CHECK is what stops a member editing
-- their own folder into somebody else's by rewriting created_by.
drop policy if exists media_folders_update on public.media_folders;
create policy media_folders_update on public.media_folders
  for update using (created_by = public.current_member_id())
             with check (created_by = public.current_member_id());

-- No DELETE policy at all. Deleting a folder takes other people's files with it
-- by cascade, and doing that as three separate requests is what lost objects —
-- delete_media_folder_v1() below is the only way through, the same way
-- notice_comments has no INSERT policy because append_notice_comment() is.
drop policy if exists media_folders_delete on public.media_folders;

-- The row now has to name a path the caller could actually write to. Without
-- this, a member could file a row pointing at another member's object and
-- re-publish their file under their own name, or scatter rows across paths the
-- storage policy would never have accepted.
drop policy if exists media_files_insert on public.media_files;
create policy media_files_insert on public.media_files
  for insert with check (
    uploader_id = public.current_member_id()
    and public.is_my_media_object_path(storage_path)
  );

-- Owner only. storage_path is re-tested on UPDATE for the same reason it is on
-- INSERT: a row that may be edited freely is a row that can be walked over to
-- somebody else's object one column at a time.
drop policy if exists media_files_update on public.media_files;
create policy media_files_update on public.media_files
  for update using (uploader_id = public.current_member_id())
             with check (
               uploader_id = public.current_member_id()
               and public.is_my_media_object_path(storage_path)
             );

drop policy if exists media_files_delete on public.media_files;
create policy media_files_delete on public.media_files
  for delete using (uploader_id = public.current_member_id());

-- --------------------------------------------------------- folder deletion

-- Deleting a folder used to be three round trips from the browser: list the file
-- paths, delete the folder row and let the cascade take the file rows, then
-- delete the listed objects. A file uploaded between the first and the third
-- lost its row to the cascade and kept its object, and the caller reported
-- orphanedObjects: 0 because it never knew.
--
-- The lock is the fix. SELECT ... FOR UPDATE on the parent conflicts with the
-- FOR KEY SHARE that inserting a child takes, so from here to commit no
-- media_files row can be created for this folder. The paths that come back are
-- therefore all of them, and the count of what survived in the bucket is a
-- measurement rather than a guess.
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
  -- are exactly what the caller has to clean up afterwards.
  with gone as (
    delete from public.media_files where folder_id = p_folder_id returning storage_path
  )
  select coalesce(array_agg(storage_path), '{}') into v_paths from gone;

  delete from public.media_folders where id = p_folder_id;

  return query select unnest(v_paths);
end $$;

comment on function public.delete_media_folder_v1(uuid) is
  '폴더와 그 안의 파일 행을 한 트랜잭션에서 지우고, 버킷에서 지워야 할 객체 경로를 돌려준다. 폴더 주인만 호출할 수 있다.';

-- -------------------------------------------------------- storage policies

-- Reads are unchanged: any approved member sees the whole shared area, which is
-- what a club album is.

-- The storage half of media_files_insert. Two conditions, and the second is the
-- one that matters: an object may only be written where a row already claims it,
-- so there is no longer any way to leave bytes in the bucket that nothing points
-- at. Nothing in this app lists a bucket, so such an object was invisible, and
-- an invisible object still costs the quota somebody pays for.
--
-- This reverses the upload order — the row goes in first and the object second,
-- and media/api.ts does exactly that. The failure mode moves from an invisible
-- orphan object to a visible row with no object, which the uploader can see and
-- delete. That trade is the whole point.
--
-- NOTE FOR WHOEVER BUILDS NOTICE OR CHAT ATTACHMENTS: they share this bucket
-- (0004:34 for notices, chat.attachment_path for chat) and nothing writes them
-- yet — only createSignedUrl reads. This policy will refuse those uploads,
-- deliberately and loudly, until somebody adds an arm for them that answers the
-- same two questions about their own table. Do not widen this one to `<me>/%`
-- to make it pass; that is the hole this closes.
drop policy if exists team_files_insert on storage.objects;
create policy team_files_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'team-files'
    and public.is_my_media_object_path(name)
    and public.media_object_is_claimed(name)
  );

-- Own objects only, staff arm dropped to match the row rule. Renaming a file
-- never touches its object (media/api.ts leaves storage_path alone on purpose),
-- so nothing in the app needs this except the storage service finishing its own
-- upload.
drop policy if exists team_files_update on storage.objects;
create policy team_files_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'team-files'
    and (storage.foldername(name))[1] = public.current_member_id()::text
  )
  with check (
    bucket_id = 'team-files'
    and (storage.foldername(name))[1] = public.current_member_id()::text
  );

-- DELETE keeps its staff arm, and this is a decision rather than an oversight.
-- It is not the management rule in disguise: deleting a row is publishing
-- authority, deleting an object is janitorial. Two things need the sweeper. A
-- folder owner who deletes a folder full of other members' files can remove
-- those rows (the cascade does it for them) but not those objects, because the
-- objects sit under their uploaders' prefixes; and any object left behind by a
-- half-finished upload has to be reclaimable by somebody. Nobody gains the
-- ability to put anything anywhere from this arm — a delete only removes.
--
-- The prefix test rather than is_my_media_object_path() is also deliberate: an
-- object stored before this migration under some other shape must stay
-- removable, and a cleanup that cannot reach the mess is not a cleanup.
drop policy if exists team_files_delete on storage.objects;
create policy team_files_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'team-files'
    and ((storage.foldername(name))[1] = public.current_member_id()::text or public.is_staff())
  );

-- -------------------------------------------------------------- execute rights
-- From public, anon and authenticated by name, not from PUBLIC alone: 0002's
-- expire_stale_offers ended up anonymously callable exactly that way, and 0014
-- traced it to default privileges rather than to the revoke.
revoke all on function public.is_my_media_object_path(text) from public, anon, authenticated;
revoke all on function public.media_object_is_claimed(text) from public, anon, authenticated;
revoke all on function public.delete_media_folder_v1(uuid)  from public, anon, authenticated;

-- The two helpers are named inside policy expressions, which are evaluated as
-- whoever is asking — so authenticated needs EXECUTE for the policies to be
-- evaluable at all, not merely to call them directly.
grant execute on function public.is_my_media_object_path(text) to authenticated;
grant execute on function public.media_object_is_claimed(text) to authenticated;
grant execute on function public.delete_media_folder_v1(uuid)  to authenticated;
