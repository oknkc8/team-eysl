-- 0054 — 대회 첨부파일: the 요강 and the 편성표 live beside the race.
--
-- ============================================================================
-- WHAT THIS IS, AND HOW LITTLE OF IT IS NEW
-- ============================================================================
--
-- A 대회 is an `activities` row with kind = 'race'. Today it can carry a title,
-- a date, a place and a capacity, and nothing else — so the 대회요강 and the
-- 편성표, which are the two documents a member actually needs before entering,
-- reach the club through KakaoTalk and are gone by the next meet.
--
-- Structurally this is the sixth library in the `team-files` bucket and it
-- copies the fifth almost exactly. 0040 built 공지 첨부 and settled the shape:
-- a claim table, the row before the object, and a SECURITY DEFINER function
-- that derives the storage path so the client has no parameter in which to name
-- one. 0043 then showed what adding a library costs — three predicates widened
-- together — and 0047 added the fifth and restated why the derived path is the
-- best of the three designs this repo has tried:
--
--   save_notice_v1     the SERVER derives the path      no client parameter
--   send_message_v1    client names it, server VALIDATES  is_my_team_file_path
--   record_uploads     client named it, NOTHING checked   closed by 0044
--
-- 0047 left an instruction — "WHEN THE NEXT FUNCTION TAKES AN ATTACHMENT,
-- DERIVE THE PATH SERVER-SIDE" — and this is the next function. So
-- add_race_attachment_v1 takes a file name and a mime type and nothing else.
-- A caller cannot claim a path under somebody else's member id, not because a
-- check refuses it but because there is no argument that could say it; and the
-- member-supplied name never reaches the key, so no sanitising rule about
-- `../`, a null byte, or a name that is entirely dots has to be right.
--
-- ============================================================================
-- WHO MAY ATTACH: is_staff(), AND THE TWO NEARER ANSWERS THAT WERE REJECTED
-- ============================================================================
--
-- The gate is `is_staff()` — admin or master_admin — and the argument is that
-- an attachment is an edit to the race rather than a thing of its uploader's.
-- The race itself is staff-only in both directions already:
--
--   activities_write   for all using (is_staff()) with check (is_staff())
--                      0001:182-184, unchanged by any later migration
--
-- So a member cannot create the 대회, cannot rename it, cannot move its date —
-- and it would be odd for the one part of it they COULD write to be a document
-- published to the whole club. That is the second half of the argument and it
-- is the load-bearing one: unlike everything else in this bucket, a race
-- attachment is read by every approved member. 0021 opened `media/` and
-- `resources/` to every member deliberately, and that decision is safe because
-- those objects are the uploader's own library. There is no other place in this
-- schema where a member can put a file in front of the entire club without a
-- staffer, and this migration is not the place to invent one.
--
-- REJECTED, can_manage_records() — the gate 0043 chose for `records/`. It is
-- wider by one set: a 코치 holds it through team_role, and a coach is very
-- plausibly the person who has the 요강 in hand. It is rejected because a coach
-- cannot create or edit the race the attachment hangs off, so the permission
-- would have no screen to live on: they could add a file to a 대회 they cannot
-- otherwise touch, and could not create the 대회 to attach it to. A permission
-- that only half exists is worse than one that does not.
--
--   THIS IS A QUESTION FOR THE PRESIDENT rather than a closed decision. If a
--   코치 should be able to post the 요강, the honest change is to widen
--   activities_write for kind = 'race' as well, and then this gate follows it.
--   Do not widen this one alone.
--
-- REJECTED, is_master_admin() — too narrow, and inconsistent with the nearest
-- neighbour: 공지 첨부 is is_staff() (0040), and publishing a document to the
-- club is the same act in both screens.
--
-- ============================================================================
-- WHY THIS TABLE HAS A READ POLICY WHERE 0053's HAS NONE
-- ============================================================================
--
-- 0053 landed one migration ago with a table carrying RLS and ZERO policies,
-- and its header makes the case well. The same shape here would break every
-- download in this feature, silently, and the reason is worth setting out
-- because nothing in the table definition hints at it.
--
-- Reading an object out of `team-files` goes through team_files_read (0029:324),
-- which asks `team_file_is_readable(name)`. That function is SECURITY INVOKER
-- on purpose (0036) — each claim table's own RLS decides who may read the
-- object, so the boundary is stated once, in the policy, rather than twice.
--
-- Follow it through with no policy on this table: the storage policy calls the
-- predicate as `authenticated`, the predicate's `exists (select 1 from
-- race_attachments …)` is answered by RLS, RLS with no policy returns no rows,
-- the predicate says false, and the download is refused. For everyone.
-- Including the staffer who uploaded it thirty seconds earlier. Nothing raises;
-- the object simply cannot be fetched.
--
-- So the table gets exactly one policy — SELECT, for any approved member — and
-- that policy IS the read boundary for the objects, not merely for the rows.
-- It is `activity_applications`' shape from 0001: a read policy and no write
-- policy at all, so INSERT and DELETE reach the table only through the two
-- SECURITY DEFINER functions below.
--
-- The grant is narrowed to match, for 0053's and 0014's reason: a new table in
-- `public` still arrives with `authenticated` holding arwdDxtm, and the write
-- half of that has to go, or a `create policy … for insert` added later becomes
-- a leak the moment somebody writes it. SELECT is the one privilege that must
-- survive — `team_file_is_readable` runs as the caller and needs it.
--
-- ============================================================================
-- AT MOST EIGHT, AND WHERE THAT IS ACTUALLY ENFORCED
-- ============================================================================
--
-- Upstream's race-attachment-v123.js caps it at 8. The cap lives in
-- add_race_attachment_v1, and the claim that this is enforcement rather than
-- decoration rests entirely on the paragraph above: this table has no INSERT
-- policy and no INSERT grant, so the RPC is not the front door, it is the only
-- door. A client that skips it does not get 9 attachments, it gets a refusal
-- from RLS.
--
-- IT IS A NAMED ERROR, NOT A CONSTRAINT VIOLATION. `22023` with a Korean
-- sentence, the shape save_notice_v1 uses for its own cap (0040:553). A CHECK
-- cannot express a count across sibling rows anyway, but even where one could,
-- what reaches the member from a violated constraint is the constraint's name.
--
-- THE COUNT IS TAKEN UNDER A LOCK, and without it the cap is advisory. Two
-- staffers uploading at once both read 7, both insert, and the race ends with
-- 9 — the same shape as the legacy training-capacity race (index.html:2384)
-- that 0001 and 0020 exist to prevent. `select … from activities where id = …
-- for update` serialises them on the race row: the second blocks, and when it
-- proceeds it re-reads and sees 8.
--
--   The lock is on `activities`, which offer_seat_to_next_waitlister also
--   touches. Contention is one row per race and both holders are short, so this
--   is noted rather than defended against.
--
-- ============================================================================
-- THE FIVE PLACES
-- ============================================================================
--
-- 0036 named four and 0040 corrected it to five: a new claim table has to be
-- taught to the claim gate, the read predicate, the adoption select, the
-- enqueue trigger and the release trigger, or the first file uploaded is
-- classified as debris by the very next sweep. Plus, since 0043, the path shape
-- and the library gate, which that list predates.
--
--   is_my_media_object_path      `races` added to the alternation
--   media_object_is_claimed      race_attachments added
--   team_file_library_allows_me  a `races/` arm -> is_staff()
--   team_file_is_readable        race_attachments added
--   enqueue_object_deletion      race_attachments added to the guard
--   the four lifecycle triggers  created on race_attachments
--   the adoption select          NOT run, and see below
--
-- The adoption select is the one that does not move, and that is a decision.
-- It is 0036's one-off `insert … select` that swept objects stranded BEFORE the
-- queue existed. This table is created in this file, so it claims no path that
-- predates it and there is nothing to adopt. Written down because "six of seven
-- were updated" is otherwise the shape of an omission.
--
-- Every one of the five functions is restated as a SUPERSET read out of the
-- migration that currently owns it, never rebuilt from a description of it —
-- 0024 lost a parameter that way, and `create or replace` rewrites the whole
-- body, so a version of any of these that forgets an existing arm silently
-- un-does the migration that added it. The owners, at the time of writing:
--
--   is_my_media_object_path      0047
--   media_object_is_claimed      0047
--   team_file_library_allows_me  0043
--   team_file_is_readable        0036
--   enqueue_object_deletion      0046
--
-- ============================================================================
-- ONE DOOR FOR READS, NOT TWO — a deliberate departure from the brief
-- ============================================================================
--
-- There is no list_race_attachments_v1, and the screen selects the table
-- directly, exactly as listAttachments() does for notice_attachments.
--
-- The reason is 0053's own argument, which applies here and reaches the
-- opposite conclusion because the premise differs. 0053 declined a SELECT
-- policy because a function was already the door and a policy would have been
-- a second statement of the same rule. Here the policy is not optional — the
-- section above shows the storage read cannot work without it — so a list
-- function would be the second door, and the rule "any approved member may see
-- a race's attachments" would live in two places that can drift.
--
-- ============================================================================
-- KNOWN LIMITS
-- ============================================================================
--
-- A REMOVED ATTACHMENT'S OBJECT LEAVES LATER, AND ONLY A STAFFER CAN FINISH IT.
-- remove_race_attachment_v1 deletes the row; the trigger queues the path; the
-- bytes go when a session sweeps pending_object_deletions. team_files_delete
-- (0046) also asks team_file_library_allows_me, so a `races/` path is only
-- sweepable by is_staff(). A member opening 미디어 drains what they may drain
-- and leaves this queued. Identical to `notices/` since 0040; not new, and not
-- fixed here.
--
-- AN UPLOAD THAT FAILS LEAVES A ROW WHOSE FILE OPENS TO NOTHING. That is
-- 0040's accepted failure and this feature inherits it deliberately: it is
-- VISIBLE, as an attachment a staffer can see and remove, where the reverse
-- ordering would produce bytes no row points at and nobody can find. The row
-- goes on claiming the path, so team_files_update accepts a re-upload to the
-- same key and the attachment comes alive without anything being re-created.

-- =========================================================== the claim table
create table if not exists public.race_attachments (
  id            uuid primary key default gen_random_uuid(),
  activity_id   uuid not null references public.activities(id) on delete cascade,
  storage_path  text not null unique,
  file_name     text not null,
  mime_type     text not null default 'application/octet-stream',
  sort_order    int not null default 0,
  -- Who uploaded it, for the same reason notice_comments keys on member_id
  -- rather than copying a nickname (0004): a nickname is a display value that
  -- goes stale, and this one is wanted for "who put this here" in six months.
  -- No ON DELETE arm: a member row is never deleted while they hold content —
  -- record_uploads.uploaded_by takes the same shape (0004:57).
  created_by    uuid not null references public.members(id),
  created_at    timestamptz not null default now()
);

comment on table public.race_attachments is
  '대회(activities.kind = ''race'')에 딸린 첨부파일. team-files 버킷의 경로만 저장하며, 경로는 add_race_attachment_v1이 만들고 클라이언트가 정하지 않는다.';

-- storage_path is UNIQUE, which notice_attachments is not, and it is worth one
-- line. Every path here is `<member id>/races/<fresh uuid>`, so a duplicate can
-- only arrive from a bug — and a duplicate is precisely what breaks the
-- deletion queue, since pending_object_deletions is keyed on the path alone
-- (0036). Two rows claiming one path make "does anything still claim this"
-- answerable two ways. The constraint costs nothing and closes it.

-- The index the screen reads by, and the order it renders in.
create index if not exists race_attachments_activity_idx
  on public.race_attachments (activity_id, sort_order);

alter table public.race_attachments enable row level security;

-- The ONE policy. See the header: this is the read boundary for the objects as
-- well as for the rows, because team_file_is_readable is SECURITY INVOKER.
-- Same predicate activities_read carries (0001:180) — if you may see the race,
-- you may see what is attached to it.
drop policy if exists race_attachments_read on public.race_attachments;
create policy race_attachments_read on public.race_attachments
  for select using (public.current_member_id() is not null);

comment on policy race_attachments_read on public.race_attachments is
  '승인 회원이면 누구나 읽는다. 이 정책은 행뿐 아니라 객체의 읽기 경계이기도 하다 — team_file_is_readable이 SECURITY INVOKER라 이 정책이 그대로 답한다.';

-- No write policy at all, so INSERT/UPDATE/DELETE reach this table only through
-- the two functions below. The grant is narrowed to match: a new table in
-- public arrives with authenticated holding arwdDxtm, and leaving the write
-- half in place is what makes a policy added later into a leak (0014, 0053).
-- SELECT must survive — team_file_is_readable runs as the caller.
revoke all on public.race_attachments from public, anon, authenticated;
grant select on public.race_attachments to authenticated;

-- ============================================================ the path shape
-- 0047's function with `races` added to the alternation. Everything else — the
-- anchor, both null checks, the single trailing segment — is unchanged, and the
-- five existing directories are carried because create or replace rewrites the
-- whole body.
--
-- THIS DIRECTORY *IS* AN AUTHORIZATION INPUT, unlike `chat/`. 0047 warned
-- against generalising from its own comment, and this is the other case:
-- team_file_library_allows_me reads this prefix and requires is_staff() for it,
-- exactly as `records/` requires can_manage_records(). A prefix means whatever
-- a policy is written to make it mean; here a policy is written.
create or replace function public.is_my_media_object_path(p_path text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select p_path is not null
     and public.current_member_id() is not null
     and p_path ~ ('^' || public.current_member_id()::text
                       || '/(media|resources|notices|records|chat|races)/[^/]+$')
$$;

comment on function public.is_my_media_object_path(text) is
  '내 member id 밑의 알려진 디렉터리에 있는 경로인지. races 디렉터리는 team_file_library_allows_me가 운영진으로 제한한다.';

-- ============================================================= the claim gate
-- 0047's function with a fifth claim table. The approval check it added stays,
-- and so does every existing arm — a version of this that forgot `messages`
-- would make chat attachments un-uploadable and un-deletable in one move.
--
-- SECURITY DEFINER is preserved and is why the new arm needs no thought about
-- who may see what: the question is "does any row claim this path", not "may
-- you read that row". Who may CREATE a claim here was decided by
-- add_race_attachment_v1's is_staff() check, which is the only door in.
create or replace function public.media_object_is_claimed(p_path text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select public.current_member_id() is not null
     and (
       exists (select 1 from public.media_files         where storage_path    = p_path)
       or exists (select 1 from public.notice_attachments where storage_path  = p_path)
       or exists (select 1 from public.record_uploads   where storage_path    = p_path)
       or exists (select 1 from public.messages         where attachment_path = p_path)
       or exists (select 1 from public.race_attachments where storage_path    = p_path)
     )
$$;

comment on function public.media_object_is_claimed(text) is
  '이 경로를 주장하는 행이 어느 청구 표에든 있는지. 승인 회원에게만 답한다. 저장소 정책 셋이 모두 이 함수를 본다.';

-- ============================================================ the library gate
-- 0043's function with a third arm. The CASE shape is kept for the reason 0043
-- gives: each library names its own gate and a library with no arm falls
-- through to `true`, which is what media/ and resources/ want.
--
-- `races/` -> is_staff(), matching notices/. The header argues it at length;
-- the short form is that the race itself is is_staff() in activities_write and
-- an attachment is an edit to the race.
--
-- This also decides who may DELETE the object, not only who may write it:
-- team_files_delete (0046) asks this same function, so a demoted staffer can no
-- longer take down a 대회 첨부 they uploaded, and neither can the member whose
-- id is the first path segment. That asymmetry is 0040's and is intended.
create or replace function public.team_file_library_allows_me(p_path text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select case
           when p_path ~ '^[^/]+/notices/' then public.is_staff()
           when p_path ~ '^[^/]+/records/' then public.can_manage_records()
           when p_path ~ '^[^/]+/races/'   then public.is_staff()
           else true
         end
$$;

comment on function public.team_file_library_allows_me(text) is
  '경로가 속한 라이브러리가 나에게 열려 있는가. notices/와 races/는 운영진, records/는 기록 관리자(코치 포함), 나머지는 승인 회원 모두.';

-- ========================================================== the read predicate
-- 0036's function with a sixth arm, read out of that file rather than rebuilt.
-- SECURITY INVOKER is preserved and is the whole reason this arm needs no
-- decision of its own: race_attachments_read answers, and it admits every
-- approved member, so a 대회 첨부 is readable by exactly the people who can see
-- the 대회.
--
-- The pending_object_deletions arm is carried unchanged. It is what keeps a
-- queued object reachable to whoever can finish removing it, and dropping it
-- while restating this function would strand every queued object in the bucket.
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
       or exists (select 1 from public.race_attachments
                   where storage_path = p_path)
       or exists (select 1 from public.pending_object_deletions
                   where storage_path = p_path)
     )
$$;

comment on function public.team_file_is_readable(text) is
  '이 호출자가 해당 경로를 가리키는 행을 볼 수 있는지. SECURITY INVOKER라서 각 테이블의 RLS가 그대로 답한다. 삭제 대기열도 포함한다.';

-- ======================================================== the lifecycle guard
-- 0046's body with one arm added to the exists() chain and NOTHING else
-- touched. Checked the way 0046 checked its own restatement: every line that
-- differs from 0046's version is either a comment or the one new exists().
--
-- The guard has to know about this table in BOTH directions. A trigger firing
-- on race_attachments must not queue a path some other table still claims; and
-- a trigger firing on any of the other four must not queue a path a
-- race_attachments row still claims. One function, five arms, both directions.
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
  -- 0054 adds race_attachments as a FIFTH claim table below. Nothing else in
  -- this function or its comments is changed from 0046; the paragraphs that
  -- follow are that file's verbatim, including both corrections it records.
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
     or exists (select 1 from public.record_uploads where storage_path = v_path)
     or exists (select 1 from public.race_attachments where storage_path = v_path) then
    return null;
  end if;

  insert into public.pending_object_deletions (storage_path, requested_by)
  values (v_path, public.current_member_id())
  on conflict (storage_path) do nothing;

  return null;
end $$;

comment on function public.enqueue_object_deletion() is
  '청구 표에서 행이 사라지면 그 객체를 삭제 대기열에 올린다. 다른 표가 같은 경로를 아직 주장하면 올리지 않는다. 경로 컬럼 이름은 트리거 인자로 받는다.';

-- ---------------------------------------------------------------- triggers
-- The fifth claim table joins the four 0040 wired. release_object_deletion is
-- reused unchanged — this table's path column is named storage_path, so the
-- default argument is right and no third function is needed.
--
-- The release side matters MORE here than for media, because the claim gate
-- forces the row before the object: remove an attachment and add another that
-- happens to land on a queued path, and a surviving queue entry would have the
-- next sweep delete an object a live row legitimately claims. That collision
-- needs a uuid to repeat, so it is a guard rather than a live hazard.
drop trigger if exists race_attachments_enqueue_object_deletion on public.race_attachments;
create trigger race_attachments_enqueue_object_deletion
  after delete on public.race_attachments
  for each row execute function public.enqueue_object_deletion();

drop trigger if exists race_attachments_release_object_deletion on public.race_attachments;
create trigger race_attachments_release_object_deletion
  after insert on public.race_attachments
  for each row execute function public.release_object_deletion();

-- The UPDATE pair, for 0040's reason. No screen moves a path today and no
-- function here offers it, so these fire for nothing at present — which is
-- exactly why they go in now, before a feature makes them necessary and nobody
-- remembers that DELETE and INSERT are not the only ways a claim moves.
drop trigger if exists race_attachments_enqueue_on_path_change on public.race_attachments;
create trigger race_attachments_enqueue_on_path_change
  after update of storage_path on public.race_attachments
  for each row when (old.storage_path is distinct from new.storage_path)
  execute function public.enqueue_object_deletion();

drop trigger if exists race_attachments_release_on_path_change on public.race_attachments;
create trigger race_attachments_release_on_path_change
  after update of storage_path on public.race_attachments
  for each row when (old.storage_path is distinct from new.storage_path)
  execute function public.release_object_deletion();

-- =============================================================== attaching
-- Returns the row it created, because the client's next step is to upload the
-- object to exactly the key named here and it must not compute one. The reply
-- carries the path so there is nothing left to derive on the browser side.
create or replace function public.add_race_attachment_v1(
  p_activity_id uuid,
  p_file_name   text,
  p_mime_type   text
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_me    uuid;
  v_kind  text;
  v_count int;
  v_order int;
  v_id    uuid;
  v_path  text;
  v_name  text;
  v_mime  text;
begin
  -- SECURITY DEFINER means race_attachments' policies are not consulted, so
  -- this line is the whole of the enforcement — the same division save_notice_v1
  -- states for itself. The header argues why it is is_staff() and not
  -- can_manage_records().
  if not public.is_staff() then
    raise exception '대회 첨부파일은 운영진만 올릴 수 있습니다' using errcode = '42501';
  end if;

  v_me := public.current_member_id();

  -- LOCKED, THEN COUNTED, THEN INSERTED, all in one transaction. Without the
  -- lock two staffers uploading at once both read 7 and the race ends with 9.
  -- The lock is on the race rather than on this table because there is no row
  -- here yet to lock, and the race is the thing the cap is per.
  select a.kind into v_kind
    from public.activities a
   where a.id = p_activity_id
     for update;

  if not found then
    raise exception 'no such activity' using errcode = '42704';
  end if;

  -- A 훈련 has no 요강 and an 기타 is not a meet. Checked rather than left to
  -- the FK, which only knows the row exists: the table's name says race and a
  -- row that contradicts it would be invisible to every screen that reads it.
  if v_kind <> 'race' then
    raise exception '대회에만 첨부파일을 올릴 수 있습니다' using errcode = '22023';
  end if;

  select count(*), coalesce(max(r.sort_order) + 1, 0)
    into v_count, v_order
    from public.race_attachments r
   where r.activity_id = p_activity_id;

  -- Named, in Korean, and reachable by a member. A CHECK constraint cannot
  -- count sibling rows, and what a violated constraint hands the screen is its
  -- own name. 8 is upstream's number (race-attachment-v123.js).
  if v_count >= 8 then
    raise exception '대회 첨부파일은 최대 8개까지 올릴 수 있습니다' using errcode = '22023';
  end if;

  -- max(sort_order)+1 rather than the count, so removing the third of four
  -- cannot make the next upload collide with an existing position.
  v_id   := gen_random_uuid();
  v_path := v_me::text || '/races/' || v_id::text;

  -- Stored for display only. It is never part of the object key, so this is a
  -- tidiness rule rather than a safety one — and that is the whole point of
  -- deriving the path here. NO EXTENSION ON THE OBJECT either: deriving one
  -- would mean reading member input to build a key, which is precisely the
  -- problem this design avoids. mime_type carries the kind.
  v_name := left(btrim(coalesce(nullif(p_file_name, ''), '파일')), 200);
  v_mime := coalesce(nullif(p_mime_type, ''), 'application/octet-stream');

  insert into public.race_attachments
    (id, activity_id, storage_path, file_name, mime_type, sort_order, created_by)
  values (v_id, p_activity_id, v_path, v_name, v_mime, v_order, v_me);

  return jsonb_build_object(
    'id',           v_id,
    'activity_id',  p_activity_id,
    'storage_path', v_path,
    'file_name',    v_name,
    'mime_type',    v_mime,
    'sort_order',   v_order);
end $$;

comment on function public.add_race_attachment_v1(uuid, text, text) is
  '대회 첨부 행을 만들고 저장소 경로를 돌려준다. 경로는 <내 member id>/races/<uuid>로 이 함수가 만들며 호출자가 정할 수 없다. 대회당 8개까지.';

-- ================================================================ removing
-- The row goes; the object follows through the queue. Nothing here touches
-- storage: the enqueue trigger records the path and the sweeper removes the
-- bytes, which is what makes an interrupted delete survivable (0036).
create or replace function public.remove_race_attachment_v1(p_attachment_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_found uuid;
begin
  -- Staff, not the uploader. Symmetrical with attaching, and with
  -- notice_attachments: these files belong to the 대회 rather than to whoever
  -- happened to upload them, so a staffer must be able to take down a wrong
  -- 편성표 posted by a colleague who is on holiday. It is also the only reading
  -- that works, since team_files_delete already requires is_staff() for a
  -- `races/` path — an owner-only rule here would delete rows whose objects
  -- their owner could not then sweep.
  if not public.is_staff() then
    raise exception '대회 첨부파일은 운영진만 삭제할 수 있습니다' using errcode = '42501';
  end if;

  delete from public.race_attachments
   where id = p_attachment_id
  returning id into v_found;

  -- 42704 rather than silence. "It was already gone" and "you asked about
  -- something that never existed" reach the screen the same way otherwise, and
  -- a delete that reports success for an id it never saw is the shape that lets
  -- a client believe a stale list.
  if v_found is null then
    raise exception 'no such race attachment' using errcode = '42704';
  end if;
end $$;

comment on function public.remove_race_attachment_v1(uuid) is
  '대회 첨부 행을 지운다. 객체는 트리거가 삭제 대기열에 올리고 나중에 스윕에서 빠진다. 운영진만 호출할 수 있다.';

-- =========================================================== execute rights
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default and 0014's
-- default-privileges change does not reach that built-in grant, so both roles
-- are named explicitly and `authenticated` with them. Writing only
-- `revoke from public` is what left anon holding EXECUTE in 0014.
revoke all on function public.add_race_attachment_v1(uuid, text, text)    from public, anon, authenticated;
grant execute on function public.add_race_attachment_v1(uuid, text, text)  to authenticated;

revoke all on function public.remove_race_attachment_v1(uuid)   from public, anon, authenticated;
grant execute on function public.remove_race_attachment_v1(uuid) to authenticated;

-- THE FIVE RESTATED FUNCTIONS KEEP authenticated=X, AND TAKING IT AWAY IS THE
-- MISTAKE 0043 MADE AND RECORDED. They are called from storage policies rather
-- than from a browser, and the conclusion "so they need no client grant" does
-- not follow: an RLS policy expression is evaluated as the CALLING role, so it
-- is `authenticated` that executes is_my_media_object_path() inside
-- team_files_insert's WITH CHECK. SECURITY DEFINER decides whose privileges the
-- BODY runs with; it does not excuse the caller from needing EXECUTE. 0043's
-- draft revoked these and broke every upload in the app.
--
-- create or replace preserves an ACL, so this touches it as little as possible:
-- revoke the two roles that must never hold it, restate the one grant that must
-- survive. Verify by reading the live ACL after applying and comparing these
-- five against their untouched siblings — is_my_avatar_object_path and
-- is_my_team_file_path — rather than by reading this file.
revoke all on function public.is_my_media_object_path(text)     from public, anon;
revoke all on function public.media_object_is_claimed(text)     from public, anon;
revoke all on function public.team_file_library_allows_me(text) from public, anon;
revoke all on function public.team_file_is_readable(text)       from public, anon;

grant execute on function public.is_my_media_object_path(text)     to authenticated;
grant execute on function public.media_object_is_claimed(text)     to authenticated;
grant execute on function public.team_file_library_allows_me(text) to authenticated;
grant execute on function public.team_file_is_readable(text)       to authenticated;

-- enqueue_object_deletion and release_object_deletion stay granted to nobody:
-- they are trigger functions, invoked by the executor rather than called, and a
-- grant would only make them callable directly.
revoke all on function public.enqueue_object_deletion() from public, anon, authenticated;
revoke all on function public.release_object_deletion() from public, anon, authenticated;

-- ============================================================================
-- CLOSING WHAT WIDENING A SHARED PREDICATE OPENED
-- ============================================================================
--
-- Adding `races` to is_my_media_object_path above is right for STORAGE and
-- wrong for everything else that calls the same function — and it took an
-- adversarial review to notice that anything else does. Measured live:
--
--   storage.objects   team_files_insert / team_files_update    <- wants races
--   public.media_files  media_files_insert / media_files_update  <- must not
--
-- media_files_insert's whole WITH CHECK is
--   uploader_id = current_member_id() AND is_my_media_object_path(storage_path)
-- so widening the regex widens that policy too. An approved member could then
-- insert a media_files row claiming <own id>/races/<uuid>, and the consequence
-- is not an odd row: enqueue_object_deletion treats ANY claim as a reason not
-- to queue the object. Staff removes the race attachment, the bytes survive
-- because a media_files row still claims them, and they surface as that
-- member's own resource — reachable after the uploader has been demoted, and
-- not removable by staff, because media_files rows are owner-only.
--
-- THE HOLE IS OLDER THAN THIS MIGRATION, which is the part worth writing down.
-- The same predicate already admits `notices`, `records` and `chat`, so a
-- member can claim any of those paths in media_files today. 0054 would have
-- added a fourth library to a gap that was already three wide.
--
-- So the fix is not to un-widen the storage predicate — storage genuinely needs
-- races. It is to stop media_files borrowing a predicate that answers a
-- different question. media_files owns `media/` and `resources/`; every other
-- library has its own claim table and always did.
--
-- The general shape, because this will happen again: WIDENING A PREDICATE
-- WIDENS EVERY POLICY THAT CALLS IT. Before changing one, ask what else calls
-- it —
--   select tablename, policyname from pg_policies
--    where coalesce(qual,'') || coalesce(with_check,'') like '%<fn>%';
-- — rather than only whether the change reads correctly where you meant it. A
-- diff that is a faithful one-line widening can still be wrong somewhere the
-- diff does not show.

create or replace function public.is_my_media_library_path(p_path text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select p_path is not null
     and public.current_member_id() is not null
     and p_path ~ ('^' || public.current_member_id()::text
                       || '/(media|resources)/[^/]+$')
$$;

comment on function public.is_my_media_library_path(text) is
  'media_files 가 청구할 수 있는 경로인가. media/ 와 resources/ 만 해당하며, 다른 라이브러리는 각자의 청구 테이블을 가진다.';

revoke all on function public.is_my_media_library_path(text) from public, anon;
grant execute on function public.is_my_media_library_path(text) to authenticated;

drop policy if exists media_files_insert on public.media_files;
create policy media_files_insert on public.media_files
  for insert to authenticated
  with check (uploader_id = public.current_member_id()
              and public.is_my_media_library_path(storage_path));

drop policy if exists media_files_update on public.media_files;
create policy media_files_update on public.media_files
  for update to authenticated
  using (uploader_id = public.current_member_id())
  with check (uploader_id = public.current_member_id()
              and public.is_my_media_library_path(storage_path));

