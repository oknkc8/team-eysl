-- 0020 — the waitlist was not a queue.
--
-- Four separate paths could hand out a seat, and they did not agree on who was
-- allowed to. apply_to_activity() decided under the activities row lock (0001,
-- corrected by 0008); everything else decided without it, or without looking at
-- the seat count at all.
--
--   1. expire_stale_offers() (0001:349) promoted the next waitlister with a bare
--      UPDATE: no lock, no capacity read, no count of who already holds a seat.
--      Capacity 1, no participants, W1's offer just lapsed, W2 next in line —
--      a walk-in applies and correctly takes the free seat (an expired offer
--      reserves nothing), then the sweep offers that same seat to W2 anyway.
--      The activity ends up with one participant and one live offer against a
--      capacity of one, and W2 is refused at 수락 for being too slow when they
--      were not.
--
--   2. offer_seat_to_next_waitlister() (0006:38) does count seats, but reads
--      capacity without locking the activity. respond_waitlist_offer() happened
--      to hold the lock when calling it; the cancel trigger did not, and neither
--      did the sweep. A count is only as good as the lock it is taken under.
--
--   3. apply_to_activity() never looked at the caller's own offer state. A
--      waitlister holding a live offer could call the RPC directly — it is
--      reachable whatever the UI draws — and be seated by a code path that knows
--      nothing about offers, deadlines or 순번.
--
--   4. The succession trigger (0006:110) fired only when the deleted row was a
--      participant. A member holding a live offer cancels through the ordinary
--      DELETE that applications_self_delete allows, the seat they were holding is
--      released, and nobody is told. The next applicant takes it instead of the
--      next person in line, and W2 stays at offer_status 'none' forever.
--
-- The through-line: seats are handed out in more than one place, so the lock has
-- to live in the one function all of those places call, not in whichever of them
-- happened to remember. That function is offer_seat_to_next_waitlister().
--
-- Also here, because it is the same invariant seen from the other side: nothing
-- stopped staff lowering capacity below the number of seats already committed.

-- ------------------------------------------------- one place takes the lock
-- Every path that gives a seat away now enters through this function, and this
-- function locks the activities row before it counts anything — the same row and
-- the same order apply_to_activity() has used since 0001. Callers that already
-- hold the lock (respond_waitlist_offer, the capacity trigger) re-take it for
-- free inside their own transaction.
create or replace function public.offer_seat_to_next_waitlister(p_activity_id uuid)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_capacity int;
  v_taken    int;
  v_offered  int;
  v_id       uuid;
begin
  -- FOR UPDATE, unlike 0006, is the whole point of this migration: without it
  -- the count below can be taken against a snapshot that a concurrent
  -- apply_to_activity() has already invalidated but not yet committed.
  select capacity into v_capacity
    from public.activities where id = p_activity_id for update;
  if not found then
    return null;
  end if;

  -- A null capacity means unlimited, not "no waitlist exists". 0006 returned
  -- early here, which was true while capacity never changed — but a waitlist
  -- formed under a limit outlives that limit being removed, and those members
  -- would then wait for an offer that could never be made.
  if v_capacity is not null then
    select count(*) into v_taken
      from public.activity_applications
     where activity_id = p_activity_id and application_type = 'participant';

    -- A live offer is a seat already spoken for. Counting it here is what stops
    -- two members being told "지금 자리가 났어요" about the same seat.
    select count(*) into v_offered
      from public.activity_applications
     where activity_id = p_activity_id
       and application_type = 'waitlist'
       and offer_status = 'offered'
       and offer_expires_at is not null
       and offer_expires_at > now();

    if v_taken + v_offered >= v_capacity then
      return null;
    end if;
  end if;

  select id into v_id
    from public.activity_applications
   where activity_id = p_activity_id
     and application_type = 'waitlist'
     and offer_status = 'none'
   order by wait_order
   limit 1
   for update skip locked;
  if v_id is null then
    return null;
  end if;

  update public.activity_applications
     set offer_status     = 'offered',
         -- Same window the sweep uses when it passes an offer on.
         offer_expires_at = now() + interval '12 hours',
         updated_at       = now()
   where id = v_id;

  return v_id;
end $$;

