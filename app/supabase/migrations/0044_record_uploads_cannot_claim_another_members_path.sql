-- ============================================================================
-- record_uploads may only claim a path under the caller's own member id.
--
-- 0029 closed exactly this shape one table over, and its reasoning applies here
-- without a word changed: a claim table whose write policy does not test the
-- path is a way to read the bucket, because the storage policy trusts the claim.
-- That migration fixed notice_attachments and did not look at record_uploads.
--
-- THE CHAIN, and it is three links long.
--
--   1. record_uploads_insert (0004:211) tests `uploaded_by = current_member_id()`
--      and says nothing about storage_path. record_uploads_update (0004:214) is
--      `using (can_manage_records()) with check (can_manage_records())` — so an
--      existing row's path may be rewritten to anything at all.
--
--   2. team_file_is_readable (0036:325) answers "does a row this caller can see
--      claim this path", and it is SECURITY INVOKER, so each table's own RLS
--      answers. record_uploads_read is can_manage_records() (0004:207).
--
--   3. team_files_read on storage.objects grants the read when that returns true.
--
-- So one INSERT -- which the policy accepts -- turns a path the caller could not
-- read into one they can. MEASURED on the dev database before this migration was
-- written, as an approved member holding can_manage_records(), inside a
-- transaction that was rolled back:
--
--     passes_can_manage_records | t
--     BEFORE planting  team_file_is_readable(<other member>/media/private.png) | f
--     INSERT 0 1                                        <- RLS accepted it
--     AFTER  planting  team_file_is_readable(<same path>)                      | t
--
-- WHY THIS IS NOT MERELY UNTIDY. messages_read has no staff arm, deliberately:
-- 0029 records that the president's design is that 운영진 do not read other
-- people's direct messages. A staff member who knows a DM attachment's path
-- could therefore reach it here WITHOUT being a party to the conversation. That
-- makes this a route around the rule rather than an exception to it -- which is
-- the precise reason 0029 gave for closing the notice_attachments case.
--
-- WHAT IT IS NOT: reachable through the app today. Measured at the same time --
-- record_uploads 0 rows, messages with an attachment 0, objects in the
-- team-files bucket 0. There is nothing yet to steal and no screen that uploads
-- a 결과지. 0036:295-296 had already recorded the first of those. This is a
-- landmine taken out before the feature that would arm it, which is also why it
-- is its own migration rather than a scramble.
-- ============================================================================

-- WITH CHECK gains the test; USING does not, on purpose.
--
-- 0029 made the same split for notice_attachments_write and the reasoning is
-- unchanged: a staffer must still be able to reach a row whose path predates
-- this rule -- to correct it, or to delete it -- and a USING arm that refused
-- would strand exactly the rows most likely to need attention. It is the write
-- half that must not be able to point somewhere new.
--
-- Both policies get it. Fixing INSERT alone would leave UPDATE as the same door
-- with one more step in front of it: insert a legitimate row under my own id,
-- then move it. `using`/`with check` have to be closed as a pair.
drop policy if exists record_uploads_insert on public.record_uploads;
create policy record_uploads_insert on public.record_uploads
  for insert
  with check (
    public.can_manage_records()
    and uploaded_by = public.current_member_id()
    and public.is_my_team_file_path(storage_path)
  );

drop policy if exists record_uploads_update on public.record_uploads;
create policy record_uploads_update on public.record_uploads
  for update
  using (public.can_manage_records())
  with check (
    public.can_manage_records()
    and public.is_my_team_file_path(storage_path)
  );

-- NO DIRECTORY NAME IS INVENTED HERE, and that is a decision rather than an
-- omission. is_my_team_file_path (0029:377) asks only whether the path sits
-- under the caller's own member id -- `^<my id>/[^/]` -- and that is the whole
-- of the question this defect poses. Requiring `<my id>/records/…` would be
-- designing the 결과지 uploader, which nobody has specified; 0029:374-376
-- declined to do it for the same bucket and left team_files_insert refusing
-- everything outside (media|resources), since widened to include notices. So no
-- object can exist under a `records` prefix today in any case, and inventing the
-- name now would put a rule in the database that the storage policy contradicts.
--
-- When that uploader is built, the prefix belongs in team_files_insert and in
-- this policy together, decided once.

comment on policy record_uploads_insert on public.record_uploads is
  '결과지 업로드 행은 자기 member id 밑의 경로만 주장할 수 있다. 경로 검사가 없으면 이 행 하나가 그대로 스토리지 읽기 허가가 된다.';

comment on policy record_uploads_update on public.record_uploads is
  '경로를 남의 것으로 옮기지 못한다. USING은 can_manage_records() 단독으로 두어 이 규칙보다 먼저 생긴 행도 처리할 수 있게 한다.';
