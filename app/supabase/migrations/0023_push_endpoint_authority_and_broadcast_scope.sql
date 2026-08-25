-- 0023 — three review findings on the push and media work, closed together
-- because two of them are about the same table.
--
-- 1. HIGH. push_subscriptions.endpoint was free text a member could write
--    directly (0004:121 for the policy, 0012:143 for the grant), and the
--    push-notify Edge Function reads that column with the service role and
--    fetches it (send.ts:157). A member could therefore store any URL, press
--    테스트 알림 보내기, and have our function make the request for them:
--    an internal address the function's network can reach, or somebody else's
--    server hit as often as the member cared to press the button. Nothing
--    limited the number of devices and nothing limited how often self_test
--    could be raised.
--
-- 2. MEDIUM. team_files_update (0021:218) tested only the first path segment
--    while team_files_insert tested the whole shape AND required a claiming
--    row. Supabase's storage `move` is SELECT + UPDATE, so the weaker policy
--    handed back exactly the unclaimed orphan the insert rule exists to stop.
--
-- 3. MEDIUM. Any approved member may create a 기타 (0015:95) and every
--    activity insert notified every approved member (0022:96). Both halves
--    were asked for; the combination — one member, one button, the whole club
--    notified, repeatedly — was not.
--
-- ============================================================ 1. push endpoints
--
-- WHICH LAYER, AND WHY THIS ONE.
--
-- The rule lands in three places, and each is there for a reason the other two
-- cannot cover:
--
--   * a SECURITY DEFINER RPC, with the direct INSERT/UPDATE grant removed.
--     This is the pattern the schema already uses wherever a write has a rule
--     to obey — send_message_v1 (0012), apply_to_activity (0020),
--     append_notice_comment (0004) — and it is the only layer that can also
--     count a member's devices, because a CHECK constraint sees one row and a
--     policy sees one row.
--
--   * a CHECK constraint, as the backstop. A policy is bypassed by the service
--     role and an RPC is bypassed by anything that does not call it; a
--     constraint is not bypassed by either. It is added NOT VALID on purpose —
--     see the note on the constraint itself.
--
--   * the sender, at the fetch (supabase/functions/push-notify/endpoint.ts).
--     The constraint does not retroactively repair rows written before today,
--     and the thing that actually makes the request is the thing that should
--     refuse to make it. A row that reaches the sender with an endpoint it
--     will not fetch is reported and skipped rather than deleted — deleting on
--     our own reading is how a working registration disappears (send.ts says
--     the same about undecryptable keys).
--
-- WHAT THE RULE IS: an allowlist of push service hosts, over HTTPS.
--
-- A denylist of private address ranges would not work, and it is worth being
-- exact about why so nobody "improves" this later by adding one. DNS is
-- resolved by fetch, after any check we could write here, so a hostname that
-- answers 203.0.113.1 for our check and 169.254.169.254 for the actual request
-- defeats a denylist completely. An allowlist is immune to that for a reason
-- that has nothing to do with timing: the attacker would have to control DNS
-- for fcm.googleapis.com, and if they do, this application has smaller
-- problems.
--
-- WHAT THIS DOES NOT PREVENT, stated plainly:
--
--   * It does not stop requests to the allowed push services. A member can
--     still cause traffic to Google, Apple, Mozilla or Microsoft — that is
--     what a push subscription is. The device cap and the self_test rate limit
--     below are what bound the volume, not this list.
--   * It is not a network control. If one of the allowed hostnames were ever
--     made to resolve somewhere else, this would not notice. A network egress
--     policy on the function is the control for that, and we do not have one.
--   * It cannot tell a real subscription from a syntactically valid fake at a
--     real push service. The push service does that, by answering 404.
--
-- The cost of an allowlist is that a browser using a push service nobody here
-- has heard of is refused. That refusal is loud rather than silent: the RPC
-- names the reason, and the settings screen shows the member the host it
-- rejected so it can be reported and added. Adding a host is one line here.

