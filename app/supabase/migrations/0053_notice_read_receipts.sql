-- 0053 — who has read a 공지. One row per (notice, member), written once.
--
-- ============================================================================
-- WHY THE TABLE CARRIES NO POLICIES
-- ============================================================================
--
-- `notice_reads` is RLS-on with zero policies, which denies every normal
-- caller outright. That is not an omission — it is the same shape `attendance`
-- has carried since 0001 (`0001_foundation_and_attendance.sql:169`, and there
-- is still no `create policy ... on attendance` anywhere in this directory).
--
-- The reason is that neither of the two things a caller may do here is
-- expressible as a policy over this table alone.
--
--   marking read    the row's member_id must come from the session, never from
--                   the client. A policy can CHECK `member_id =
--                   current_member_id()` but cannot SUPPLY it, so the client
--                   still has to name itself and every caller has to get that
--                   right. (An earlier version of this note said a WITH CHECK
--                   left the value resting on the client being HONEST. That was
--                   wrong and worth correcting: PostgreSQL rejects an insert
--                   naming somebody else's member_id, so the policy is a real
--                   boundary. What it cannot do is remove the parameter, and a
--                   parameter that does not exist is the one that cannot be
--                   wrong — the same argument 0047 makes about storage paths.)
--
--   reading back    who read a notice is staff-only, and a member must not be
--                   able to see who else read. A SELECT policy of
--                   `member_id = current_member_id() or is_staff()` would work,
--                   and would then be the second place that rule lives —
--                   PostgREST could reach the table directly and the function
--                   below would be one of two doors onto the same question.
--
-- So both doors are SECURITY DEFINER functions and the table has none. The
-- grant on the table is revoked as well as the policies being absent: RLS
-- already refuses, and the standing grant is the half that has to stay wrong
-- for a future `create policy` to become a leak — 0014's argument, unchanged.
--
-- THIS IS A CLAIM ABOUT CLIENT ACCESS, NOT A DATABASE-WIDE INVARIANT. The
-- revoke deliberately leaves `service_role` alone, so anything holding the
-- service key can UPDATE read_at directly and the "written once" property above
-- does not bind it. That is the same latitude every other table in this schema
-- gives it and removing it here alone would buy nothing, but the sentence is
-- worth writing down: "all access goes through the functions" is true of anon
-- and authenticated, which is who the sentence is about.
--
-- ============================================================================
-- WHY FIRST OPEN WINS
-- ============================================================================
--
-- `on conflict do nothing`, never `do update set read_at = now()`.
--
-- The question this table answers is "has this member seen this notice", and
-- that is answered once and then stays answered. `read_at` is therefore the
-- moment they first saw it, which is the only reading of it that supports the
-- screen it exists for — 공지 posted at 09:00, staff wants to know who had seen
-- it by 10:00. Overwriting on every revisit would turn that column into "when
-- were they last on this page", answer a question nobody asked, and destroy the
-- one that was.
--
-- It is also the cheaper concurrency story, though not a contention-free one.
-- A member's phone and laptop opening the same notice at once are two INSERTs
-- racing on the primary key. The second BLOCKS until the first commits — an
-- insert against a matching unique key waits, which PostgreSQL documents — and
-- then does nothing. So there is a wait, and what there is not is a second
-- write. `do update` would have both writing, in an order nothing defines, to a
-- column whose value would be wrong either way.
--
-- Strictly, the first COMMITTED insert wins. A first attempt that rolls back
-- never observably existed.
--
-- ============================================================================
-- ONE BEHAVIOUR TO KNOW ABOUT BEFORE READING THE OUTPUT
-- ============================================================================
--
-- `get_notice_readers_v1` joins to `member_public_v`, not to `members`, so it
-- returns the same public shape (no 실명, no 생년월일, no 메모) that every other
-- roster-facing read in this schema returns.
--
-- That view carries `where status = 'approved'` (0019). The join is therefore
-- inner in effect as well as in form: a member who read a notice and was
-- afterwards blocked, rejected, or reset to pending **disappears from this
-- result**, and the count staff sees goes down with no event to explain it.
-- The receipt row is still there; only the reader stops being nameable.
--
-- That is left as it is on purpose — this function feeds a screen that lists
-- people, and there is no name to list for somebody the roster no longer
-- admits. It is recorded here because a count that silently drops is exactly
-- the shape this project keeps mistaking for a defect elsewhere.

-- ============================================================================
-- ONE THING THE GENERATED TYPES GET WRONG
-- ============================================================================
--
-- `member_public_v.short_name` and `.avatar_path` are both nullable, and
-- `supabase gen types` renders this function's OUT columns as plain `string`.
-- So TypeScript will accept `reader.avatar_path.startsWith(...)` and it will
-- throw at runtime for any reader who has not set an avatar.
--
-- The screens are not written yet, which is the good moment to say it: whatever
-- calls this must treat both as `string | null`. That is a limitation of the
-- generator's view of RETURNS TABLE, not of the data.

