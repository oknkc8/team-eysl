-- 0043 — 결과지 업로드: the record importer keeps the sheet it read.
--
-- ============================================================================
-- WHAT WAS WIRED AND NEVER CONNECTED
-- ============================================================================
--
-- Measured against this project's database before writing this:
--
--    record_uploads rows    : 0
--    records rows           : 258   (200 of them category 'meet')
--    records with upload_id : 0     -- of 258
--
-- Every one of those 258 results was imported with no provenance. Nobody can
-- say which sheet a row came from, and a bad import can only be undone one row
-- at a time — even though 0004 built the FK that was supposed to do it in one:
--
--    upload_id uuid references public.record_uploads(id) on delete cascade
--    comment on table public.record_uploads is
--      '기록지 업로드 이력. 삭제하면 이 업로드에서 나온 records도 함께 삭제된다.'
--
-- The feature is scaffolded at four layers and joined at none. record_uploads
-- has all four RLS policies (0004:207-217). upsert_record already takes
-- p_upload_id and really stores it — it is in the INSERT column list, not just
-- the signature. 0040 already generalised enqueue_object_deletion() with
-- tg_argv and attached delete and path-change triggers to record_uploads, so
-- removing an upload already queues its object. And 0036 added the
-- record_uploads arm to team_file_is_readable and to the adoption select.
--
-- What is missing is the part that lets an object exist at all. This migration
-- is that part, and nothing else: no new table, no new RPC, no new trigger.
--
-- ============================================================================
-- WHY THE DIRECTORY NAME ARRIVES NOW AND NOT EARLIER
-- ============================================================================
--
-- 0029:374-376 refused to invent directory names for this bucket, and claim2
-- restated the rule while declining to add a `records` prefix in 0044: adding
-- one would be "designing an uploader nobody has specified".
--
-- That was right, and it is why the prefix is in THIS migration. The uploader is
-- specified here — path shape, who may write it, what claims it, what happens
-- when the row goes — so the name arrives with its justification attached
-- rather than ahead of it.
--
-- ============================================================================
-- THREE PREDICATES, WIDENED TOGETHER
-- ============================================================================
--
-- 0036 left this instruction for whoever built this, and it is the reason all
-- three are in one migration:
--
--   "widening media_object_is_claimed is not enough on its own. Widen it, and
--    this predicate, and the adoption select below, together — widening only
--    the insert gate means the first result sheet uploaded is classified as
--    debris by the very next sweep."
--
-- Two of the three named there are already done (0036 did them). The third,
-- media_object_is_claimed, is here — plus the path shape and the library gate,
-- which that note did not know it would need because it predates the decision
-- to store the sheet.
--
-- Each is CREATE OR REPLACE read out of the live catalogue and changed only
-- where it had to be. 0024 is why: a function rebuilt from a description of it
-- silently lost a parameter.
--
-- ============================================================================
-- NOT is_my_team_file_path — THEY ANSWER DIFFERENT QUESTIONS
-- ============================================================================
--
-- Both exist and they are not duplicates:
--
--   is_my_team_file_path      ^<me>/[^/]                              (0044)
--   is_my_media_object_path   ^<me>/(media|resources|notices)/[^/]+$
--
-- The first asks only "is this under my member id" and deliberately does not
-- look at directories — it is what stops a record_uploads ROW claiming another
-- member's path. The second additionally requires a known directory, which is
-- what lets team_file_library_allows_me tell one library from another. A
-- 결과지 needs both halves, so the directory-aware one is the one that grows.
--
-- ============================================================================
-- DECISIONS THAT ARE OURS
-- ============================================================================
--
-- 1. can_manage_records(), NOT is_staff(), GATES THE records/ LIBRARY.
--    They are different sets: can_manage_records() is admin, master_admin or
--    팀 역할 코치, while is_staff() is admin or master_admin alone. A coach who
--    may create the records may keep the sheet those records came from;
--    splitting the two would give us a 결과지 a coach can import from and not
--    look at afterwards.
--
-- 2. THE SHEET IS KEPT, NOT PARSED AND DISCARDED.
--    The screen currently parses in the browser and uploads nothing
--    (AdminRecordUploadPage.tsx:21), which is why no object has ever been
--    stranded. Keeping it is what makes a suspicious result checkable against
--    its source months later, and record_uploads.storage_path plus 0036's
--    fourth claim arm were built for exactly that.
--
-- 3. ONE OBJECT PER UPLOAD ROW, NAMED BY UUID, NOT BY THE FILE'S OWN NAME.
--    file_name keeps what the uploader called it, for display. The object path
--    is <member id>/records/<uuid>, so two sheets called 결과.pdf cannot collide
--    and a filename can never steer where bytes land.

