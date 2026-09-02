-- 0051 — attendance stops requiring an account.
--
-- THE DEFECT.
--
-- `attendance.member_id` was `not null references public.members(id)` (0001:104),
-- so a person who never had an app account could not have attendance stored at
-- all. That is not an inconvenience, it is the reason the club's paper registers
-- for pre-app trainings cannot be imported: every name on them belongs to
-- somebody who, at that date, had no row in `members`.
--
-- 0030 already moved half of this. It widened the READ side so the roster is no
-- longer the application list — "a member who turns up without applying has
-- attended". This migration finishes the thought on the WRITE side: a person who
-- attended before the app existed also attended.
--
-- WHY THE PRESIDENT'S SHAPE AND NOT OUR OWN.
--
-- His `attendance` carries `member_id`, `roster_id` and `display_name`, and his
-- upsert conflict target is `(activity_id, display_name)` — rows are keyed by
-- NAME and the account link is optional. Under this repository's scope rule his
-- app is the spec, so the question "may an attendance row exist without a member
-- row" is already answered, and answered yes.
--
-- We take the name key and skip `roster_id`. A separate roster table would be
-- the tidier model, but it is a second source of truth for "who is in this club"
-- next to `members`, and nothing today needs it: the only thing a name-only row
-- has to do is sit in a register and, later, become a member's row. Adding the
-- table when a second consumer appears is cheap; removing it once two screens
-- read it is not.
--
-- WHAT MAKES THIS SAFE, AND IT IS NOT CARE.
--
-- Five of the seven functions that touch this table aggregate by member:
-- `attendance_my_history_v1`, `member_link_summary_v1`, `my_achievement_v1`,
-- `my_monthly_activity_v1` and `team_event_rankings_v1`. Every one of them
-- reaches attendance through `a.member_id = <some member>` or, in the rankings
-- case, `left join marks k on k.member_id = r.id`.
--
-- A NULL `member_id` is not equal to anything, so a name-only row is invisible
-- to all five **by construction**. Nobody has to remember to filter it out, and
-- a future function that forgets will also be correct, because the equality does
-- the work. That is the whole reason to key on NULL rather than on a sentinel
-- member row: a sentinel would have counted toward 출석왕 and earned badges.
--
-- The policy this encodes, stated plainly: **rankings and achievements are about
-- app members.** A paper-register row counts once its person is linked to an
-- account, and not before. Linking is therefore retroactive on purpose — the
-- moment `member_id` is filled in, every aggregate above starts counting those
-- rows, which is what a member joining and finding their history intact should
-- feel like.
--
-- The two that do NOT survive untouched are changed below and only there:
--   * `attendance_mark_v1` names the unique constraint in its `on conflict`.
--   * `attendance_for_activity_v1` builds its roster by joining `members`, so a
--     name-only row would be invisible on the one screen that must show it.
--
-- RLS IS NOT PART OF THIS, AND THAT WAS CHECKED RATHER THAN ASSUMED.
--
-- Read from the live database before writing this: `attendance` has
-- `relrowsecurity = true` and **zero policies**, and its only table grants are to
-- `postgres` and `service_role`. Neither `anon` nor `authenticated` can reach it
-- at all; every client path is a `security definer` function. So there is no
-- policy predicate here whose meaning a nullable column could quietly change —
-- the failure mode 0043 hit does not have a surface on this table.

alter table public.attendance
  alter column member_id drop not null,
  add column display_name text;

-- A row must say who it is about. Without this, dropping NOT NULL would admit a
-- row identifying nobody, and the partial indexes below would not catch it:
-- `(activity_id, NULL)` collides with nothing.
--
-- `nullif(btrim(...), '')` rather than `<> ''` because whitespace is the shape a
-- blank actually arrives in from a form, and '   ' is not a person.
alter table public.attendance
  add constraint attendance_identifies_someone
  check (
    member_id is not null
    or nullif(btrim(display_name), '') is not null
  );

-- One constraint becomes two partial indexes.
--
-- A single expression index over `coalesce(member_id::text, display_name)` would
-- also enforce this, but it cannot be named as an `on conflict` target without
-- repeating the expression verbatim at every call site — and a caller that
-- writes it slightly differently gets no error, just a plain insert and a
-- duplicate row. Two partial indexes let each upsert infer the one that applies
-- from its own WHERE clause, which is checked by the planner rather than by
-- matching text.
alter table public.attendance
  drop constraint attendance_activity_id_member_id_key;

create unique index attendance_one_row_per_member
  on public.attendance (activity_id, member_id)
  where member_id is not null;

create unique index attendance_one_row_per_name
  on public.attendance (activity_id, display_name)
  where member_id is null;

-- The 234 existing rows all carry a real member_id, so they land in the first
-- index unchanged and their display_name stays NULL. No backfill is needed and
-- none is done: writing the current nickname into display_name would create a
-- second copy of a name that `members` already owns and that a member may change.