comment on function public.offer_seat_to_next_waitlister(uuid) is
  '자리가 비면 대기 순번이 가장 빠른 사람에게 12시간짜리 오퍼를 보낸다. activities 행을 잠근 뒤 참가자와 살아 있는 오퍼를 함께 세므로, 좌석을 넘기는 모든 경로가 이 함수 하나로 직렬화된다.';

-- --------------------------------------------------- expiry, for one activity
-- Split out of expire_stale_offers() so the sweep takes one activity's lock at a
-- time rather than deciding for all of them at once. Expiring an offer frees a
-- seat, and deciding who gets that seat is the same judgement apply_to_activity()
-- makes — so it is made here, under the same lock, and only after the expiry is
-- recorded.
--
-- p_skip_locked is how the scheduled sweep stays out of everybody's way; see the
-- long note on expire_stale_offers() below for why it has to.
drop function if exists public.expire_stale_offers_for_activity(uuid);
create or replace function public.expire_stale_offers_for_activity(
  p_activity_id  uuid,
  p_skip_locked  boolean default false
)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_expired int;
  v_id      uuid;
begin
  if p_skip_locked then
    -- Contended right now, or gone. Either way there is nothing to do that would
    -- not mean waiting, and an activity skipped here is swept at the next tick.
    perform 1 from public.activities where id = p_activity_id for update skip locked;
  else
    perform 1 from public.activities where id = p_activity_id for update;
  end if;
  if not found then
    return 0;
  end if;

  -- offer_expires_at is left in place rather than nulled: it is the record of
  -- when the chance lapsed, and nothing counts an 'expired' row as a seat.
  with lapsed as (
    update public.activity_applications
       set offer_status = 'expired',
           updated_at   = now()
     where activity_id = p_activity_id
       and application_type = 'waitlist'
       and offer_status = 'offered'
       and offer_expires_at is not null
       and offer_expires_at < now()
    returning 1
  )
  select count(*)::int into v_expired from lapsed;

  -- Fill whatever is genuinely free, which is not the same as "one seat per
  -- expiry": a walk-in may have taken the seat while the offer was lapsing, and
  -- offer_seat_to_next_waitlister() returning null is how that is discovered.
  -- The loop terminates because each successful call flips exactly one row out
  -- of offer_status 'none'.
  loop
    v_id := public.offer_seat_to_next_waitlister(p_activity_id);
    exit when v_id is null;
  end loop;

  return v_expired;
end $$;

comment on function public.expire_stale_offers_for_activity(uuid, boolean) is
  '한 일정의 만료된 오퍼를 정리하고, 그 잠금 안에서 실제로 빈 자리만큼만 다음 순번에게 넘긴다. p_skip_locked이면 다른 세션이 잡고 있는 일정은 건너뛴다.';

-- ------------------------------------------------------------ the sweep itself
-- The sweep must not make one activity's contention everybody's. The obvious way
-- to get that is a transaction per activity — lock one, finish it, COMMIT, move
-- on — which needs a PROCEDURE, since a function cannot commit.
--
-- That was written, scheduled, and it does not work. Driven against the live dev
-- database on 2026-08-25: pg_cron runs each job inside an explicit transaction
-- block, so the COMMIT is illegal and every run with actual work to do failed:
--
--   jobid 2 | failed | ERROR:  invalid transaction termination
--                      CONTEXT:  PL/pgSQL function sweep_stale_offers() line 19 at COMMIT
--
-- Worth recording precisely, because it hides well: runs with NOTHING to sweep
-- return before the loop and are logged `succeeded | CALL`. Two of those went by
-- before a run with two stale offers in front of it failed and swept neither. A
-- green cron history is not evidence the sweep works — only a run with work in
-- front of it is.
--
-- So one transaction it is, and the lock discipline has to come from somewhere
-- else. It comes from never waiting: each activity's row is taken with SKIP
-- LOCKED, so an activity somebody is applying to right now is passed over rather
-- than queued behind, and swept at the next tick five minutes later. Against a
-- twelve-hour offer window that delay costs nothing, and it means the sweep can
-- never be the thing a member is stuck behind — which was the actual worry, not
-- the transaction boundary in itself.
--
-- What this deliberately does NOT do is lock the whole table, or wait on any row.
-- The batch is bounded so a backlog cannot stretch the one transaction out; the
-- remainder is simply the next tick's work.
create or replace function public.expire_stale_offers()
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_total int := 0;
  v_id    uuid;
  v_ids   uuid[];
