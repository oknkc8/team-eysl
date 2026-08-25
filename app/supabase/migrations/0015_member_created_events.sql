-- 0015 — let an approved member file a 기타 일정, and let only its creator change it.
--
-- The president's app changed two things at once. The third activity kind is now
-- labelled 기타 rather than 이벤트 — the word 이벤트 was reassigned to a rankings
-- hub, a different feature entirely — and the permission model around it opened:
--
--   canCreateActivityType(kind){ return kind==='event' ? !!currentUser.memberId : isAdminUser() }
--   canEditActivityItem(item,kind){ return kind==='event' ? item.createdBy===currentUser.memberId : isAdminUser() }
--
-- (his index.html:3761-3762). Any approved member may create a 기타; its creator
-- alone may edit or delete it; 훈련 and 대회 stay staff-only.
--
-- The rename is a label, not a token. activities.kind still stores 'event' in
-- live rows and the CHECK at 0001:50 still names it, so renaming the token would
-- be a data migration that buys nothing. Korean stays a render-time concern,
-- which is the split KIND_LABEL already describes in app/src/features/schedule.
--
-- What actually has to change is 0001:182-184, which gave this table a single
-- write policy — is_staff() for every command and every kind. Under it a member
-- creating a 기타 is refused outright.

comment on table public.activities is
  '훈련·대회·기타 일정. 신청자 명단은 activity_applications가 정본이며 details에 복사하지 않는다. 기타는 승인 회원 누구나 등록하고 등록자만 수정·삭제한다.';

-- ------------------------------------------------------- created_by is derived
-- A BEFORE trigger rather than a SECURITY DEFINER RPC, deliberately.
--
-- Every other server-authoritative write here is an RPC — apply_to_activity,
-- attendance_mark_v1, upsert_record, send_message_v1 — because each has a
-- decision to make under a lock: which seat, which wait order, whether the
-- caller may act at all. Ownership of a new row is not a decision. It is one
-- column read off the session, and an RPC for it would mean two write paths into
-- activities (a function for members, the existing direct insert for staff) with
-- one rule to keep in step across both.
--
-- A trigger covers every path into the table instead. That is the argument
-- 0006:97-100 already made for on_participant_cancelled: a rule enforced at the
-- call site has to be repeated at each call site, and the one that gets
-- forgotten is the hole.
create or replace function public.activities_set_created_by()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_member uuid;
begin
  v_member := public.current_member_id();

  -- No session member means nobody to attribute the row to: a migration, a
  -- backfill, or a service-role job acting as the server itself. Those keep
  -- whatever they supplied, which is also what keeps a future backfill of this
  -- column possible. The branch is unreachable from a browser — an authenticated
  -- caller whose member row is not approved gets null here too, and both write
  -- policies below refuse them for exactly that reason.
  if v_member is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- Never read off the request. A member who can send created_by can file an
    -- activity in somebody else's name and then edit it as its owner.
    new.created_by := v_member;
  else
    -- Immutable once set. Without this, "you may edit your own row" and "you may
    -- write created_by" compose into taking over anybody's 기타 in one UPDATE.
    new.created_by := old.created_by;
  end if;

  return new;
end $$;

comment on function public.activities_set_created_by() is
  '등록자를 세션에서 직접 채운다. 클라이언트가 보낸 created_by는 무시하고, 수정 시에는 값을 고정한다.';

drop trigger if exists activities_created_by on public.activities;
create trigger activities_created_by
  before insert or update on public.activities
  for each row execute function public.activities_set_created_by();

-- ------------------------------------------------------------------- policies
-- Unchanged in meaning: staff keep every command on every kind. Restated so the
-- whole write story for this table reads in one place rather than half here and
-- half in 0001.
drop policy if exists activities_write on public.activities;
create policy activities_write on public.activities
  for all using (public.is_staff()) with check (public.is_staff());

-- A member may file a 기타 and nothing else. created_by is tested here as well
-- as forced by the trigger: the trigger is what makes this correct, the policy
-- is what keeps it correct if somebody ever drops the trigger.
--
-- No `to authenticated` clause, matching the rest of this schema — anon has no
-- member row, so current_member_id() is null for them and the comparison is null
-- rather than true.
drop policy if exists activities_member_event_insert on public.activities;
create policy activities_member_event_insert on public.activities
  for insert
  with check (kind = 'event' and created_by = public.current_member_id());

-- USING sees the row as it stands, WITH CHECK the row as it would become, and
-- the pair is closed only when both name both facts. Each half alone leaves a
-- way through:
--
--   * WITH CHECK alone would let a member edit anybody's 기타, because nothing
--     would test who owns the row being changed.
--   * USING alone would let the owner set kind = 'training' and walk their own
--     row into the staff-only half of the table.
--   * USING testing ownership but not kind would let somebody who created a
--     훈련 while they were staff keep editing it after being demoted.
drop policy if exists activities_member_event_update on public.activities;
create policy activities_member_event_update on public.activities
  for update
   using (kind = 'event' and created_by = public.current_member_id())
  with check (kind = 'event' and created_by = public.current_member_id());

-- Deleting cascades to activity_applications and, through it, to attendance
-- (0001:73, 0001:100). That is the creator throwing away their own 기타 along
-- with who signed up for it, which is the model the president's client already
-- runs; the screen spells the cascade out before asking.
drop policy if exists activities_member_event_delete on public.activities;
create policy activities_member_event_delete on public.activities
  for delete
  using (kind = 'event' and created_by = public.current_member_id());

-- --------------------------------------------------------------- execute rights
-- Revoked by name as well as from PUBLIC, the lesson 0002 and 0011:163-168 both
-- record. Not granted back to anyone: PostgreSQL checks EXECUTE on a trigger
-- function when the trigger is created, not when it fires, so a member's insert
-- still runs it.
revoke all on function public.activities_set_created_by() from public, anon, authenticated;

-- No table grants change. `authenticated` already holds INSERT/UPDATE/DELETE on
-- activities — staff have been writing through them since 0001 — and RLS is what
-- decides which rows. Noted while checking: `authenticated` also holds TRUNCATE
-- and REFERENCES on this table (and on the other nine 0014 lists), inherited
-- from Supabase's defaults. TRUNCATE is not subject to RLS and PostgREST exposes
-- no way to issue it, so nothing reaches it today — but it is surplus, it is
-- schema-wide rather than about this feature, and stripping it belongs in a
-- migration of its own alongside the rest of them.
