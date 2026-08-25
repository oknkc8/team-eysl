-- 0022 — the club can finally be told something.
--
-- push_subscriptions has existed since 0004 and its grants were fixed in 0012,
-- so every member who turned notifications on has a row. Nothing has ever
-- written to one. src/features/push/api.ts said so in its own header: sending
-- needs a VAPID private key and a server to hold it, and there was neither.
--
-- This migration is the trigger side of that server. The sender itself is the
-- push-notify Edge Function (app/supabase/functions/push-notify/), which holds
-- the private key in Supabase's function secrets and nowhere else.
--
-- ============================================================ why the database
--
-- The alternative was the client calling the function after a successful write,
-- which is what the legacy app does (index.html:2185, right after the insert
-- resolves). It does not work for the one notification that matters.
--
-- offer_status is only ever set to 'offered' by offer_seat_to_next_waitlister()
-- (0020:101). That function is reached from three places and no others:
--
--   1. expire_stale_offers_for_activity(), from the pg_cron sweep every five
--      minutes. No browser is involved at all — it runs at four in the morning.
--   2. on_reserved_seat_released(), an AFTER DELETE trigger. The browser in that
--      transaction belongs to the member who CANCELLED, who is by definition not
--      the member being offered the seat.
--   3. activities_offer_new_seats(), when staff raise a capacity. Same problem:
--      the session is the staffer's, the recipient is somebody else.
--
-- So a client-side send would deliver a waitlist offer only when one member
-- happened to cancel while another member's app was open. That is a coincidence,
-- not a rule, and the offer expires in twelve hours — a member who never learns
-- they had a seat loses it to the next person in line.
--
-- Once the waitlist notification has to fire from the database, the other two
-- should too: one mechanism, one place to look for it, and the property the
-- client-side design cannot have — a notice inserted by ANY path still notifies.
-- Typed into the app, pasted into the SQL editor, written by a future import
-- script: the trigger is on the table, so all three behave identically. Under a
-- client-side rule, only the first would.
--
-- The cost, stated rather than hidden: a backfill that inserts old rows would
-- notify the whole club about years-old news. That is what the suppress switch
-- below is for, and a backfill that forgets it is the one way this design is
-- worse than the client-side one.
--
-- =========================================================== how it is deployed
--
-- Two secrets, in two different places, and neither is ever committed:
--
--   Supabase function secrets (the sender):
--     supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... \
--                          VAPID_SUBJECT=mailto:... PUSH_TRIGGER_SECRET=...
--
--   Vault (this side, so the trigger can prove it is us):
--     select vault.create_secret('https://<ref>.supabase.co/functions/v1/push-notify',
--                                'push_notify_url');
--     select vault.create_secret('<the same PUSH_TRIGGER_SECRET>', 'push_notify_secret');
--
-- Until both vault rows exist, request_push_notify() returns without sending and
-- without raising. Applying this migration before the secrets are set is safe:
-- notices and activities save exactly as they did, and nothing is notified.

create extension if not exists pg_net;

