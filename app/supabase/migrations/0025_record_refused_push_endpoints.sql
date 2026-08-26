-- 0025 — keep the refused hosts, not just log them.
--
-- ============================================================ WHY THIS IS 0025
--
-- Two agents were given the same follow-up and worked in parallel in the same
-- worktree. 0024_log_refused_push_hosts landed first (by 48 seconds) and added
-- the `raise log`; this file originally existed as a second 0024 and duplicated
-- that work. It has been renumbered and stripped back to the half 0024 does not
-- do. The lesson is already in CLAUDE.md and this is what it looks like when it
-- bites: checking the ledger immediately before writing is not enough when
-- somebody else is writing at the same moment.
--
-- So the division is now clean:
--   0024  emits `raise log 'eysl push endpoint refused: host=%'` and owns
--         push_endpoint_host(). One log implementation, theirs.
--   0025  keeps a durable row, because a log is not a record.
--
-- =========================================================== WHY BOTH, THOUGH
--
-- 0024 is right that `raise log` is the correct instrument for the refusal path
-- itself — the raise rolls the transaction back and a row written there would
-- be undone with it. That reasoning is sound and this file does not touch it.
--
-- What a log cannot do is be there next month. Supabase retains Postgres logs
-- for a short window on the plans this project uses, and the question we are
-- trying to answer — which browsers do the club's actual members hold — is
-- answered by a count that accumulates, not by a line that scrolls past. A
-- member's registration failing at 2am on a Tuesday is exactly the evidence we
-- need and exactly the line most likely to have aged out before anyone looks.
--
-- So the table is written from the CLIENT'S error path (src/features/push/api.ts
-- calls the RPC below after catching 22023), which is its own transaction and
-- therefore commits. Between them: the log says a refusal happened even if no
-- client cooperates, and the table says which host, over time.
--
-- ================================================== THE OPEN QUESTION, BY NAME
--
-- Samsung Internet. It is the entry this allowlist is most likely to be missing,
-- and Korea is why that matters — Samsung Internet has a share here it has
-- almost nowhere else, so a club of Korean swimmers is close to the worst case
-- for guessing. Whether it issues fcm.googleapis.com endpoints (as an Android
-- browser using Play services would) or a Samsung-operated host could not be
-- established from this machine.
--
-- If push_endpoint_rejections fills with one Samsung-looking host and a Samsung
-- user agent beside it, that is this question answering itself, and the fix is
-- one entry in the VALUES list inside is_push_endpoint() (0023). Do not
-- pre-emptively add a host because it looks plausible — that is the guess this
-- table exists to replace.

-- ---------------------------------------------------------------- the table
-- The host and nothing else. An endpoint's path is a capability URL that
-- identifies one device; the question here is "which browsers" rather than
-- "which devices", and there is no reason for this table to be able to answer
-- the second one.
create table if not exists public.push_endpoint_rejections (
  host            text primary key,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  attempts        bigint not null default 0,
  -- One example is enough to recognise a browser. Overwritten rather than
  -- accumulated, for the same reason: this is not a device inventory.
  last_user_agent text
);

comment on table public.push_endpoint_rejections is
  '알림 등록이 거부한 푸시 서비스 호스트 기록. 어떤 브라우저가 실제로 막히는지 추측 대신 근거로 확인하려고 둔다. 삼성 인터넷이 대표적인 미확인 사례다.';

-- Server-side only, the same shape as push_self_test_quota: RLS on with no
-- policy denies everything by default, and the grants go too.
alter table public.push_endpoint_rejections enable row level security;
revoke all on public.push_endpoint_rejections from anon, authenticated;

-- --------------------------------------------------------------- the recorder
-- Called by the client from its 22023 handler, not by the register RPC. That is
-- forced rather than chosen: push_subscription_register_v1 signals refusal by
-- raising, and a raise rolls back its whole transaction — a row inserted there
-- would look completely correct, apply cleanly, and record nothing, forever.
-- 0024 makes the same point about why it uses a log.
--
-- The cost of that: this is only as reliable as the client. An old build or a
-- closed tab will not call it, and 0024's log line is what covers those.
create or replace function public.record_unsupported_push_endpoint_v1(
  p_endpoint   text,
  p_user_agent text default null
)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  -- A member could otherwise invent hosts and grow this table without limit.
  -- Past the cap, new hosts are counted together under one sentinel: the table
  -- stays bounded and the fact that something is being refused stays visible.
  -- Two hundred is far more distinct push services than exist.
  v_max_hosts constant int := 200;
  v_member uuid;
  v_host   text;
  v_known  boolean;
begin
  v_member := public.current_member_id();
  if v_member is null then
    raise exception 'not an approved member' using errcode = '42501';
  end if;

  -- Only records what the rule actually refuses. Without this the function is a
  -- free-text writer into a diagnostic table: a member could file
  -- 'fcm.googleapis.com' and make this say the allowlist is turning away
  -- Google, which is the one conclusion it must never be able to fake.
  if public.is_push_endpoint(p_endpoint) then
    return;
  end if;

  -- 0024's helper, not a second regex. Two parsers of the same string is how
  -- the log and the table start disagreeing about what host was refused.
  v_host := left(public.push_endpoint_host(p_endpoint), 253);
  if v_host is null then
    -- Not a URL we can name a host in. Grouped rather than dropped, because
    -- "the client is sending us nonsense" is itself worth being able to see,
    -- and it is the same word 0024 logs for this case.
    v_host := '(unparseable)';
  end if;

  select exists (select 1 from public.push_endpoint_rejections r where r.host = v_host)
    into v_known;
  if not v_known
     and (select count(*) from public.push_endpoint_rejections) >= v_max_hosts then
    v_host := '(overflow)';
  end if;

  insert into public.push_endpoint_rejections as r (host, attempts, last_user_agent)
  values (v_host, 1, left(nullif(btrim(coalesce(p_user_agent, '')), ''), 400))
  on conflict (host) do update
    set attempts        = r.attempts + 1,
        last_seen_at    = now(),
        -- coalesce so a caller that sent no user agent does not erase the one
        -- an earlier caller did send.
        last_user_agent = coalesce(excluded.last_user_agent, r.last_user_agent);
end $$;

comment on function public.record_unsupported_push_endpoint_v1(text, text) is
  '거부된 푸시 엔드포인트의 호스트만 기록한다. 실제로 거부되는 값만 남기며, 클라이언트가 실패 처리 중에 호출한다.';

-- =============================================================== execute rights
-- Revoked from public, anon and authenticated by name before anything is
-- granted back, not only from PUBLIC — 0014's lesson, repeated since.
revoke all on function public.record_unsupported_push_endpoint_v1(text, text)
  from public, anon, authenticated, service_role;

-- Client-callable: it is the client's error path that knows a registration was
-- refused. It checks its own caller and refuses to record anything the rule
-- would have accepted.
grant execute on function public.record_unsupported_push_endpoint_v1(text, text)
  to authenticated;

-- push_endpoint_host() stays granted to nobody, as 0024 left it. This function
-- is SECURITY DEFINER and runs as the owner, so it reaches the helper without
-- any client needing to.