begin
  -- Collected up front rather than looped over as a cursor: the set is read
  -- once, and an id that goes stale in the meantime expires nothing.
  select array_agg(activity_id) into v_ids from (
    select distinct activity_id
      from public.activity_applications
     where application_type = 'waitlist'
       and offer_status = 'offered'
       and offer_expires_at is not null
       and offer_expires_at < now()
     limit 500
  ) s;

  if v_ids is null then
    return 0;
  end if;

  foreach v_id in array v_ids loop
    v_total := v_total + public.expire_stale_offers_for_activity(v_id, true);
  end loop;

  return v_total;
end $$;

comment on function public.expire_stale_offers() is
  '만료된 대기자 오퍼를 정리하고 빈 자리를 다음 순번에게 넘긴다. 일정 행을 기다리지 않고 건너뛰므로 신청 중인 회원을 막지 않는다. pg_cron이 5분마다 실행한다.';

-- The COMMIT-per-activity design that pg_cron refused. Dropped rather than left
-- lying around for somebody to schedule again.
drop procedure if exists public.sweep_stale_offers();

-- 0003 already scheduled exactly this command. Restated so the job is known to
-- be right after 0020 rather than assumed to have survived.
do $$
begin
  perform cron.unschedule('expire-stale-offers');
exception
  when others then null;  -- no such job yet
end $$;

select cron.schedule(
  'expire-stale-offers',
  '*/5 * * * *',
  $job$ select public.expire_stale_offers(); $job$
);

-- -------------------------------------------- cancelling passes the seat on
-- The old trigger fired only for a participant, so an offer holder cancelling
-- released their seat in silence and the queue stopped moving.
--
-- The condition is what the row was holding, not whether it was still valid: a
-- lapsed offer holder cancelling also leaves a seat that ought to move now
-- rather than at the next five-minute tick. Nothing is over-promoted by being
-- generous here, because offer_seat_to_next_waitlister() re-counts under the
-- lock and refuses when the seat is gone. A plain waitlist row — no offer, not a
-- participant — freed nothing and is deliberately left out.
create or replace function public.on_reserved_seat_released()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform public.offer_seat_to_next_waitlister(old.activity_id);
  return null;
end $$;

comment on function public.on_reserved_seat_released() is
  '참가자나 오퍼 보유자가 신청을 취소하면 다음 순번에게 자리를 넘긴다.';

drop trigger if exists activity_applications_offer_next on public.activity_applications;
create trigger activity_applications_offer_next
  after delete on public.activity_applications
  for each row when (old.application_type = 'participant' or old.offer_status = 'offered')
  execute function public.on_reserved_seat_released();

drop function if exists public.on_participant_cancelled();

-- ----------------------------------------- applying no longer jumps the queue
-- apply_to_activity() now reads the caller's own row under the activity lock
-- before deciding anything, because what it should do depends entirely on what
-- that row already says. Every branch is spelled out rather than left to the
-- ON CONFLICT clause to imply.
create or replace function public.apply_to_activity(p_activity_id uuid)
returns public.activity_applications
language plpgsql security definer set search_path = public
as $$
declare
  v_member   uuid;
  v_capacity int;
  v_taken    int;
  v_next     int;
  v_mine     public.activity_applications;
  v_row      public.activity_applications;