-- ==================================================== what the sender is told
-- The sender is given an event name and one row id — never a recipient list and
-- never a line of text. Both are read here, from the row, so that a caller who
-- could reach the Edge Function still cannot choose who hears from the club or
-- what the club appears to have said.
--
-- Called by the Edge Function with the service role key AFTER the triggering
-- transaction has committed, which is the whole reason an id travels instead of
-- a payload: by the time this runs, the row is real and visible.
create or replace function public.push_notify_context_v1(p_event text, p_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_fact     jsonb;
  v_audience uuid[];
begin
  if p_event = 'notice_created' then
    -- Everyone approved except the author. Getting a notification about the
    -- notice you just posted reads as a bug, and the legacy app has exactly that
    -- (index.html:2185 sends mode 'all'). created_by may be null on rows filed
    -- before anyone was attributed; `is distinct from` keeps those going to
    -- everybody rather than to nobody, which `<>` against null would do.
    select jsonb_build_object('notice_id', n.id, 'title', n.title),
           array(select m.id from public.members m
                  where m.status = 'approved'
                    and m.id is distinct from n.created_by)
      into v_fact, v_audience
      from public.notices n
     where n.id = p_id;

  elsif p_event = 'activity_created' then
    select jsonb_build_object('activity_id', a.id, 'kind', a.kind, 'title', a.title,
                              'activity_date', a.activity_date, 'start_time', a.start_time),
           array(select m.id from public.members m
                  where m.status = 'approved'
                    and m.id is distinct from a.created_by)
      into v_fact, v_audience
      from public.activities a
     where a.id = p_id;

  elsif p_event = 'waitlist_offered' then
    -- Exactly one member: the one holding the offer. Nothing about this event
    -- concerns anybody else, and an audience of one is the strongest form of the
    -- rule that the caller does not choose recipients.
    --
    -- The offer_status re-check is not redundant with the trigger that queued
    -- this. Minutes can pass between the queue insert and the Edge Function's
    -- call, and sweep_stale_offers() runs every five of them — an offer that
    -- lapsed in between must not be announced as if it were live.
    select jsonb_build_object('activity_id', a.id, 'kind', a.kind, 'title', a.title,
                              'activity_date', a.activity_date,
                              'offer_expires_at', aa.offer_expires_at),
           array[aa.member_id]
      into v_fact, v_audience
      from public.activity_applications aa
      join public.activities a on a.id = aa.activity_id
      join public.members m    on m.id = aa.member_id
     where aa.id = p_id
       and aa.offer_status = 'offered'
       and aa.offer_expires_at is not null
       and aa.offer_expires_at > now()
       -- A blocked member is not written to. Whether they should still be
       -- holding an offer is a separate question, and not one this function gets
       -- to answer by sending them a notification.
       and m.status = 'approved';

  elsif p_event = 'self_test' then
    -- The member pressed 테스트 알림 보내기. p_id is their own member id, which
    -- the Edge Function read from their session with current_member_id() — it
    -- does not come from the request body, so this cannot be aimed at anyone.
    select '{}'::jsonb, array[m.id]
      into v_fact, v_audience
      from public.members m
     where m.id = p_id and m.status = 'approved';

  else
    return null;
  end if;

  -- No such row, or it no longer qualifies. Null rather than an empty audience:
  -- "there is nothing to send" and "nobody has a device" are different facts and
  -- the function log should not blur them.
  if v_fact is null then
    return null;
  end if;

  return jsonb_build_object(
    'event', p_event,
    'fact', v_fact,
    -- People, not devices — one member with a phone and a laptop is one person
    -- reached. subscription_count is the device number and the sender counts it.
    'member_count', (
      select count(distinct ps.member_id)
        from public.push_subscriptions ps
       where ps.member_id = any(v_audience)
    ),
    'recipients', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', ps.id, 'endpoint', ps.endpoint,
               'p256dh', ps.p256dh, 'auth', ps.auth))
        from public.push_subscriptions ps
       where ps.member_id = any(v_audience)
    ), '[]'::jsonb)
  );
end $$;

comment on function public.push_notify_context_v1(text, uuid) is
  '알림 대상과 문구 근거를 이벤트 한 건에서 직접 읽어 돌려준다. 호출자는 수신자를 지정할 수 없고, 문구도 행에서만 나온다.';

