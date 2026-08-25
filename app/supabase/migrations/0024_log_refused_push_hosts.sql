-- 0024 — record which push hosts we refuse, so the allowlist stops being a guess.
--
-- 0023 chose a narrow allowlist over a private-range denylist, and that choice is
-- right: DNS resolves at fetch time, so a denylist loses to a hostname that
-- answers harmlessly when checked and answers 169.254.169.254 when fetched.
--
-- The cost of narrow is a member whose browser uses a push service we did not
-- list cannot turn notifications on at all. It fails loudly, which is the good
-- half; the bad half is that we only learn about it if that member says so.
--
-- The open question is **Samsung Internet**, and it matters here specifically:
-- Samsung has a large share of Korean mobile browsing, and it was not possible
-- to confirm from this machine whether it issues FCM endpoints or its own host.
-- Guessing a host into the allowlist would be widening security on a hunch.
-- Logging the refusal turns that hunch into evidence: the first real refusal
-- names the host, and adding it is one line in the next migration.
--
-- WHY A LOG AND NOT A TABLE. The refusal path ends in `raise exception`, which
-- rolls the transaction back — an INSERT recorded just before it would be undone
-- along with everything else. `raise log` is emitted as it happens and survives
-- the rollback. That is why it is the right instrument here, not a shortcut.
--
-- WHAT IS RECORDED: the host, and nothing else. Not the full endpoint (it is a
-- capability URL, and a caller-supplied string does not belong in a log
-- verbatim), not the subscription keys, not the member id — the point is to
-- learn which browser we are turning away, not who was holding it.
--
-- The function below is 0023's body with one `raise log` added. Everything else
-- — the four-argument signature, the constant, hashtextextended, the
-- (member_id, endpoint) conflict target, user_agent and updated_at — is carried
-- across unchanged. A rewrite from memory dropped p_user_agent and changed the
-- conflict target on the first attempt, which would have broken the client's
-- call and the device cap at once.

create or replace function public.push_endpoint_host(p_endpoint text)
returns text
language sql immutable
as $$
  -- Host only: everything between the scheme and the next / : ? or #. Returns
  -- null rather than raising on a string that is not a URL at all, because the
  -- caller is already on its way to refusing it.
  select nullif((regexp_match(coalesce(p_endpoint, ''), '^[a-zA-Z][a-zA-Z0-9+.-]*://([^/:?#]+)'))[1], '')
$$;

comment on function public.push_endpoint_host(text) is
  'The host part of an endpoint URL, for logging a refusal without echoing the whole caller-supplied string.';

revoke all on function public.push_endpoint_host(text) from public, anon, authenticated;

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
    -- Emitted before the raise, and therefore before the rollback the raise
    -- causes. Prefixed so one search finds every occurrence:
    --   Supabase dashboard → Logs → "eysl push endpoint refused"
    raise log 'eysl push endpoint refused: host=%',
      coalesce(public.push_endpoint_host(p_endpoint), '(unparseable)');

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
  '이 기기의 웹푸시 구독을 등록한다. 회원은 세션에서 정하고, 엔드포인트는 알려진 푸시 서비스만 허용하며, 한 회원당 기기 수를 제한한다. 거부된 호스트는 로그에 남는다.';

-- CREATE OR REPLACE preserves the ACL, but re-assert it rather than assume:
-- 0023 put this on authenticated only, and that must survive this migration.
revoke all on function public.push_subscription_register_v1(text, text, text, text) from public, anon;
grant execute on function public.push_subscription_register_v1(text, text, text, text) to authenticated;