-- ---------------------------------------------------------------------------
create table if not exists public.notice_reads (
  notice_id uuid not null references public.notices(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  read_at   timestamptz not null default now(),
  primary key (notice_id, member_id)
);
comment on table public.notice_reads is
  '공지 열람 기록. (notice_id, member_id) 한 쌍당 한 행이며 read_at 은 처음 연 시각이다. 접근은 전부 SECURITY DEFINER 함수를 거친다.';

-- The primary key leads with notice_id, so the cascade from `notices` and the
-- lookup in get_notice_readers_v1 are both covered. member_id is not, and its
-- own FK cascades too — deleting a member would seq-scan this table without
-- it. Same reason 0001 carries attendance_member_idx beside the same shape.
create index if not exists notice_reads_member_idx
  on public.notice_reads (member_id);

-- Zero policies, deliberately. See the header.
alter table public.notice_reads enable row level security;

-- RLS already refuses; this takes away the standing grant as well, so that a
-- policy added later cannot arrive with the grant already in place. 0014 fixed
-- the default privileges for anon only — a new table in public still lands with
-- authenticated holding arwdDxtm, which is right for a table policies gate and
-- wrong for this one.
revoke all on public.notice_reads from public, anon, authenticated;

-- ------------------------------------------------------------------ mark read
-- The reader is derived from the session, never accepted from the client, the
-- same rule append_activity_comment() follows (0050). A client that could name
-- the member could mark a notice read on somebody else's behalf, which is the
-- only way this table can be made to lie.
create or replace function public.mark_notice_read_v1(p_notice_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_member uuid;
begin
  v_member := public.current_member_id();
  if v_member is null then
    raise exception 'not an approved member' using errcode = '42501';
  end if;

  -- The FK would refuse a bad id anyway; this only replaces 23503's raw text
  -- with a sentence, matching append_activity_comment()'s shape. It is not a
  -- guard — a notice deleted between here and the insert still raises 23503.
  if not exists (select 1 from public.notices where id = p_notice_id) then
    raise exception 'no such notice' using errcode = '23503';
  end if;

  -- First open wins. See the header for why this is not `do update`.
  insert into public.notice_reads (notice_id, member_id)
  values (p_notice_id, v_member)
  on conflict (notice_id, member_id) do nothing;
end $$;

comment on function public.mark_notice_read_v1(uuid) is
  '호출한 회원이 그 공지를 읽었음을 한 번만 기록한다. 이미 있으면 아무것도 하지 않으며 read_at 을 덮어쓰지 않는다.';

-- ---------------------------------------------------------------- read it back
-- plpgsql rather than sql, because this has to RAISE.
--
-- attendance_for_activity_v1 gates with `where public.is_staff()` inside a sql
-- body, which returns zero rows to a non-staff caller. That is the wrong answer
-- here: "nobody has read this notice" and "you are not allowed to ask" are
-- different facts, and an empty result presents the second as the first. A
-- member who reached this function would be told, truthfully-looking, about a
-- 공지 nobody had read — and the privacy boundary would leave no trace of
-- having refused anything. 42501 says what happened.
create or replace function public.get_notice_readers_v1(p_notice_id uuid)
returns table (
  member_id   uuid,
  nickname    text,
  short_name  text,
  avatar_path text,
  read_at     timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- A member must not learn who else read a notice. This is the whole gate;
  -- the table has no policy to fall back on.
  if not public.is_staff() then
    raise exception 'only staff may read notice read receipts'
      using errcode = '42501';
  end if;

  -- member_public_v, not members: the public projection is what a roster screen
  -- needs and it is what every other such read in this schema returns.
  --
  -- The view is DEFINER-mode and itself calls current_member_id(), which still
  -- resolves inside this function — SECURITY DEFINER changes whose privileges
  -- the body runs with, not auth.uid(). is_staff() has already passed above, so
  -- the caller is an approved member and the view's own gate cannot refuse them.
  --
  -- Every reference below is schema- or alias-qualified because `returns table`
  -- declares member_id/nickname/read_at as plpgsql variables; an unqualified
  -- column of the same name would be ambiguous.
  return query
    select r.member_id,
           v.nickname,
           v.short_name,
           v.avatar_path,
           r.read_at
      from public.notice_reads r
      join public.member_public_v v on v.id = r.member_id
     where r.notice_id = p_notice_id
     -- Most recent first. nickname breaks the tie so the order is total —
     -- two members opening the notice inside one transaction can share a
     -- read_at, and a list that reshuffles between refreshes reads as a bug.
     order by r.read_at desc, v.nickname;
end $$;

comment on function public.get_notice_readers_v1(uuid) is
  '공지를 읽은 회원 목록. 운영진만 호출할 수 있고, 회원은 다른 사람의 열람 여부를 볼 수 없다.';

-- --------------------------------------------------------------- execute rights
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default, and 0014's
-- `alter default privileges ... revoke all on functions from anon` does not
-- reach that built-in grant. So both roles are named explicitly, and
-- authenticated with them — the revoke/grant pair leaves exactly EXECUTE and
-- nothing inherited, which is the footer shape 0050 uses.
--
-- 0014 left anon holding EXECUTE once already by revoking from public alone.
revoke all on function public.mark_notice_read_v1(uuid)   from public, anon, authenticated;
grant execute on function public.mark_notice_read_v1(uuid) to authenticated;

-- Granted to authenticated, gated to staff by the raise inside. Same division
-- attendance_for_activity_v1 uses: the grant says who may call, the body says
-- who may be answered.
revoke all on function public.get_notice_readers_v1(uuid)   from public, anon, authenticated;
grant execute on function public.get_notice_readers_v1(uuid) to authenticated;