-- ---------------------------------------------------------------------------
-- attendance_mark_v1 — unchanged except for the conflict target.
--
-- Read out of 0001 and re-stated whole, per the rule about never reconstructing
-- a function body from a description. The only differences from 0001 are the
-- `where member_id is not null` on the conflict clause, which names the partial
-- index above instead of the dropped constraint, and an explicit refusal of a
-- NULL member id so this entry point cannot silently write a nameless row.
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
  if p_member_id is null then
    raise exception 'member id is required; use attendance_mark_name_v1 for an unregistered person'
      using errcode = '22023';
  end if;

  v_marker := public.current_member_id();

  insert into public.attendance (activity_id, member_id, status, late_fee_paid, marked_by)
  values (p_activity_id, p_member_id, p_status,
          case when p_status = 'late' then coalesce(p_late_fee_paid, false) else false end,
          v_marker)
  on conflict (activity_id, member_id) where member_id is not null do update
    set status        = excluded.status,
        late_fee_paid = excluded.late_fee_paid,
        marked_by     = excluded.marked_by,
        updated_at    = now()
  returning * into v_row;

  return v_row;
end $$;

-- The name-only twin. Deliberately a separate function rather than a nullable
-- parameter on the one above: the two write different indexes and refuse
-- different things, and a single entry point taking "either an id or a name"
-- would have to branch on which was supplied — the shape where a caller passing
-- neither, or both, gets whichever branch the author happened to test.
create or replace function public.attendance_mark_name_v1(
  p_activity_id   uuid,
  p_display_name  text,
  p_status        text,
  p_late_fee_paid boolean default false
)
returns public.attendance
language plpgsql security definer set search_path = public
as $$
declare
  v_marker uuid;
  v_name   text;
  v_row    public.attendance;
begin
  if not public.is_staff() then
    raise exception 'only staff may mark attendance' using errcode = '42501';
  end if;
  if p_status not in ('present','late','absent') then
    raise exception 'invalid status: %', p_status using errcode = '22023';
  end if;

  v_name := nullif(btrim(p_display_name), '');
  if v_name is null then
    raise exception 'display name is required' using errcode = '22023';
  end if;

  -- A name that belongs to a member must go through the member path, or the
  -- register grows two rows for one person and only one of them counts toward
  -- anything. Nicknames are unique in `members` today, so the lookup is exact.
  if exists (select 1 from public.members m where m.nickname = v_name) then
    raise exception 'that nickname belongs to a member; mark them by id'
      using errcode = '23505';
  end if;

  v_marker := public.current_member_id();

  insert into public.attendance (activity_id, display_name, status, late_fee_paid, marked_by)
  values (p_activity_id, v_name, p_status,
          case when p_status = 'late' then coalesce(p_late_fee_paid, false) else false end,
          v_marker)
  on conflict (activity_id, display_name) where member_id is null do update
    set status        = excluded.status,
        late_fee_paid = excluded.late_fee_paid,
        marked_by     = excluded.marked_by,
        updated_at    = now()
  returning * into v_row;

  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- attendance_for_activity_v1 — the roster now has two halves.
--
-- Read out of 0030, which owns the current definition, and changed only where
-- the name-only rows have to enter. The first half is 0030's query verbatim
-- apart from `att.member_id is not null` in the union arm, which keeps a NULL
-- out of a set that is about to be inner-joined to `members`.
--
-- The signature is unchanged on purpose. A name-only row returns `member_id`
-- NULL and carries its name in `nickname`, so the client tells the two apart
-- with `member_id === null` and no column had to be added — which would have
-- meant DROP and CREATE rather than REPLACE, and a `db:types` regeneration with
-- the two hand-made exceptions to restore afterwards.
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
       and att.member_id is not null
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

  union all

  select null::uuid,
         att.display_name,
         null::text,
         att.status,
         coalesce(att.late_fee_paid, false),
         att.marked_at
    from public.attendance att
   where att.activity_id = p_activity_id
     and att.member_id is null
     and public.is_staff()

  -- Ordinal, not `m.nickname`: after a UNION the outer ORDER BY cannot see a
  -- branch's table alias. Column 2 is the name in both halves, so unregistered
  -- people sort in among the members rather than in a block at the end — which
  -- is what a paper register looks like and what makes it checkable against one.
   order by 2
$function$;

-- CREATE OR REPLACE preserves the existing ACL, so 0001's grants still stand.
-- Restated for the same reason 0030 restated them: the grant that keeps a
-- function reachable should be visible in the migration that last touched it.
grant execute on function public.attendance_for_activity_v1(uuid) to authenticated;
grant execute on function public.attendance_mark_v1(uuid, uuid, text, boolean) to authenticated;
grant execute on function public.attendance_mark_name_v1(uuid, text, text, boolean) to authenticated;