-- --------------------------------------------------------------- the rule
-- IMMUTABLE because a CHECK constraint requires it, and it genuinely is: the
-- answer depends on the argument and on nothing else — no session, no table,
-- no clock.
--
-- The host is taken as the text between '://' and the first '/', and the regex
-- in front of that is what makes the extraction safe rather than decorative:
--
--   * '@' is not in the permitted host characters, so
--     https://fcm.googleapis.com@evil.example/x cannot pass — the host would
--     have to be 'fcm.googleapis.com@evil.example', which the regex rejects.
--   * the host must be followed by '/', so fcm.googleapis.com.evil.example is
--     matched as that whole name and fails the allowlist.
--   * ':' is excluded, so no port — real push endpoints have none, and a port
--     is a scan surface for free.
--   * lower case only, because that is what a push service issues and case
--     folding is one more thing that can differ between this and the sender.
create or replace function public.is_push_endpoint(p_endpoint text)
returns boolean
language sql immutable
as $$
  select p_endpoint is not null
     -- An endpoint is a URL with an opaque token in it; these bounds only rule
     -- out the absurd, and the upper one is what stops a row being used as
     -- storage for something that is not an endpoint at all.
     and length(p_endpoint) between 20 and 1000
     and p_endpoint ~ '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+/[^\s]*$'
     and (
       select exists (
         select 1
           from (values
                  -- Chrome, Edge, Opera, Brave, and every Android browser that
                  -- uses Google Play services — which on the club's phones is
                  -- most of them.
                  ('fcm.googleapis.com'),
                  -- The older Google endpoint. Still held by subscriptions
                  -- created years ago and never re-subscribed.
                  ('android.googleapis.com'),
                  -- Firefox.
                  ('push.services.mozilla.com'),
                  -- Windows notification service, which is where Edge on a
                  -- desktop can still land.
                  ('notify.windows.com'),
                  -- Safari, and the only way an iPhone receives web push at
                  -- all. web.push.apple.com today; the suffix match covers a
                  -- future sibling without a migration.
                  ('push.apple.com')
                ) as allowed(host)
          -- Exact, or a subdomain of it. Not `like '%host'`, which would also
          -- accept notfcm.googleapis.com.
          where v.host = allowed.host or v.host like '%.' || allowed.host
       )
       from (select substring(p_endpoint from '^https://([^/]+)/') as host) as v
     )
$$;

comment on function public.is_push_endpoint(text) is
  '웹푸시 엔드포인트가 알려진 푸시 서비스의 HTTPS 주소인지. 테이블 제약과 등록 RPC와 발송 함수가 같은 규칙을 쓴다.';

-- --------------------------------------------------------- the backstop
-- NOT VALID, and this is a decision rather than a shortcut.
--
-- Rows written before today may hold anything, and a validated constraint would
-- refuse to be added at all if even one of them did — which would mean this
-- migration fails on the one database where the finding actually matters. NOT
-- VALID enforces the rule on every INSERT and every UPDATE from this moment,
-- which is the whole future, and leaves the existing rows alone.
--
-- The existing rows are handled by the sender refusing to fetch them, not by
-- this constraint. They are counted below so that whoever applies this knows
-- how many there are rather than assuming zero.
alter table public.push_subscriptions
  drop constraint if exists push_subscriptions_endpoint_is_push_service;
alter table public.push_subscriptions
  add constraint push_subscriptions_endpoint_is_push_service
  check (public.is_push_endpoint(endpoint)) not valid;

do $$
declare
  v_bad bigint;
begin
  select count(*) into v_bad
    from public.push_subscriptions
   where not public.is_push_endpoint(endpoint);
  if v_bad > 0 then
    -- Not an error. The sender skips these, and deleting a member's row on our
    -- own reading is the thing this schema keeps deciding not to do. Said out
    -- loud so it is a known number rather than a surprise.
    raise notice
      'push_subscriptions: % existing row(s) hold an endpoint this rule refuses; the sender will skip them',
      v_bad;
  end if;
end $$;

