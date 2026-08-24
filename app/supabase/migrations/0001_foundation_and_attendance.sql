-- 0001 — foundation tables plus the attendance feature.
--
-- Scope is slice 1 deliberately: members/activities/applications are the minimum
-- needed to make attendance meaningful, and attendance is the one feature the
-- legacy app silently loses (setAtt/togglePaid at index.html:3780-3781 mutate an
-- in-memory object and never reach a database; no attendance table ever existed).
--
-- Notices, records, media and messages land in 0002. Applies to an empty database.

-- ---------------------------------------------------------------------- members
create table if not exists public.members (
  id                               uuid primary key default gen_random_uuid(),
  auth_user_id                     uuid unique references auth.users(id) on delete set null,
  nickname                         text not null,
  short_name                       text,
  real_name                        text,
  birth_year                       smallint,
  birth_date_text                  text,
  gender                           text,
  join_date_text                   text,
  join_reason                      text,
  lesson_level                     text,
  swim_experience                  text,
  notes                            text,
  location                         text,
  avatar_path                      text,
  team_role                        text,
  status                           text not null default 'pending'
                                     check (status in ('pending','approved','rejected','blocked')),
  role                             text not null default 'member'
                                     check (role in ('member','admin','master_admin')),
  -- Frozen carry-over of the legacy aggregate counters. Attendance from cutover
  -- onward is counted from the attendance table; these are pre-app history only.
  historical_attendance_count_legacy int not null default 0,
  historical_late_count_legacy       int not null default 0,
  created_at                       timestamptz not null default now(),
  updated_at                       timestamptz not null default now()
);
comment on table public.members is '동호회 회원. 실명·생년월일 등 개인정보를 담으므로 직접 조회를 막고 RPC와 공개 뷰로만 노출한다.';

create unique index if not exists members_nickname_lower_uq on public.members (lower(nickname));
create index if not exists members_status_idx on public.members (status);

-- ------------------------------------------------------------------- activities
create table if not exists public.activities (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('training','race','event')),
  title         text not null,
  activity_date date not null,
  start_time    time,
  end_time      time,
  place         text,
  capacity      int check (capacity is null or capacity > 0),
  -- Genuinely variable per kind (coach/gear/lane/info/plan/relays). Note that
  -- participants/waitlist/offer are NOT stored here: the legacy app wrote them
  -- (index.html:3590) but rebuilt them from activity_applications on every load
  -- (index.html:1312), making the copy write-only and a second source of truth.
  details       jsonb not null default '{}'::jsonb,
  created_by    uuid references public.members(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table public.activities is '훈련·대회·이벤트 일정. 신청자 명단은 activity_applications가 정본이며 details에 복사하지 않는다.';

create index if not exists activities_date_idx on public.activities (activity_date desc);

-- --------------------------------------------------------- activity_applications
create table if not exists public.activity_applications (
  id                uuid primary key default gen_random_uuid(),
  activity_id       uuid not null references public.activities(id) on delete cascade,
  member_id         uuid not null references public.members(id) on delete cascade,
  application_type  text not null check (application_type in ('participant','waitlist')),
  wait_order        int,
  details           jsonb not null default '{}'::jsonb,
  offer_status      text not null default 'none'
                      check (offer_status in ('none','offered','accepted','declined','expired')),
  offer_expires_at  timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (activity_id, member_id),
  constraint wait_order_only_for_waitlist
    check (application_type = 'waitlist' or wait_order is null),
  constraint offer_only_for_waitlist
    check (offer_status = 'none' or application_type = 'waitlist')
);
comment on table public.activity_applications is '일정 신청. 정원 판정과 대기 순번 부여는 apply_to_activity()가 행 잠금 아래에서만 수행한다.';

-- Backstop for the capacity race. The real serialization is the row lock in
-- apply_to_activity(); this index makes a duplicate order impossible even so.
create unique index if not exists activity_applications_wait_order_uq
  on public.activity_applications (activity_id, wait_order)
  where application_type = 'waitlist' and wait_order is not null;

-- -------------------------------------------------------------------- attendance
create table if not exists public.attendance (
  id            uuid primary key default gen_random_uuid(),
  activity_id   uuid not null references public.activities(id) on delete cascade,
  -- Keyed by member id, never nickname. The legacy attRecords[eventId][nickname]
  -- shape is why index.html:3779 interpolates an unescaped nickname into an
  -- onclick handler, and why a rename would orphan the record.
  member_id     uuid not null references public.members(id) on delete cascade,
  -- English tokens; Korean labels are a render-time concern.
  status        text not null check (status in ('present','late','absent')),
  late_fee_paid boolean not null default false,
  late_fee_amount int check (late_fee_amount is null or late_fee_amount >= 0),
  marked_by     uuid not null references public.members(id),
  marked_at     timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (activity_id, member_id),
  constraint late_fee_requires_late check (not late_fee_paid or status = 'late')
);
comment on table public.attendance is '출석 체크 결과. 레거시에는 이 테이블이 아예 없어 관리자가 체크한 값이 새로고침마다 사라졌다.';

create index if not exists attendance_member_idx on public.attendance (member_id);

-- --------------------------------------------------------------- helper functions
-- STABLE + SECURITY DEFINER so policies can consult members without the caller
-- needing read access to it.

create or replace function public.current_member_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select id from public.members
   where auth_user_id = auth.uid() and status = 'approved'
$$;

create or replace function public.is_staff()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.members
     where auth_user_id = auth.uid()
       and status = 'approved'
       and role in ('admin','master_admin')
  )
