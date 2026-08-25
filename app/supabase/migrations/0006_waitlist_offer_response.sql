-- 0005 — close the waitlist loop and give members a seat count they can read.
--
-- 0001 built two thirds of the waitlist: apply_to_activity() decides seat vs
-- waitlist under a row lock, and expire_stale_offers() (scheduled by 0003) moves
-- a lapsed offer along. The middle third was never built, so the feature cannot
-- run end to end:
--
--   * Nothing ever creates the FIRST offer. expire_stale_offers() only cycles an
--     offer that already exists, so a participant cancelling a seat leaves the
--     waitlist untouched and no offer is ever made.
--   * Nothing lets a member answer one. There is no UPDATE policy on
--     activity_applications and no respond RPC, so 수락/거절 has nowhere to go.
--
-- Third problem, unrelated to offers: applications_read only shows a member
-- their own row, so a member counting activity_applications sees 0 or 1 and can
-- never render "8/12". A definer view supplies the count instead — the same
-- shape as member_public_v, and no more than a count leaves the server.

-- ------------------------------------------------------------------ seat counts
-- Activities with no applications are absent rather than present with zeroes;
-- readers must default a missing row to 0 instead of treating it as an error.
create or replace view public.activity_seats_v as
  select activity_id,
         count(*) filter (where application_type = 'participant')::int as participant_count,
         count(*) filter (where application_type = 'waitlist')::int    as waitlist_count
    from public.activity_applications
   -- Mirrors activities_read: a signed-in but unapproved account sees nothing.
   where public.current_member_id() is not null
   group by activity_id;

comment on view public.activity_seats_v is '일정별 신청·대기 인원 수. 회원은 자기 신청만 조회할 수 있으므로 정원 표시는 이 뷰로만 계산한다.';

grant select on public.activity_seats_v to authenticated;

-- ------------------------------------------------------- hand a free seat along
-- The one place that decides who gets offered a seat. Both the cancel trigger
-- and a 거절 response route through it so the rule lives once.
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
  select capacity into v_capacity
    from public.activities where id = p_activity_id;
  -- No capacity means no waitlist ever forms, so there is nothing to offer.
  if not found or v_capacity is null then
    return null;
  end if;

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
     and offer_expires_at > now();

  if v_taken + v_offered >= v_capacity then
    return null;
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
         -- Same window expire_stale_offers() uses when it passes an offer on.
         offer_expires_at = now() + interval '12 hours',
         updated_at       = now()
   where id = v_id;

  return v_id;
end $$;

comment on function public.offer_seat_to_next_waitlister(uuid) is
  '자리가 비면 대기 순번이 가장 빠른 사람에게 12시간짜리 오퍼를 보낸다. 이미 나간 오퍼도 좌석으로 계산한다.';

-- ------------------------------------------------ start the chain on a cancel
-- A trigger rather than logic inside the cancel call: applications_self_delete
-- lets a member delete their own row straight from the client, and staff can
-- delete one too, so a client-side hook would miss half the paths.
create or replace function public.on_participant_cancelled()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform public.offer_seat_to_next_waitlister(old.activity_id);
  return null;
end $$;

drop trigger if exists activity_applications_offer_next on public.activity_applications;
create trigger activity_applications_offer_next
  after delete on public.activity_applications
  for each row when (old.application_type = 'participant')
  execute function public.on_participant_cancelled();

-- ------------------------------------------------------------ answer an offer
-- Accepting consumes a seat, so it is decided under the same activity row lock
-- apply_to_activity() takes. Nothing about this judgement happens in a browser.
create or replace function public.respond_waitlist_offer(p_activity_id uuid, p_accept boolean)
returns public.activity_applications
language plpgsql security definer set search_path = public
as $$
declare
  v_member   uuid;
  v_capacity int;
  v_taken    int;
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

  select * into v_row
    from public.activity_applications
   where activity_id = p_activity_id and member_id = v_member
   for update;
  if not found then
    raise exception 'no application to respond to' using errcode = '23503';
  end if;

  if v_row.application_type <> 'waitlist' or v_row.offer_status <> 'offered' then
    raise exception 'no active offer' using errcode = '22023';
  end if;

  -- The sweep runs every five minutes, so a member can still be looking at an
  -- offer that lapsed four minutes ago. Mark it expired and return the row
  -- rather than raising: an exception would roll back this update too, and the
  -- caller's refetch would keep showing a dead offer until the next sweep.
  if v_row.offer_expires_at is null or v_row.offer_expires_at <= now() then
    update public.activity_applications
       set offer_status     = 'expired',
           offer_expires_at = null,
           updated_at       = now()
     where id = v_row.id
    returning * into v_row;
    perform public.offer_seat_to_next_waitlister(p_activity_id);
    return v_row;
  end if;

  if not p_accept then
    update public.activity_applications
       set offer_status     = 'declined',
           offer_expires_at = null,
           updated_at       = now()
     where id = v_row.id
    returning * into v_row;
    perform public.offer_seat_to_next_waitlister(p_activity_id);
    return v_row;
  end if;

  select count(*) into v_taken
    from public.activity_applications
   where activity_id = p_activity_id and application_type = 'participant';

  -- apply_to_activity() hands out any seat it finds free and does not know an
  -- offer is outstanding, so a walk-in can still beat the offer holder to it.
  -- Refusing here is the honest outcome; reserving the seat properly means
  -- teaching apply_to_activity() about live offers, which is a wider change.
  if v_capacity is not null and v_taken >= v_capacity then
    raise exception 'the offered seat has already been taken' using errcode = '23505';
  end if;

  -- offer_only_for_waitlist forbids a participant row carrying offer_status
  -- 'accepted', so the acceptance is recorded in details instead of the enum.
  update public.activity_applications
     set application_type = 'participant',
         wait_order       = null,
         offer_status     = 'none',
         offer_expires_at = null,
         details          = v_row.details || jsonb_build_object('accepted_offer_at', now()),
         updated_at       = now()
   where id = v_row.id
  returning * into v_row;

  return v_row;
end $$;

comment on function public.respond_waitlist_offer(uuid, boolean) is
  '대기자가 받은 오퍼에 수락·거절로 응답한다. 좌석 판정은 activities 행을 잠근 채 서버에서만 한다.';

-- --------------------------------------------------------------- execute rights
-- 0002's lesson applied up front: PUBLIC alone does not cover anon and
-- authenticated, so all three are named.
revoke all on function public.offer_seat_to_next_waitlister(uuid)   from public, anon, authenticated;
revoke all on function public.on_participant_cancelled()            from public, anon, authenticated;
revoke all on function public.respond_waitlist_offer(uuid, boolean) from public, anon, authenticated;

-- Only the client-facing one is granted back. PostgreSQL checks EXECUTE on a
-- trigger function when the trigger is created, not when it fires, so revoking
-- on_participant_cancelled() does not stop a member's cancel from firing it.
grant execute on function public.respond_waitlist_offer(uuid, boolean) to authenticated;