-- ------------------------------------------------------- the path shape

-- 0040's function with 'records' added to the alternation. Everything else --
-- the anchor, the null checks, the single trailing segment -- is unchanged.
create or replace function public.is_my_media_object_path(p_path text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_path is not null
     and public.current_member_id() is not null
     and p_path ~ ('^' || public.current_member_id()::text || '/(media|resources|notices|records)/[^/]+$')
$$;

comment on function public.is_my_media_object_path(text) is
  '내 member id 밑의 알려진 라이브러리 디렉터리에 있는 경로인가. 디렉터리를 보지 않는 is_my_team_file_path와 다르다.';

-- ------------------------------------------------------- the claim gate

-- The third of the three 0036 named. Without this arm team_files_insert refuses
-- the object outright, because no media_files or notice_attachments row claims
-- it -- so the first 결과지 upload would fail rather than be swept, which is the
-- failure direction 0021 chose on purpose.
create or replace function public.media_object_is_claimed(p_path text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.media_files where storage_path = p_path)
      or exists (select 1 from public.notice_attachments where storage_path = p_path)
      or exists (select 1 from public.record_uploads where storage_path = p_path)
$$;

comment on function public.media_object_is_claimed(text) is
  '이 경로를 주장하는 행이 어느 테이블에든 있는가. 청구 테이블이 늘면 여기도 같이 늘어야 한다.';

-- ------------------------------------------------------ the library gate

-- 0040's function with a second arm. The shape is deliberately a CASE rather
-- than a chain of ORs: each library names its own gate, and a library with no
-- arm falls through to `true`, which is what media/ and resources/ want (0021
-- made creation there open to every approved member).
create or replace function public.team_file_library_allows_me(p_path text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
           when p_path ~ '^[^/]+/notices/' then public.is_staff()
           when p_path ~ '^[^/]+/records/' then public.can_manage_records()
           else true
         end
$$;

comment on function public.team_file_library_allows_me(text) is
  '경로가 속한 라이브러리가 나에게 열려 있는가. notices/는 운영진, records/는 기록 관리자(코치 포함).';

-- ------------------------------------------------------------- grants
--
-- THESE THREE MUST KEEP authenticated=X, AND THE FIRST DRAFT OF THIS MIGRATION
-- TOOK IT AWAY. Recording it because the reasoning was plausible and wrong.
--
-- The draft revoked from `public, anon, authenticated` and granted nothing,
-- on the reasoning that "these are helpers called from storage policies and
-- from each other, never by a browser". The second half is true and the
-- conclusion does not follow. **An RLS policy expression is evaluated as the
-- CALLING role**, so when a member uploads a file, it is `authenticated` that
-- executes is_my_media_object_path() inside team_files_insert's WITH CHECK.
-- SECURITY DEFINER decides whose privileges the BODY runs with; it does not
-- excuse the caller from needing EXECUTE.
--
-- Applying that draft broke every upload in the app — media, 자료실 and notice
-- attachments, not merely the new library — with `permission denied for
-- function is_my_media_object_path`. It was caught by reading the live ACL and
-- noticing the three touched functions had lost a grant their untouched peers
-- still had:
--
--    is_my_avatar_object_path     postgres=X | service_role=X | authenticated=X
--    is_my_team_file_path         postgres=X | service_role=X | authenticated=X
--    team_file_is_readable        postgres=X | service_role=X | authenticated=X
--    is_my_media_object_path      postgres=X | service_role=X            <- mine
--    media_object_is_claimed      postgres=X | service_role=X            <- mine
--    team_file_library_allows_me  postgres=X | service_role=X            <- mine
--
-- Comparing a changed object against its unchanged siblings is what made it
-- obvious; the migration text alone read as correct, and so did the diff.
--
-- CREATE OR REPLACE preserves an ACL, so the honest thing here is to touch it
-- as little as possible: revoke the two roles that must never hold it, and
-- restate the one grant that must survive. 0026 is why the grant is written in
-- the migration that last touched the function rather than left implicit.
revoke all on function public.is_my_media_object_path(text)      from public, anon;
revoke all on function public.media_object_is_claimed(text)      from public, anon;
revoke all on function public.team_file_library_allows_me(text)  from public, anon;

grant execute on function public.is_my_media_object_path(text)     to authenticated;
grant execute on function public.media_object_is_claimed(text)     to authenticated;
grant execute on function public.team_file_library_allows_me(text) to authenticated;