begin
  v_member := public.current_member_id();
  if v_member is null then
    raise exception 'not an approved member' using errcode = '42501';
  end if;

  select capacity into v_capacity
    from public.activities where id = p_activity_id for update;
  if not found then
    raise exception 'no such activity' using errcode = '23503';
  end if;

  select * into v_mine
    from public.activity_applications
   where activity_id = p_activity_id and member_id = v_member
   for update;

  if found then
    -- Already seated. Returning the row unchanged keeps a repeated tap idempotent
    -- instead of rewriting a confirmed participation.
    if v_mine.application_type = 'participant' then
      return v_mine;
    end if;

    -- Holding a live offer. Accepting one is respond_waitlist_offer()'s job: it
    -- re-checks the deadline, records accepted_offer_at, and is the path the
    -- 수락 button uses. Seating the holder from here as well would give the same
    -- member two ways to be seated with two different records of it, so this is
    -- refused rather than quietly redirected.
    if v_mine.offer_status = 'offered'
       and v_mine.offer_expires_at is not null
       and v_mine.offer_expires_at > now() then
      raise exception 'respond to the outstanding offer instead of reapplying'
        using errcode = '22023';
    end if;

    -- Queued, with nothing outstanding. They are already in line and their turn
    -- belongs to the queue; re-applying must not move them up it. This is the
    -- reordering the RPC used to perform silently — 0007 taught the ON CONFLICT
    -- branch not to raise a constraint error here, and in doing so taught it to
    -- promote a waitlister straight past everybody ahead of them.
    if v_mine.offer_status = 'none' then
      return v_mine;
    end if;

    -- Offer spent — declined, or lapsed and swept. offer_seat_to_next_waitlister()
    -- only ever picks a row at offer_status 'none', so such a member is otherwise
    -- stuck in the queue for good. Re-applying is how they rejoin, and the branch
    -- below puts them at the back of it: the people who waited through their turn
    -- keep their places.
  end if;

  -- Seats in use = confirmed participants + unexpired offers, excluding this
  -- member's own row so rejoining never competes with itself (0008).
  select count(*) into v_taken
    from public.activity_applications
   where activity_id = p_activity_id
     and member_id <> v_member
     and (
       application_type = 'participant'
       or (offer_status = 'offered'
           and offer_expires_at is not null
           and offer_expires_at > now())
     );

  if v_capacity is null or v_taken < v_capacity then
    insert into public.activity_applications (activity_id, member_id, application_type)
    values (p_activity_id, v_member, 'participant')
    on conflict (activity_id, member_id) do update
      set application_type = 'participant',
          wait_order       = null,
          offer_status     = 'none',
          offer_expires_at = null,
          updated_at       = now()
    returning * into v_row;
  else
    select coalesce(max(wait_order), 0) + 1 into v_next
      from public.activity_applications
     where activity_id = p_activity_id and application_type = 'waitlist';

    insert into public.activity_applications (activity_id, member_id, application_type, wait_order)
    values (p_activity_id, v_member, 'waitlist', v_next)
    on conflict (activity_id, member_id) do update
      set application_type = 'waitlist',
          wait_order       = v_next,
          -- Cleared so the rejoining member is eligible to be offered again.
          offer_status     = 'none',
          offer_expires_at = null,
          updated_at       = now()
    returning * into v_row;
  end if;

  return v_row;
end $$;

comment on function public.apply_to_activity(uuid) is
  '일정 신청. activities 행을 잠근 뒤 정원과 신청자 자신의 상태를 함께 보고 참가·대기를 정한다. 이미 대기 중인 회원의 순번은 재신청으로 앞당겨지지 않는다.';

-- ------------------------------------------------ capacity keeps its promises
-- Staff can change capacity through activities_write with both RLS halves
-- closed, and nothing checked the new number against the seats already given
-- out. Dropping 10 to 8 with 8 participants and 2 live offers leaves two members
-- holding offers they cannot accept, through no fault of theirs.
--
-- Refused rather than absorbed. The alternatives are to evict confirmed members
-- to fit the new number — which is not a decision a typo in a form should be
-- allowed to make — or to let the over-subscription stand, which is the defect
-- itself. Refusing tells staff exactly what is in the way while they can still
-- act on it: cancel someone, or leave the capacity alone.
--
-- The row lock the UPDATE already holds is what makes the count trustworthy; it
-- is not what supplies the rule. This trigger is the rule.
create or replace function public.activities_capacity_floor()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_reserved int;
begin
  if new.capacity is null or new.capacity is not distinct from old.capacity then
    return new;
  end if;

  select count(*) into v_reserved
    from public.activity_applications
   where activity_id = new.id
     and (
       application_type = 'participant'
       or (offer_status = 'offered'
           and offer_expires_at is not null
           and offer_expires_at > now())
     );

  if new.capacity < v_reserved then
    -- Korean because staff read it: this is a refusal aimed at a person, not an
    -- internal invariant nobody was going to see.
    raise exception '정원을 %명으로 줄일 수 없습니다. 이미 %명이 자리를 확보했습니다.',
      new.capacity, v_reserved
      using errcode = '23514';
  end if;

  return new;