-- ------------------------------------------------------------ device limit
-- Five.
--
-- A member with a phone, a tablet, a home laptop and a work laptop is at four,
-- and the fifth is the one they have not thought of. Above that the rows are
-- not devices — a browser that reinstalls issues a new endpoint each time, and
-- those are cleared automatically when the push service answers 404 or 410
-- (send.ts:173), so a member who is genuinely at the cap has stale rows and can
-- see them: the 알림 설정 screen lists every device with a 기기 삭제 button.
--
-- Refusing rather than evicting the oldest, for that reason. Eviction would
-- silently unregister a device the member still uses, and the screen already
-- offers the remedy for a refusal.
create or replace function public.push_subscription_register_v1(
  p_endpoint   text,
  p_p256dh     text,
  p_auth       text,
  p_user_agent text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  -- Changing this means changing MAX_PUSH_DEVICES in src/features/push/api.ts,
  -- which is what the screen says out loud. endpoint.rule.test.ts fails if the
  -- two ever disagree.
  v_max_devices constant int := 5;
  v_member uuid;
  v_count  int;
  v_id     uuid;
begin
  v_member := public.current_member_id();
  if v_member is null then
    raise exception 'not an approved member' using errcode = '42501';
  end if;

  if not public.is_push_endpoint(p_endpoint) then
    -- The host is not repeated back here. The caller sent the endpoint and can
    -- read the host off it, and an error message is not the place to echo an
    -- attacker's string.
    raise exception 'unsupported push endpoint' using errcode = '22023';
  end if;

  -- Both are what a sender encrypts to. A row without them can never deliver
  -- anything, and the client already refuses to reach here without them — this
  -- is the copy of that rule that survives the client being bypassed.
  if coalesce(btrim(p_p256dh), '') = '' or coalesce(btrim(p_auth), '') = '' then
    raise exception 'subscription keys are required' using errcode = '22023';
  end if;

  -- Serialises this member's own registrations so the count below is exact.
  -- Without it two browsers registering at the same moment each see four rows
  -- and each add one. Per member, so it costs nobody else anything.
  perform pg_advisory_xact_lock(hashtextextended('push_subscription_register:' || v_member::text, 0));

  insert into public.push_subscriptions (member_id, endpoint, p256dh, auth, user_agent, updated_at)
  values (v_member, p_endpoint, p_p256dh, p_auth, nullif(btrim(coalesce(p_user_agent, '')), ''), now())
  -- Re-enabling on a device that is already registered refreshes the row. It is
  -- also what keeps a re-registration from counting against the cap: the row
  -- count does not change.
  on conflict (member_id, endpoint) do update
    set p256dh     = excluded.p256dh,
        auth       = excluded.auth,
        user_agent = excluded.user_agent,
        updated_at = now()
  returning id into v_id;

  -- Counted after the write rather than before it, so the number tested is the
  -- number that would exist. The raise aborts the transaction and takes the
  -- insert with it.
  select count(*) into v_count from public.push_subscriptions where member_id = v_member;
  if v_count > v_max_devices then
    raise exception 'device limit reached: %', v_max_devices using errcode = '53400';
  end if;

  return v_id;
end $$;

comment on function public.push_subscription_register_v1(text, text, text, text) is
  '이 기기의 웹푸시 구독을 등록한다. 회원은 세션에서 정하고, 엔드포인트는 알려진 푸시 서비스만 허용하며, 한 회원당 기기 수를 제한한다.';

-- ------------------------------------------------------- the direct write goes
-- The table keeps SELECT (the settings screen lists devices) and DELETE (알림
-- 끄기 and 기기 삭제, both of which only ever remove the caller's own row and
-- need no rule beyond that). INSERT and UPDATE are the two with a rule, so they
-- go through the RPC and nowhere else.
revoke insert, update on public.push_subscriptions from authenticated;

-- The FOR ALL policy is replaced by the two commands that remain reachable.
-- Leaving it as FOR ALL would still be correct — the grant is what is gone —
-- but a policy that describes writes nobody can make reads as though they can.
drop policy if exists push_subscriptions_self on public.push_subscriptions;

drop policy if exists push_subscriptions_self_read on public.push_subscriptions;
create policy push_subscriptions_self_read on public.push_subscriptions
  for select using (member_id = public.current_member_id());

drop policy if exists push_subscriptions_self_delete on public.push_subscriptions;
create policy push_subscriptions_self_delete on public.push_subscriptions
  for delete using (member_id = public.current_member_id());

-- ------------------------------------------------------ self_test rate limit
-- 테스트 알림 보내기 is the one event a member can raise directly. Proving push
-- works takes one send; the endpoint accepted a thousand.
--
-- The counter lives here rather than in the Edge Function because a function
-- instance remembers nothing between invocations — Supabase may run the next
-- request in a different one, so any limit kept in the process is a limit that
-- resets whenever the platform feels like it.
--
-- Two limits, because they answer different abuses: sixty seconds between
-- sends stops the button being held down, and ten in a rolling hour stops a
-- patient script. A member who genuinely needs an eleventh test in an hour is
-- not testing any more.
create table if not exists public.push_self_test_quota (
  member_id         uuid primary key references public.members(id) on delete cascade,
  window_started_at timestamptz not null default now(),
  sent_in_window    int not null default 0,
  last_sent_at      timestamptz
);

comment on table public.push_self_test_quota is
  '테스트 알림 발송 빈도 제한 상태. 회원당 한 행이며 서버(서비스 롤)만 읽고 쓴다.';

-- No policy at all, and the grants stripped: this is bookkeeping the client has
-- no business reading, and RLS with no policy denies everything by default. The
-- same shape as schema_migrations in 0002.
alter table public.push_self_test_quota enable row level security;
revoke all on public.push_self_test_quota from anon, authenticated;

create or replace function public.push_self_test_allow_v1(p_member uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_cooldown constant interval := interval '60 seconds';
  v_window   constant interval := interval '1 hour';
  v_max      constant int      := 10;
  v_row      public.push_self_test_quota;
  v_window_started timestamptz;
  v_sent     int;
  v_retry    int;
begin
  insert into public.push_self_test_quota (member_id)
  values (p_member)
  on conflict (member_id) do nothing;

  -- FOR UPDATE so two requests from the same member queue rather than both
  -- reading the same count. This is the whole concurrency story: one row, one
  -- member, held for the microseconds this function runs.
  select * into v_row from public.push_self_test_quota
   where member_id = p_member for update;

  v_window_started := v_row.window_started_at;
  v_sent := v_row.sent_in_window;

  -- A window older than an hour is not a window any more.
  if v_window_started + v_window <= now() then
    v_window_started := now();
    v_sent := 0;
  end if;

  if v_row.last_sent_at is not null and v_row.last_sent_at + v_cooldown > now() then
    v_retry := ceil(extract(epoch from (v_row.last_sent_at + v_cooldown - now())))::int;
    return jsonb_build_object('allowed', false, 'reason', 'cooldown',
                              'retry_after_seconds', greatest(v_retry, 1));
  end if;

  if v_sent >= v_max then
    v_retry := ceil(extract(epoch from (v_window_started + v_window - now())))::int;
    return jsonb_build_object('allowed', false, 'reason', 'hourly_limit',
                              'retry_after_seconds', greatest(v_retry, 1));
  end if;

  -- Counted on the attempt, not on a successful delivery. A send that fails
  -- still cost a function invocation and still wrote to a push service, which
  -- is the thing being limited.
  update public.push_self_test_quota
     set window_started_at = v_window_started,
         sent_in_window    = v_sent + 1,
         last_sent_at      = now()
   where member_id = p_member;

  return jsonb_build_object('allowed', true, 'remaining_in_window', v_max - (v_sent + 1));
end $$;

comment on function public.push_self_test_allow_v1(uuid) is
  '테스트 알림을 지금 보내도 되는지 판정하고 횟수를 센다. 엣지 함수가 서비스 롤로만 호출한다.';

-- ============================================== 2. the storage move loophole
--
-- team_files_insert asks two questions — is this path the shape a media object
-- may have, and does a media_files row already claim it — and team_files_update
-- asked neither, only whether the first path segment was the caller's id.
--
-- Supabase's `move` is implemented as SELECT + UPDATE on storage.objects, so a
-- member could move their own legitimately-uploaded object to
-- <own id>/anything/deeper/path and produce precisely the unclaimed orphan that
-- 0021 exists to prevent: bytes in the bucket that no row points at, invisible
-- to every screen in the app, still costing the quota.
--
-- The fix is to ask the same two questions, rather than to drop the policy.
-- Nothing in the app moves an object — media/api.ts calls upload() and remove()
-- and nothing else, and renaming a file deliberately leaves storage_path alone
-- — but the storage service itself updates the object row while finishing an
-- upload, and 0021 kept this policy for that reason. Both predicates hold
-- during an upload: the media_files row goes in first (that is the reversed
-- order 0021 describes), so the path is already claimed and already the right
-- shape by the time the object is written.
--
-- USING sees the row as it stands and WITH CHECK the row as it would become, so
-- naming both predicates in both halves is what closes the move: the
-- destination has to be a legal path that a row already claims, which is the
-- same bar an upload has to clear.
drop policy if exists team_files_update on storage.objects;
create policy team_files_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'team-files'
    and public.is_my_media_object_path(name)
    and public.media_object_is_claimed(name)
  )
  with check (
    bucket_id = 'team-files'
    and public.is_my_media_object_path(name)
    and public.media_object_is_claimed(name)
  );

-- ============================================ 3. who may notify the whole club
--
-- 0015 opened 기타 creation to every approved member because the president's
-- app does (canCreateActivityType, his index.html:3761). 0022 notified every
-- approved member on every activity insert because he asked for 일정 등록
-- alerts by name. Each is what was wanted. Together they are a megaphone: any
-- member, any number of times, an app-branded notification to the entire club.
--
-- THE DECISION, so nobody has to guess later that it was one: an activity
-- created by staff notifies the club; an activity created by an ordinary member
-- does not notify anyone. Both of his features survive — members still file
-- 기타, staff-posted 일정 still notify — and the combination nobody chose is
-- what goes.
--
-- A member's 기타 deliberately notifies NOBODY rather than some smaller
-- audience. There is no group it obviously belongs to: the club has no concept
-- of a member's followers, and "everyone who has applied" is empty at the
-- moment of creation, which is the only moment this event fires. A 기타 is
-- found on the 일정 screen, the way it was before there was a sender at all.
--
-- If this ever needs revisiting, the thing to change is who — not whether a
-- rule exists.

-- Distinct from is_staff(), which asks about the current session. This asks
-- about a named member, which is the only form available to a trigger running
-- after the fact and to the Edge Function's service-role context, where there
-- is no session to ask about.
create or replace function public.member_is_staff(p_member uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.members
     where id = p_member
       and status = 'approved'
       and role in ('admin','master_admin')
  )
$$;

comment on function public.member_is_staff(uuid) is
  '지정한 회원이 승인된 운영진인지. 세션이 아니라 회원을 묻는다는 점에서 is_staff()와 다르다.';

-- The trigger decides, so a member's 기타 never even reaches the queue. Doing
-- it here rather than only in the context function is what makes that true:
-- pg_net's row, the function invocation and the log line all fail to happen,
-- instead of a request being made and then finding nobody to send to.
create or replace function public.activities_notify_created()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  -- created_by null means nobody's session wrote this row: a migration, a
  -- backfill, or the president pasting into the SQL editor. Those still notify,
  -- which is 0022's stated property that a row inserted by any path behaves the
  -- same. It is not a hole a member can climb through — activities_set_created_by
  -- (0015) fills the column from the session on every insert, and both member
  -- write policies refuse a caller whose current_member_id() is null, so a
  -- member's row always carries their id.
  if new.created_by is not null and not public.member_is_staff(new.created_by) then
    return null;
  end if;

  perform public.request_push_notify('activity_created', new.id);
  return null;
end $$;

comment on function public.activities_notify_created() is
  '운영진이 등록한 일정만 알림을 요청한다. 회원이 만든 기타 일정은 알리지 않는다.';

-- The trigger itself is unchanged (0022:272-275 already binds this function to
-- AFTER INSERT); replacing the function body is the whole change.

-- The same rule again in the audience, for the reason 0015:97 gives about its
-- own pair: the trigger is what makes this correct, and this is what keeps it
-- correct if somebody later queues the event another way. Both call the same
-- helper, so there is one definition to change.
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
    --
    -- Unchanged by this migration: notices are staff-only to begin with
    -- (notices_write, 0004:186), so there is no member broadcast to close here.
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
     where a.id = p_id
       -- The half of the broadcast rule that survives the trigger being
       -- bypassed. Null created_by notifies for the reason the trigger gives.
       and (a.created_by is null or public.member_is_staff(a.created_by));

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
    -- Endpoints are NOT filtered by is_push_endpoint() here, deliberately. The
    -- thing that makes the request is the thing that should decide whether to
    -- make it, and a row skipped by the sender is visible in the send report
    -- while a row filtered out here would be indistinguishable from a member
    -- who never registered anything.
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
  '알림 대상과 문구 근거를 이벤트 한 건에서 직접 읽어 돌려준다. 호출자는 수신자를 지정할 수 없고, 문구도 행에서만 나온다. 일정 알림은 운영진이 등록한 것만 대상이 된다.';

-- =============================================================== execute rights
-- Revoked from public, anon and authenticated by name before anything is
-- granted back, not only from PUBLIC: Supabase's default privileges on a new
-- function are separate grants, which is how 0002's expire_stale_offers stayed
-- anonymously callable after a `revoke … from public` that read correctly.
-- 0014 traced that and the lesson is repeated in every migration since.
revoke all on function public.is_push_endpoint(text)
  from public, anon, authenticated, service_role;
revoke all on function public.member_is_staff(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.push_subscription_register_v1(text, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.push_self_test_allow_v1(uuid)
  from public, anon, authenticated, service_role;

-- Named inside the push_subscriptions CHECK constraint, which is evaluated as
-- whoever is writing the row. Without EXECUTE the constraint is unevaluable and
-- every insert fails — including the one the RPC makes on the member's behalf,
-- since a SECURITY DEFINER function runs as its owner but a row written through
-- it is still checked in a context that must be able to call this.
grant execute on function public.is_push_endpoint(text) to authenticated, service_role;

-- The one client-callable addition. It checks its own caller.
grant execute on function public.push_subscription_register_v1(text, text, text, text)
  to authenticated;

-- Server-side only. push_self_test_allow_v1 decides whether a member may raise
-- self_test, so a member who could call it directly could spend their own quota
-- — or, worse, read whether somebody else had. member_is_staff is granted to
-- service_role because push_notify_context_v1 names it and runs there.
grant execute on function public.push_self_test_allow_v1(uuid) to service_role;
grant execute on function public.member_is_staff(uuid) to service_role;