$$;

create or replace function public.is_master_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.members
     where auth_user_id = auth.uid()
       and status = 'approved'
       and role = 'master_admin'
  )
$$;

-- ------------------------------------------------------------- public member view
-- Rosters and attendee lists read this, never members directly, so real_name,
-- birth data, join_reason and notes stay staff-only.
create or replace view public.member_public_v as
  select id, nickname, short_name, avatar_path, team_role, role, status
    from public.members
   where status = 'approved';

comment on view public.member_public_v is '회원 목록·참석자 표시용 공개 뷰. 실명·생년월일·메모는 제외한다.';

-- ------------------------------------------------------------------------- RLS
alter table public.members               enable row level security;
alter table public.activities            enable row level security;
alter table public.activity_applications enable row level security;
alter table public.attendance            enable row level security;

-- members: readable by self or staff; NO write policy at all — every mutation
-- goes through a SECURITY DEFINER function.
drop policy if exists members_read on public.members;
create policy members_read on public.members
  for select using (auth_user_id = auth.uid() or public.is_staff());

-- activities: any approved member reads; staff writes.
drop policy if exists activities_read on public.activities;
create policy activities_read on public.activities
  for select using (public.current_member_id() is not null);

drop policy if exists activities_write on public.activities;
create policy activities_write on public.activities
  for all using (public.is_staff()) with check (public.is_staff());

-- applications: self or staff reads; self may cancel. No INSERT policy —
-- inserts must go through apply_to_activity() so wait_order is serialized.
drop policy if exists applications_read on public.activity_applications;
create policy applications_read on public.activity_applications
  for select using (member_id = public.current_member_id() or public.is_staff());

drop policy if exists applications_self_delete on public.activity_applications;
create policy applications_self_delete on public.activity_applications
  for delete using (member_id = public.current_member_id());

-- attendance: deny-all. RLS is on with zero policies and the grants are revoked
-- below, so the table is reachable only through the RPCs. Server authority is
-- then the only path, rather than a policy we hope is written correctly.
revoke all on public.attendance from anon, authenticated;

grant select on public.member_public_v to authenticated;

-- ------------------------------------------------------------ attendance RPCs
-- Admin marks attendance. This is the fix for the defect where the check never
-- left the browser.
create or replace function public.attendance_mark_v1(
  p_activity_id   uuid,
  p_member_id     uuid,
  p_status        text,
  p_late_fee_paid boolean default false
)
returns public.attendance
language plpgsql security definer set search_path = public
as $$
declare
  v_marker uuid;
  v_row    public.attendance;
begin
  if not public.is_staff() then
    raise exception 'only staff may mark attendance' using errcode = '42501';
  end if;
  if p_status not in ('present','late','absent') then
    raise exception 'invalid status: %', p_status using errcode = '22023';
  end if;

  v_marker := public.current_member_id();

  insert into public.attendance (activity_id, member_id, status, late_fee_paid, marked_by)
  values (p_activity_id, p_member_id, p_status,
          case when p_status = 'late' then coalesce(p_late_fee_paid, false) else false end,
          v_marker)
  on conflict (activity_id, member_id) do update
    set status        = excluded.status,
        late_fee_paid = excluded.late_fee_paid,
        marked_by     = excluded.marked_by,
        updated_at    = now()
  returning * into v_row;

  return v_row;
end $$;

-- Admin roster for one activity: everyone who applied, with their mark if any.
create or replace function public.attendance_for_activity_v1(p_activity_id uuid)
returns table (
  member_id     uuid,
  nickname      text,
  avatar_path   text,
  status        text,
  late_fee_paid boolean,
  marked_at     timestamptz
)
language sql stable security definer set search_path = public
as $$
  select m.id, m.nickname, m.avatar_path, a.status,
         coalesce(a.late_fee_paid, false), a.marked_at
    from public.activity_applications ap
    join public.members m on m.id = ap.member_id
    left join public.attendance a
      on a.activity_id = ap.activity_id and a.member_id = ap.member_id
   where ap.activity_id = p_activity_id
     and ap.application_type = 'participant'
     and public.is_staff()
   order by m.nickname
