-- ============================================================================
-- Chat attachments: the three gates learn about `messages`.
--
-- send_message_v1 has taken p_attachment_path since 0012 and validated it since
-- 0029; messages carries attachment_path/attachment_type; MessageThread renders
-- one and chat/api.ts signs a URL for it. Every part of this feature exists
-- EXCEPT the ability to put the object in the bucket, and that is what this
-- migration adds.
--
-- WHY IT WAS IMPOSSIBLE, precisely: team_files_insert requires
-- media_object_is_claimed(name), and that function did not look at `messages`.
-- The claim gate demands the row before the object, so a chat attachment could
-- never be uploaded at all -- not by any path, not with any directory name.
--
-- ---------------------------------------------------------------------------
-- THREE FUNCTIONS TAKE AN ATTACHMENT PATH AND THEY DO NOT AGREE. This is worth
-- writing down because it is not an accident, it is a sequence:
--
--   save_notice_v1     the SERVER derives the path      no client parameter at all
--   send_message_v1    client names it, server VALIDATES  is_my_team_file_path, 0029
--   record_uploads     client named it, NOTHING checked   closed by 0044
--
-- The last was a defect and is fixed. The middle is sound. The first is the
-- best of the three, because a parameter that does not exist cannot be wrong --
-- there is no sanitising rule to get right about `../`, a null byte, or a name
-- that is entirely dots.
--
-- So: WHEN THE NEXT FUNCTION TAKES AN ATTACHMENT, DERIVE THE PATH SERVER-SIDE.
-- Chat keeps its shape here only because 0029 already validated it and changing
-- a working signature is not this migration's business.
-- ============================================================================

-- ------------------------------------------------- 1. the claim gate, widened
-- Two changes in one function, and they pull in opposite directions on purpose.
--
-- ADDING `messages` is what makes chat attachments possible. It also means this
-- function now answers about DM attachment paths, which is why the second change
-- belongs in the same migration rather than a later one.
--
-- ADDING THE APPROVAL CHECK closes a finding left open by 0046. The function is
-- SECURITY DEFINER with EXECUTE granted to `authenticated`, and it answers a
-- boolean about an exact path -- so before this, someone authenticated but not
-- an approved member could ask whether a path they already knew was claimed.
-- Rated Low because paths are uuids and `anon` cannot reach it; closed here
-- because widening the function to cover private messages is exactly the wrong
-- moment to leave it open. A commit that widens exposure and a commit that
-- narrows it should not be two commits with a window in between.
--
-- MEASURED that this cannot open deletion backwards. 0046 made this function a
-- DELETE predicate as `not media_object_is_claimed(name)`, so a version that
-- returns false for unapproved callers could in principle ADMIT a delete. It
-- does not: team_files_delete also requires
-- `(storage.foldername(name))[1] = current_member_id()::text or is_staff()`, and
-- for a caller with no member row current_member_id() is null, so that arm
-- evaluates to NULL, `NULL or false` is NULL, and the whole USING expression is
-- NULL -- which RLS does not treat as permission. Checked on the live database
-- with a session whose sub matches no member, rather than reasoned about.
--
-- ALL FOUR claim tables are listed. record_uploads arrives in a sibling
-- migration that is not merged yet; it is included here because create or
-- replace rewrites the whole body, and a version of this function that forgets
-- record_uploads would silently un-do that work the moment this file ran after
-- it. Filename order puts the sibling first on a fresh database, so this file
-- must be the superset rather than a delta.
create or replace function public.media_object_is_claimed(p_path text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.current_member_id() is not null
     and (
       exists (select 1 from public.media_files        where storage_path    = p_path)
       or exists (select 1 from public.notice_attachments where storage_path = p_path)
       or exists (select 1 from public.record_uploads  where storage_path    = p_path)
       or exists (select 1 from public.messages        where attachment_path = p_path)
     )
$$;

comment on function public.media_object_is_claimed(text) is
  '이 경로를 주장하는 행이 어느 청구 표에든 있는지. 승인 회원에게만 답한다. 저장소 정책 셋이 모두 이 함수를 본다.';

-- --------------------------------------------- 2. where a chat object may live
-- `chat` joins the directory list. FIVE entries now, and the sibling migration's
-- `records` is carried for the same reason as above.
--
-- THIS DIRECTORY IS NOT A PRIVACY BOUNDARY, and that sentence is the reason this
-- comment exists. It would be easy to read `<me>/chat/...` as the thing keeping
-- direct messages private. It is not. What keeps them private is that
-- team_file_is_readable is SECURITY INVOKER over messages_read, which admits
-- only the two participants -- 0029 records that 운영진 deliberately have no arm
-- there. The directory is filing, nothing more. Anyone reasoning about who can
-- read a chat attachment must reason about messages_read, not about this regex.
create or replace function public.is_my_media_object_path(p_path text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select p_path is not null
     and public.current_member_id() is not null
     and p_path ~ ('^' || public.current_member_id()::text
                       || '/(media|resources|notices|records|chat)/[^/]+$')
$$;

comment on function public.is_my_media_object_path(text) is
  '내 member id 밑의 알려진 디렉터리에 있는 경로인지. chat 디렉터리는 정리용이며 DM 비공개를 지키는 것은 messages_read다.';

-- ------------------------------------- 3. the library gate, examined and left
-- team_file_library_allows_me is NOT changed, and that is a decision rather than
-- an omission -- the two look identical afterwards, so it is written down.
--
-- It gates `notices/` behind is_staff() and `records/` behind
-- can_manage_records() because those libraries belong to a role. Chat belongs to
-- no role: every approved member may send a direct message, so the `else true`
-- arm is already the correct answer for `chat/`. Adding an arm that returns true
-- would be a line of code asserting nothing, and the next person would have to
-- work out whether it was load-bearing.
--
-- What actually constrains a chat object is the pair above: the path must be
-- under the sender's own id, and a messages row the sender is permitted to write
-- must already claim it.

-- ------------------------------------------------------------- known limit
-- WHAT HAPPENS WHEN THE UPLOAD FAILS, and why the obvious repair is worse.
--
-- The claim gate forces row-then-object, so a failed upload leaves a message
-- whose attachment opens to nothing. The tidy-looking fix is to delete the
-- message. It is wrong here, and the reason is in the client rather than the
-- schema: chat/api.ts subscribes to postgres_changes with event 'INSERT' and
-- nothing else. The recipient has already been handed the row; no DELETE ever
-- reaches them. Deleting would leave a message that exists on their screen and
-- not in the database -- a state neither side can explain, and which resolves
-- only on refresh.
--
-- So the failure stays visible instead, and it is RECOVERABLE: the message row
-- goes on claiming the path, so team_files_update accepts a re-upload to that
-- same path, and the attachment comes alive for everyone who already holds the
-- row, because the URL is signed when it is opened. A compensating delete has no
-- recovery at all.
--
-- FOR WHOEVER BUILDS MESSAGE DELETION: that INSERT-only subscription means your
-- feature inherits this exact ghost. It is not fixed here.