-- ============================================================ asking for a send
-- pg_net, not a synchronous HTTP call, and that is the property that matters:
-- net.http_post() only inserts into net.http_request_queue and returns. The
-- actual request is made by a background worker after this transaction commits.
--
-- So a push that fails cannot roll back the thing it was about. A notice that
-- saved but whose notification failed is still a saved notice, and 공지 등록
-- 실패 can never appear because a push service was down. The coupling only runs
-- the other way: if the transaction aborts, the queue row goes with it and
-- nothing is sent about a notice that does not exist.
create or replace function public.request_push_notify(p_event text, p_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_url    text;
  v_secret text;
begin
  -- The escape hatch a backfill needs. `set local eysl.suppress_push = 'on'`
  -- inside a transaction stops every trigger below from queueing anything, which
  -- is what keeps an import of ten years of notices from waking the whole club.
  -- Second argument true: missing_ok, so an ordinary transaction that never set
  -- it gets null instead of an error.
  if coalesce(current_setting('eysl.suppress_push', true), '') = 'on' then
    return;
  end if;

  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'push_notify_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'push_notify_secret';

  -- Not configured yet. Returning quietly is deliberate: this migration must be
  -- applyable before the secrets exist, and a notice must save whether or not
  -- anybody can be told about it.
  if v_url is null or v_secret is null then
    return;
  end if;

  perform net.http_post(
    url := v_url,
    body := jsonb_build_object('event', p_event, 'id', p_id),
    params := '{}'::jsonb,
    -- The secret is how the Edge Function knows this came from us. It is the
    -- only thing separating "the database says a notice was posted" from anyone
    -- on the internet saying it, which is why it lives in Vault rather than in
    -- this file — this repository is public.
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-eysl-push-secret', v_secret),
    -- Generous because a club-wide notice is one HTTPS request per registered
    -- device and the function does not answer until they have all been
    -- attempted. Nothing waits on this timeout: it is spent in pg_net's worker.
    timeout_milliseconds := 30000
  );
end $$;

comment on function public.request_push_notify(text, uuid) is
  'pg_net으로 push-notify 엣지 함수에 이벤트를 넘긴다. 커밋 후 비동기 전송이라 알림 실패가 원래 작업을 되돌리지 않는다.';

-- ==================================================================== triggers
-- All three are SECURITY DEFINER so that request_push_notify() can stay revoked
-- from every client role. PostgreSQL checks EXECUTE on a trigger function when
-- the trigger is created rather than when it fires (the same point 0020:511
-- makes), so a member filing a 기타 still runs this without being granted
-- anything — and still cannot call request_push_notify() directly to announce
-- something that never happened.

create or replace function public.notices_notify_created()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform public.request_push_notify('notice_created', new.id);
  return null;
end $$;

comment on function public.notices_notify_created() is
  '공지가 등록되면 작성자를 뺀 승인 회원 전체에게 알림을 요청한다.';

drop trigger if exists notices_notify_created on public.notices;
create trigger notices_notify_created
  after insert on public.notices
  for each row execute function public.notices_notify_created();

create or replace function public.activities_notify_created()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform public.request_push_notify('activity_created', new.id);
  return null;
end $$;

comment on function public.activities_notify_created() is
  '일정이 등록되면 등록자를 뺀 승인 회원 전체에게 알림을 요청한다.';

drop trigger if exists activities_notify_created on public.activities;
create trigger activities_notify_created
  after insert on public.activities
  for each row execute function public.activities_notify_created();

-- The one that matters.
--
-- On the transition into 'offered', not inside offer_seat_to_next_waitlister().
-- Two reasons, and the second is the real one:
--
--   - that function is being worked on elsewhere for the seat-handout races, and
--     a notification bolted into its body would collide with that work;
--   - a trigger on the transition fires however the offer was made. Today all
--     three paths run through offer_seat_to_next_waitlister(); a fourth added
--     later, or a staffer nudging a row by hand in the SQL editor, notifies the
--     member without anybody having remembered to make it.
--
-- UPDATE only. No path inserts a row already holding an offer — apply_to_activity()
-- inserts at offer_status 'none' (0020:364, 0020:378) and the offer is always a
-- later UPDATE (0020:101). If that ever changes this needs an INSERT sibling,
-- because a `when` clause on an INSERT trigger cannot reference OLD.
create or replace function public.activity_applications_notify_offer()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  perform public.request_push_notify('waitlist_offered', new.id);
  return null;
end $$;

comment on function public.activity_applications_notify_offer() is
  '대기자에게 자리 오퍼가 나가면 그 회원에게만 알림을 요청한다. 오퍼를 누가 만들었든 상태 전이 자체에서 발화한다.';

drop trigger if exists activity_applications_notify_offer on public.activity_applications;
create trigger activity_applications_notify_offer
  after update of offer_status on public.activity_applications
  for each row when (new.offer_status = 'offered' and old.offer_status is distinct from 'offered')
  execute function public.activity_applications_notify_offer();

-- =============================================================== execute rights
-- Revoked by name as well as from PUBLIC, the same as 0020. push_notify_context_v1
-- returns every registered endpoint in an audience, which is the club's device
-- list — service_role reads it and nobody else. request_push_notify() would let
-- its caller announce anything to anyone, so it is granted to no role at all and
-- is reached only through the SECURITY DEFINER trigger functions above.
revoke all on function public.push_notify_context_v1(text, uuid)   from public, anon, authenticated;
revoke all on function public.request_push_notify(text, uuid)      from public, anon, authenticated, service_role;
revoke all on function public.notices_notify_created()             from public, anon, authenticated, service_role;
revoke all on function public.activities_notify_created()          from public, anon, authenticated, service_role;
revoke all on function public.activity_applications_notify_offer() from public, anon, authenticated, service_role;

grant execute on function public.push_notify_context_v1(text, uuid) to service_role;