end $$;

comment on function public.activities_capacity_floor() is
  '정원을 이미 확보된 자리 수(참가자 + 살아 있는 오퍼)보다 낮게 줄이지 못하게 막는다.';

drop trigger if exists activities_capacity_floor on public.activities;
create trigger activities_capacity_floor
  before update on public.activities
  for each row execute function public.activities_capacity_floor();

-- Raising capacity frees seats that nothing else would notice. The succession
-- trigger fires on delete, and apply_to_activity() no longer promotes anybody —
-- so without this the queue simply stalls behind a bigger room, which would be a
-- new stuck queue introduced by the fix for the old one.
create or replace function public.activities_offer_new_seats()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_id uuid;
begin
  loop
    v_id := public.offer_seat_to_next_waitlister(new.id);
    exit when v_id is null;
  end loop;
  return null;
end $$;

comment on function public.activities_offer_new_seats() is
  '정원이 늘면 늘어난 자리만큼 대기 순번대로 오퍼를 보낸다.';

drop trigger if exists activities_offer_new_seats on public.activities;
create trigger activities_offer_new_seats
  after update of capacity on public.activities
  for each row when (
    (new.capacity is null and old.capacity is not null)
    or (new.capacity is not null and old.capacity is not null and new.capacity > old.capacity)
  )
  execute function public.activities_offer_new_seats();

-- --------------------------------------------------------- reserved seat count
-- The edit screen needs the same number the floor trigger enforces, so it can
-- say why a capacity is too low before staff press 저장 and get a bare 저장 실패.
-- Added to the end of the view so CREATE OR REPLACE accepts it; the existing two
-- columns keep their positions and their readers.
create or replace view public.activity_seats_v as
  select activity_id,
         count(*) filter (where application_type = 'participant')::int as participant_count,
         count(*) filter (where application_type = 'waitlist')::int    as waitlist_count,
         count(*) filter (
           where application_type = 'participant'
              or (offer_status = 'offered'
                  and offer_expires_at is not null
                  and offer_expires_at > now())
         )::int as reserved_count
    from public.activity_applications
   -- Mirrors activities_read: a signed-in but unapproved account sees nothing.
   where public.current_member_id() is not null
   group by activity_id;

comment on view public.activity_seats_v is '일정별 신청·대기 인원 수와 이미 확보된 자리 수. 회원은 자기 신청만 조회할 수 있으므로 정원 표시는 이 뷰로만 계산한다.';

-- CREATE OR REPLACE VIEW keeps the existing ACL, so 0010's revoke survives.
-- Restated anyway, because 0002 and 0014 are both records of assuming that.
revoke all on public.activity_seats_v from anon;
grant select on public.activity_seats_v to authenticated;

-- --------------------------------------------------------------- execute rights
-- Revoked by name as well as from PUBLIC. Only the function a browser calls is
-- granted back; the sweep, the per-activity expiry and the trigger bodies are
-- server-side machinery. PostgreSQL checks EXECUTE on a trigger function when the
-- trigger is created, not when it fires, so revoking those does not stop a
-- member's cancel or a staff edit from running them.
revoke all on function public.offer_seat_to_next_waitlister(uuid)      from public, anon, authenticated;
revoke all on function public.expire_stale_offers_for_activity(uuid, boolean)
                                                                       from public, anon, authenticated;
revoke all on function public.expire_stale_offers()                    from public, anon, authenticated;
revoke all on function public.on_reserved_seat_released()              from public, anon, authenticated;
revoke all on function public.activities_capacity_floor()              from public, anon, authenticated;
revoke all on function public.activities_offer_new_seats()             from public, anon, authenticated;
revoke all on function public.apply_to_activity(uuid)                  from public, anon, authenticated;

grant execute on function public.apply_to_activity(uuid) to authenticated;
