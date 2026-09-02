-- 0052 — undo 0051. The problem it solved was solved in 2026-08.
--
-- ============================================================================
-- 0051 REBUILT A DECISION INSTEAD OF READING IT
-- ============================================================================
--
-- 0051 made `attendance.member_id` nullable and added `display_name` so that
-- "a person who never had an account" could be recorded. That person could
-- already be recorded, and 80% of this database is them.
--
--    members | no_login | with_login      attendance | for_no_login
--   ---------+----------+-----------     ------------+--------------
--         41 |       36 |          5             234 |          188
--
-- Measured 2026-09-02, the same shape 0042 measured on 08-26. **The FK asks for
-- a member ROW, not an account.** `members.auth_user_id` is nullable; 36 of our
-- 41 members have none, their rows having come from the club spreadsheet, and
-- `attendance_mark_v1` has never asked whether anybody can log in.
--
-- 0042 already refused exactly this, in its own header: building a
-- roster_people / historical_attendance identity model on top "would not
-- confront the decision, it would rebuild it a second time — which is precisely
-- the two sources of truth this repo keeps getting bitten by."
--
-- WHY IT WAS NOT MERELY REDUNDANT.
--
-- 0051 created a second way to be a person without an account, and the two are
-- not equivalent:
--
--   member row, no auth_user_id  ->  counted in 출석왕 and badges; a later
--                                    signup is absorbed by link_member_login_v1
--   name-only attendance row     ->  invisible to those aggregates by design;
--                                    a later signup needed attendance_link_name_v1
--
-- So the same person's ranking depended on which path an admin happened to
-- take, and there were two merge functions for one question. That is the defect,
-- not the wasted work.
--
-- WHY THIS IS A CLEAN REVERT.
--
-- `select count(*) from attendance where member_id is null` was 0 at the time of
-- writing: the UI shipped in #72 but nobody used it. Nothing to migrate, nothing
-- to lose. The guard below re-checks at apply time — if it is not 0, this stops
-- rather than dropping the only record of who those people were.
--
-- WHAT TO DO INSTEAD, when a paper register needs importing: give each name a
-- `members` row with `auth_user_id` null — the same shape the other 36 have —
-- and mark attendance against it with `attendance_mark_v1`. They then count
-- everywhere, and `link_member_login_v1` (0035) absorbs them if they ever sign up.

-- Refuse to run if 0051's model was actually used. A clean revert is only clean
-- while it is empty; this turns a silent data loss into a loud stop.
do $$
declare v_rows bigint;
begin
  select count(*) into v_rows from public.attendance where member_id is null;
  if v_rows > 0 then
    raise exception
      'attendance has % name-only row(s); link them to members before reverting 0051', v_rows
      using errcode = 'P0001';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The two functions 0051 added. Dropped before display_name, which they read.
drop function if exists public.attendance_link_name_v1(uuid, text, uuid);
drop function if exists public.attendance_mark_name_v1(uuid, text, text, boolean);

-- ---------------------------------------------------------------------------
-- attendance_for_activity_v1 — restored to 0030's body verbatim.
--
-- Read out of 0030, which owns it, rather than reconstructed from 0051's
-- version minus the union branch. The rule about never rebuilding a function
-- body from a description applies just as much to undoing one.
create or replace function public.attendance_for_activity_v1(p_activity_id uuid)
returns table (
  member_id     uuid,
  nickname      text,
  avatar_path   text,
  status        text,
  late_fee_paid boolean,
  marked_at     timestamptz
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  -- UNION, not UNION ALL: a member who both applied and was marked must appear
  -- once. The set operation dedupes on member_id, which is the whole key here.
  with roster as (
    select ap.member_id
      from public.activity_applications ap
     where ap.activity_id = p_activity_id
       and ap.application_type = 'participant'
    union
    select att.member_id
      from public.attendance att
     where att.activity_id = p_activity_id
  )
  select m.id,
         m.nickname,
         m.avatar_path,
         a.status,
         coalesce(a.late_fee_paid, false),
         a.marked_at
    from roster r
    join public.members m on m.id = r.member_id
    left join public.attendance a
      on a.activity_id = p_activity_id
     and a.member_id   = m.id
   where public.is_staff()
   order by m.nickname
$function$;

-- ---------------------------------------------------------------------------
-- attendance_mark_v1 — restored to 0001's body verbatim.
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

-- ---------------------------------------------------------------------------
-- The schema, back the way 0001 had it.
--
-- The partial indexes go first: the plain unique restored below would otherwise
-- be redundant with one of them, and dropping them afterwards would leave a
-- window where the conflict target above matched two things.
drop index if exists public.attendance_one_row_per_member;
drop index if exists public.attendance_one_row_per_name;

alter table public.attendance
  drop constraint if exists attendance_identifies_someone;

alter table public.attendance
  drop column if exists display_name;

alter table public.attendance
  alter column member_id set not null;

alter table public.attendance
  add constraint attendance_activity_id_member_id_key unique (activity_id, member_id);

-- 0001's grants are unchanged by CREATE OR REPLACE, but restated for the same
-- reason 0030 restated them: the grant that keeps a function reachable should be
-- visible in the migration that last touched it.
grant execute on function public.attendance_for_activity_v1(uuid) to authenticated;
grant execute on function public.attendance_mark_v1(uuid, uuid, text, boolean) to authenticated;
