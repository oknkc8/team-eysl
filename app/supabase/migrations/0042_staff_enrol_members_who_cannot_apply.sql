-- 0042 — 명단 추가: staff put a member on an activity when that member has no
-- way to put themselves on it.
--
-- ============================================================================
-- THE BRIEF WAS WRONG, AND THE MEASUREMENT IS WHY THIS MIGRATION IS SMALL
-- ============================================================================
--
-- This was assigned as "our schema cannot hold a person without an account;
-- write the migration that confronts that decision". CLAUDE.md says the same
-- thing in the upstream section:
--
--   "Our schema cannot hold them. attendance.member_id is a FK to members
--    (0001:104), so a past participant who never had an account cannot be
--    stored at all"
--
-- Measured against this project's database before writing a line of it:
--
--    members | no_login | with_login         attendance | for_no_login
--   ---------+----------+------------       ------------+--------------
--         41 |       36 |          5                249 |          198
--
-- The FK asks for a MEMBER ROW, not an account. 36 of our 41 members have no
-- auth_user_id at all — their rows came from the club's spreadsheet, which is
-- the same population 0035 counted in its own header. 79% of every attendance
-- row we hold already belongs to somebody who has never logged in.
--
-- And the roster already returns them. Running 0030's query body against the
-- activity with the most attendance:
--
--    roster_size | no_login_shown
--   -------------+----------------
--             19 |             17
--
-- So the decision was made long ago and is live. Building a roster_people /
-- historical_attendance identity model on top of that would not confront the
-- decision, it would rebuild it a second time — which is precisely the two
-- sources of truth this repo keeps getting bitten by. What confronts it is
-- writing it down, and then fixing the one thing that is genuinely missing.
--
-- ============================================================================
-- WHAT IS GENUINELY MISSING
-- ============================================================================
--
-- A member who cannot sign in can be MARKED ATTENDED but cannot be a
-- PARTICIPANT. attendance_mark_v1 takes p_member_id and is staff-gated, which
-- is how those 198 rows exist. apply_to_activity takes no member id at all:
--
--    v_member := public.current_member_id();
--    if v_member is null then raise ... errcode '42501'
--
-- and current_member_id() is `auth_user_id = auth.uid() and status='approved'`.
-- There is no staff-side enrolment anywhere, and the live data says so plainly:
-- ONE application row in the entire database, none of them from a member
-- without a login, against 249 attendance rows. This club's real history is
-- attendance; the application table is a prediction almost nobody makes.
--
-- The consequence is the thing upstream's final92 just fixed on his side. He
-- lifted the imported roster out of its `activityHasStarted(t) || fixedRoster`
-- gates so it shows BEFORE an activity starts, with the comment
--
--    // 회원가입 여부와 무관하게 원본 참석명단은 항상 화면 참가자에 합친다.
--
-- Translated to our schema: "who is coming on Saturday" cannot include the 36.
-- After this migration it can.
--
-- ============================================================================
-- FOUR DECISIONS THAT ARE OURS
-- ============================================================================
--
-- 1. ONLY A MEMBER WHO CANNOT SIGN IN MAY BE ENROLLED BY STAFF.
--    A member with a login applies for themselves; staff doing it for them is
--    putting words in their mouth, and it would let staff seat somebody past a
--    waitlist that other members are waiting in. auth_user_id is null is the
--    exact population upstream's imported roster describes, so this is the
--    faithful translation and not merely the cautious one. It is also one line
--    to relax if the club ever asks for it.
--
-- 2. A MEMBER WHO CANNOT SIGN IN IS NEVER PUT ON THE WAITLIST.
--    offer_seat_to_next_waitlister() picks purely by wait_order and asks
--    nothing about whether the person it picks can answer:
--
--        where activity_id = p_activity_id
--          and application_type = 'waitlist'
--          and offer_status = 'none'
--        order by wait_order limit 1
--
--    It would then hold that seat for the 12 hours the offer runs, and lapse.
--    Every person behind them waits out that window for nothing, repeatedly.
--    So a full activity REFUSES the enrolment instead of queueing it, and the
--    staffer raises capacity or waits for a seat. Refusing is the honest
--    failure; queueing would be a silent one paid for by other members.
--
-- 3. ENROLLING SOMEBODY ALREADY SEATED RETURNS THEIR ROW UNCHANGED.
--    Same idempotence apply_to_activity gives a repeated tap, for the same
--    reason: a second press must not rewrite a confirmed participation.
--
-- 4. UNENROLMENT IS A SEPARATE RPC AND SHIPS IN THE SAME MIGRATION.
--    applications_self_delete is `member_id = current_member_id()` and there is
--    no other DELETE policy, so a row created here would be deletable by NOBODY
--    — the enrolled member cannot log in and staff have no policy. Shipping the
--    enrol without the unenrol would build exactly the stranded-object shape
--    0036 was written to remove.
--
-- The DELETE below fires activity_applications_offer_next, which already offers
-- the freed seat to the next waitlister. Nothing here needs to do that by hand.

-- ---------------------------------------------------------------- enrol

create or replace function public.activity_enrol_member_v1(
  p_activity_id uuid,
  p_member_id   uuid
)
returns public.activity_applications
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_can_sign_in boolean;
  v_status      text;
  v_capacity    int;
  v_taken       int;
  v_existing    public.activity_applications;
  v_row         public.activity_applications;