$$;

-- A member's own history. Takes no member id on purpose: the legacy
-- member_history_v4(p_member_id) accepts an arbitrary id from the browser.
create or replace function public.attendance_my_history_v1(
  p_from date default null,
  p_to   date default null
)
returns table (
  activity_id   uuid,
  activity_date date,
  title         text,
  status        text,
  late_fee_paid boolean
)
language sql stable security definer set search_path = public
as $$
  select act.id, act.activity_date, act.title, a.status, a.late_fee_paid
    from public.attendance a
    join public.activities act on act.id = a.activity_id
   where a.member_id = public.current_member_id()
     and (p_from is null or act.activity_date >= p_from)
     and (p_to   is null or act.activity_date <= p_to)
   order by act.activity_date desc
$$;

-- --------------------------------------------------- capacity-safe application
-- Serializes concurrent applications on the parent activity row, so two members
-- tapping at once cannot both take the last seat or share a wait number.
create or replace function public.apply_to_activity(p_activity_id uuid)
returns public.activity_applications
language plpgsql security definer set search_path = public
as $$
declare
  v_member   uuid;
  v_capacity int;
  v_taken    int;
  v_next     int;
  v_row      public.activity_applications;
begin
  v_member := public.current_member_id();
  if v_member is null then
    raise exception 'not an approved member' using errcode = '42501';
  end if;

  -- The lock, not the constraint, is what makes count-then-insert safe.
  select capacity into v_capacity
    from public.activities where id = p_activity_id for update;
  if not found then
    raise exception 'no such activity' using errcode = '23503';
  end if;

  select count(*) into v_taken
    from public.activity_applications
   where activity_id = p_activity_id and application_type = 'participant';

  if v_capacity is null or v_taken < v_capacity then
    insert into public.activity_applications (activity_id, member_id, application_type)
    values (p_activity_id, v_member, 'participant')
    on conflict (activity_id, member_id) do update
      set application_type = 'participant', wait_order = null, updated_at = now()
    returning * into v_row;
  else
    select coalesce(max(wait_order), 0) + 1 into v_next
      from public.activity_applications
     where activity_id = p_activity_id and application_type = 'waitlist';

    insert into public.activity_applications (activity_id, member_id, application_type, wait_order)
    values (p_activity_id, v_member, 'waitlist', v_next)
    on conflict (activity_id, member_id) do update
      set application_type = 'waitlist', wait_order = v_next, updated_at = now()
    returning * into v_row;
  end if;

  return v_row;
end $$;

-- ------------------------------------------------------- offer expiry sweep
-- The legacy UI promises "자동으로 다음 대기자에게 기회가 넘어갑니다" but nothing
-- client-side advances the queue. Run this on a schedule.
create or replace function public.expire_stale_offers()
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_expired int := 0;
  r record;
begin
  for r in
    select id, activity_id from public.activity_applications
     where application_type = 'waitlist'
       and offer_status = 'offered'
       and offer_expires_at is not null
       and offer_expires_at < now()
     for update skip locked
  loop
    update public.activity_applications
       set offer_status = 'expired', updated_at = now()
     where id = r.id;
    v_expired := v_expired + 1;

    -- Hand the offer to the next person in line.
    update public.activity_applications
       set offer_status = 'offered',
           offer_expires_at = now() + interval '12 hours',
           updated_at = now()
     where id = (
       select id from public.activity_applications
        where activity_id = r.activity_id
          and application_type = 'waitlist'
          and offer_status = 'none'
        order by wait_order
        limit 1
     );
  end loop;
  return v_expired;
end $$;

-- Execution rights. The functions are SECURITY DEFINER and check the caller
-- themselves, so granting execute is what makes them the only usable path.
revoke all on function public.attendance_mark_v1(uuid, uuid, text, boolean) from public;
revoke all on function public.attendance_for_activity_v1(uuid) from public;
revoke all on function public.attendance_my_history_v1(date, date) from public;
revoke all on function public.apply_to_activity(uuid) from public;
revoke all on function public.expire_stale_offers() from public;

grant execute on function public.attendance_mark_v1(uuid, uuid, text, boolean) to authenticated;
grant execute on function public.attendance_for_activity_v1(uuid) to authenticated;
grant execute on function public.attendance_my_history_v1(date, date) to authenticated;
grant execute on function public.apply_to_activity(uuid) to authenticated;