begin
  if not public.is_staff() then
    raise exception 'staff only' using errcode = '42501';
  end if;

  select (m.auth_user_id is not null), m.status
    into v_can_sign_in, v_status
    from public.members m
   where m.id = p_member_id;
  if not found then
    raise exception 'no such member' using errcode = '23503';
  end if;
  if v_status <> 'approved' then
    raise exception 'member is not approved' using errcode = '42501';
  end if;
  -- Decision 1. Distinct from the 'staff only' refusal above on purpose: a
  -- caller fixes those two mistakes differently.
  if v_can_sign_in then
    raise exception 'that member can sign in and applies for themselves'
      using errcode = '42501';
  end if;

  -- The same row lock apply_to_activity takes, and for the same reason: the
  -- seat count below must not be read against a snapshot a concurrent
  -- application has already invalidated.
  select capacity into v_capacity
    from public.activities where id = p_activity_id for update;
  if not found then
    raise exception 'no such activity' using errcode = '23503';
  end if;

  select * into v_existing
    from public.activity_applications
   where activity_id = p_activity_id and member_id = p_member_id
   for update;

  if found then
    -- Decision 3.
    if v_existing.application_type = 'participant' then
      return v_existing;
    end if;
    -- A waitlist row for somebody who cannot sign in should not exist after
    -- this migration, but one may predate it or arrive by another path. Say so
    -- rather than silently converting it to a seat and moving them past the
    -- people ahead of them.
    raise exception 'member is on the waitlist; remove them from it first'
      using errcode = '22023';
  end if;

  -- Seats in use, counted the way apply_to_activity counts them: confirmed
  -- participants plus offers that have not lapsed.
  select count(*) into v_taken
    from public.activity_applications
   where activity_id = p_activity_id
     and member_id <> p_member_id
     and (
       application_type = 'participant'
       or (offer_status = 'offered'
           and offer_expires_at is not null
           and offer_expires_at > now())
     );

  -- Decision 2. A null capacity is unlimited, as everywhere else.
  if v_capacity is not null and v_taken >= v_capacity then
    raise exception 'no free seat; a member who cannot sign in must not be queued'
      using errcode = '22023';
  end if;

  insert into public.activity_applications (activity_id, member_id, application_type)
  values (p_activity_id, p_member_id, 'participant')
  returning * into v_row;

  return v_row;
end $$;

comment on function public.activity_enrol_member_v1(uuid, uuid) is
  '운영진이 로그인할 수 없는 회원을 활동 참가자로 등록한다. 정원이 찼으면 대기가 아니라 거절한다.';

-- ---------------------------------------------------------------- unenrol

create or replace function public.activity_unenrol_member_v1(
  p_activity_id uuid,
  p_member_id   uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_can_sign_in boolean;
  v_removed     int;
begin
  if not public.is_staff() then
    raise exception 'staff only' using errcode = '42501';
  end if;

  select (m.auth_user_id is not null) into v_can_sign_in
    from public.members m
   where m.id = p_member_id;
  if not found then
    raise exception 'no such member' using errcode = '23503';
  end if;
  -- The mirror of decision 1, and the more important half: a member who can
  -- sign in owns their own withdrawal. applications_self_delete is what lets
  -- them do it, and staff must not be able to cancel a member's place from
  -- under them through a door RLS never opened.
  if v_can_sign_in then
    raise exception 'that member can sign in and withdraws for themselves'
      using errcode = '42501';
  end if;

  delete from public.activity_applications
   where activity_id = p_activity_id and member_id = p_member_id;
  get diagnostics v_removed = row_count;

  -- false rather than an exception: staff pressing 삭제 twice, or on a row
  -- another staffer just removed, has got the outcome they wanted either way.
  return v_removed > 0;
end $$;

comment on function public.activity_unenrol_member_v1(uuid, uuid) is
  '운영진이 등록해둔, 로그인할 수 없는 회원을 활동 명단에서 뺀다. 자리는 트리거가 다음 대기자에게 넘긴다.';

-- ---------------------------------------------------------------- the list

-- Returns every approved member who cannot sign in, with whether they are
-- already on this activity. One call rather than two: the screen needs the
-- addable list AND needs to mark the people already on the card who cannot be
-- reached, and those are the same population read twice.
--
-- This is also why the screen does not select members.auth_user_id itself.
-- members_read would allow it — it is `auth_user_id = auth.uid() or is_staff()`
-- — but a boolean is the fact the screen needs, and shipping an auth user id to
-- a browser to be turned into a boolean there is a wider door than the question
-- requires.
create or replace function public.activity_enrollable_members_v1(p_activity_id uuid)
returns table (
  member_id        uuid,
  nickname         text,
  already_enrolled boolean
)
language sql
stable
security definer
set search_path = public
as $$
  select m.id,
         m.nickname,
         exists (
           select 1
             from public.activity_applications ap
            where ap.activity_id = p_activity_id
              and ap.member_id   = m.id
         )
    from public.members m
   -- A filter and not a raise, carried over from 0030: a non-staff caller gets
   -- zero rows rather than an error, and the client depends on the empty result.
   where public.is_staff()
     and m.auth_user_id is null
     and m.status = 'approved'
   order by m.nickname
$$;

comment on function public.activity_enrollable_members_v1(uuid) is
  '로그인할 수 없는 승인 회원 목록과, 각자가 이 활동에 이미 올라 있는지 여부.';

-- ---------------------------------------------------------------- grants
--
-- 0026 made a function unreachable until somebody grants it on purpose, and
-- 0014 is why the revoke names anon explicitly rather than trusting `public`.
revoke all on function public.activity_enrol_member_v1(uuid, uuid)      from public, anon, authenticated;
revoke all on function public.activity_unenrol_member_v1(uuid, uuid)    from public, anon, authenticated;
revoke all on function public.activity_enrollable_members_v1(uuid)      from public, anon, authenticated;

grant execute on function public.activity_enrol_member_v1(uuid, uuid)   to authenticated;
grant execute on function public.activity_unenrol_member_v1(uuid, uuid) to authenticated;
grant execute on function public.activity_enrollable_members_v1(uuid)   to authenticated;
