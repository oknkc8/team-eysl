-- 0028 — make 가입 신청 actually create an account.
--
-- 0027 built the half that runs *after* an account exists: a trigger on
-- auth.users that creates the pending members row inside GoTrue's own
-- transaction. It said plainly that it was "correct and inert until account
-- creation itself has a working path", and it still is. Nothing has been able to
-- create the account.
--
-- The blocker, established against this project rather than assumed: GoTrue
-- validates deliverability on signup, so `auth.signUp` for `<nickname>@eysl.local`
-- answers 400 email_address_invalid — `.local` does not resolve, and neither
-- does a domain with no MX record (example.com is refused the same way). The
-- same address is accepted by signInWithPassword, which is exactly why this hid
-- for so long: every seeded account signs in normally, so login worked and only
-- account creation was broken. Repeating the attempt earns 429
-- over_email_send_rate_limit, which also says confirmations are switched on and
-- would be posted to an address that can never receive them.
--
-- ============================================================================
-- WHAT THIS COSTS, because it is not the ordinary route and somebody will read
-- this in a year and need to know it was a decision.
-- ============================================================================
--
-- register_member_v1() writes into the `auth` schema directly: it inserts the
-- auth.users row and its auth.identities row itself, with a bcrypt hash it
-- computes, and lets 0027's trigger produce the members row. That is reaching
-- into somebody else's schema. Concretely:
--
--   * IT CAN BREAK ON A SUPABASE UPGRADE. GoTrue owns auth.users and may add a
--     NOT NULL column, change how a password is stored, or change what sign-in
--     reads. Nothing warns us; the signup screen simply starts failing. Two
--     traps of exactly this kind are already known and are why the column list
--     below looks over-specified: the four *_token columns must be '' and not
--     NULL or every sign-in answers 500 "Database error querying schema"
--     (GoTrue scans them into Go strings), and auth.identities needs a matching
--     row or sign-in fails even though the user exists. Neither error names the
--     table or column responsible.
--   * IT SKIPS EVERYTHING GOTRUE WOULD HAVE DONE. No email confirmation (there
--     is no transport and no real address to confirm), no password-strength
--     policy from the project settings, no auth audit log entry, no hook. The
--     rules that would have been GoTrue's are re-stated in SQL below, which
--     means they are now ours to keep in step.
--   * THE PASSWORD IS HASHED IN THE DATABASE, so the plaintext arrives as an
--     RPC argument and can land in a statement log if this project ever enables
--     one. GoTrue would have hashed it in the API tier instead.
--
-- THE ORDINARY ROUTE, AND WHY IT IS THE BETTER LONG-TERM ANSWER: an Edge
-- Function holding the service-role key, calling `auth.admin.createUser`.
-- admin.createUser skips the deliverability check that blocks signUp, writes
-- every auth column the way GoTrue itself expects, and keeps this repository out
-- of the auth schema entirely — it is almost certainly why the president's app
-- has a `register-member` function. It would also let the rate limiting move to
-- the edge, in front of the database, rather than inside it.
--
-- WHAT WOULD HAVE TO HAPPEN TO SWITCH: (1) a service-role key for the project,
-- which does not exist anywhere in this repository or its .env — there is no
-- management token either, so the auth settings cannot be changed from here; (2)
-- somewhere to deploy Edge Functions for the dev project; (3) a decision about
-- what address the account carries, since the whole eysl.local scheme exists
-- only because the club identifies people by 닉네임 and has no email addresses
-- for them. The migration to make the switch is small: drop the two auth inserts
-- out of register_member_v1 and have the Edge Function call it, or retire it.
-- Everything else here — the pending default, the uniqueness arbiter, the quota
-- table, the trigger — survives that change unaltered.
--
-- Until then, this is the only route that exists, and the alternative is a
-- signup screen that cannot sign anybody up.

-- ============================================================ 1. the rate limit
--
-- An account-creation endpoint callable by an anonymous stranger, with no limit,
-- is an invitation. The shape is lifted from 0023's push_self_test_quota /
-- push_self_test_allow_v1: one row per caller, a rolling window, and a FOR
-- UPDATE so two simultaneous requests queue instead of both reading the same
-- count.
--
-- WHAT IT KEYS ON. 0023 keys on member_id, which does not exist here — the
-- caller is anonymous by definition. It keys on the client IP instead, read from
-- request.headers, which PostgREST does expose to a SECURITY DEFINER function
-- called by `anon` (verified on this project: cf-connecting-ip carried the real
-- client address). inet_client_addr() is useless for this — it reports the
-- pooler's own connection, ::1.

create table if not exists public.signup_attempt_quota (
  client_key         text primary key,
  window_started_at  timestamptz not null default now(),
  attempts_in_window int not null default 0,
  last_attempt_at    timestamptz
);

comment on table public.signup_attempt_quota is
  '가입 신청 시도 빈도 제한 상태. 클라이언트 IP당 한 행이며 register_member_v1만 읽고 쓴다.';

-- No policy at all, and the grants stripped: bookkeeping no client has any
-- business reading, and RLS with no policy denies everything by default. Same
-- shape as push_self_test_quota (0023) and schema_migrations (0002).
alter table public.signup_attempt_quota enable row level security;
revoke all on public.signup_attempt_quota from anon, authenticated;

-- Which header to trust, in order.
--
-- cf-connecting-ip first because Cloudflare sets it at its own edge and a client
-- cannot forge it — unlike x-forwarded-for, which is a client-appendable list
-- and is only consulted here as a last resort, leftmost hop (the origin client).
-- 'unknown' rather than NULL for the no-header case so that those callers share
-- one bucket and are still limited, instead of falling out of the limit
-- entirely. A direct psql caller lands in that bucket, which is what makes this
-- testable without a browser.
create or replace function public.signup_client_key()
returns text
language sql stable security definer set search_path = public
as $$
  select coalesce(
    nullif(btrim(current_setting('request.headers', true)::json->>'cf-connecting-ip'), ''),
    nullif(btrim(current_setting('request.headers', true)::json->>'sb-forwarded-for'), ''),
    nullif(btrim(split_part(
      current_setting('request.headers', true)::json->>'x-forwarded-for', ',', 1)), ''),
    'unknown'
  )
$$;

comment on function public.signup_client_key() is
  '가입 신청 횟수를 세는 기준 키(클라이언트 IP). register_member_v1만 호출한다.';

-- ================================================== 2. shutting the other door
--
-- 0027's trigger creates a members row for *any* auth.users insert. GoTrue's own
-- signup is enabled on this project (/auth/v1/settings reports
-- disable_signup:false, external.email:true), so an address GoTrue considers
-- deliverable is a second way into public.members — one that never passes the
-- quota below, never sees the 8-character rule below, and never touches this
-- function at all. Every limit in this migration would be decorative while that
-- door stands open.
--
-- HONESTY ABOUT THE EVIDENCE: the open case was not demonstrated. Both addresses
-- available for testing were refused by the deliverability check (eysl.local,
-- example.com), and demonstrating the accepted case means sending a confirmation
-- mail to a real mailbox belonging to somebody who did not ask for it. So this
-- rests on the invariant rather than on an exploit: every account in this schema
-- is addressed at eysl.local, that has been true since the first seed, and until
-- now it was enforced nowhere.
--
-- WHAT IT COSTS: creating a user from the Supabase dashboard with any other
-- address is now refused, and a future move to real email addresses has to lift
-- this check in the same migration that makes the move. Refusing rather than
-- silently skipping the members row is deliberate — a skip would produce exactly
-- the orphaned auth account 0027 exists to prevent, an account that signs in
-- forever and no admin screen can see.

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_nickname text;
begin
  -- The invariant, enforced. register_member_v1 builds this address; GoTrue
  -- refuses to, which is what makes the RPC the only door rather than the
  -- preferred one.
  if new.email is null or lower(new.email) not like '%@eysl.local' then
    raise exception '이 프로젝트에서는 eysl.local 주소로만 계정을 만들 수 있습니다'
      using errcode = '22023';
  end if;

  -- Already linked to a member: nothing to create. Keeps this trigger harmless
  -- if an account is ever created for a member who exists already, rather than
  -- raising and blocking the insert.
  if exists (select 1 from public.members where auth_user_id = new.id) then
    return new;
  end if;

  -- The one key read out of client-supplied metadata. The fallback is the
  -- address local part, which GoTrue itself validated and made unique.
  v_nickname := btrim(coalesce(new.raw_user_meta_data->>'nickname', split_part(new.email, '@', 1)));

  -- The null check is not redundant: an account created without an email (phone
  -- signup, or a row inserted by hand) leaves both sides of the coalesce null,
  -- and `length(null) < 2` is null rather than true — so without this the
  -- function would fall through to the insert and fail on the NOT NULL
  -- constraint, which reaches the applicant as an unreadable database error.
  if v_nickname is null or length(v_nickname) < 2 then
    raise exception '닉네임은 2자 이상이어야 합니다' using errcode = '22023';
  end if;
  if length(v_nickname) > 30 then
    raise exception '닉네임은 30자 이하여야 합니다' using errcode = '22023';
  end if;

  -- status and role are deliberately not in this column list. They default to
  -- 'pending' and 'member' (0001:33-36), and that is the only way they can be
  -- set here — there is no expression in this function that could carry a value
  -- from the request into either column.
  insert into public.members (auth_user_id, nickname)
  values (new.id, v_nickname);

  return new;
exception
  -- members_nickname_lower_uq (0001:45). Raised rather than swallowed: the
  -- whole signup rolls back, so the applicant may pick another nickname instead
  -- of ending up with an account that has no member behind it.
  when unique_violation then
    raise exception '이미 사용 중인 닉네임입니다' using errcode = '23505';
end $$;

comment on function public.handle_new_auth_user() is
  '가입 시 members 행을 pending 상태로 생성한다. status·role은 클라이언트가 보낸 메타데이터에서 읽지 않으며, eysl.local 주소만 허용한다.';

revoke all on function public.handle_new_auth_user() from public, anon, authenticated;

-- ================================================================ 3. the RPC
--
-- WHAT THE CALLER MAY DECIDE: a nickname and a password. That is the entire
-- surface. There is no status parameter, no role parameter, no member id and no
-- email — nothing the client can name, because anything it can name it can lie
-- about. PostgREST matches an RPC by argument name, so a body carrying extra
-- keys does not "get them ignored", it fails to match this function at all.
-- Even if it did match, status and role appear nowhere in the insert path: the
-- members row is written by 0027's trigger, which reads exactly one key out of
-- the metadata, and the columns take their 0001 defaults ('pending', 'member').
--
-- WHY IT RETURNS A REFUSAL INSTEAD OF RAISING ONE. A RAISE aborts the
-- transaction PostgREST opened, and that would take the quota increment with it
-- — a rate limiter whose counter is rolled back by the very failure it is
-- supposed to be counting is not a rate limiter. So every *expected* refusal is
-- a returned object and an HTTP 200, the attempt is counted, and the caller
-- reads `ok`. Only genuinely unexpected errors raise, and those should abort.
-- 0023's helper returns its decision as jsonb for the same reason.
--
-- WHAT THIS DELIBERATELY GIVES AWAY, since it undoes something the login screen
-- was careful about. LoginPage answers an unknown nickname and a wrong password
-- with the same sentence on purpose — "a different one here would let anyone
-- enumerate who is in the club" (flows.spec.ts). This function cannot keep that
-- secret: an applicant has to be told the nickname is taken, or they cannot
-- choose one. So an anonymous caller can ask "is 홍길동 a member?" and get a
-- straight answer, which is precisely what the login screen refuses to give.
--
-- That is inherent to having a signup form at all, and the answer is not to make
-- the form useless but to make the asking expensive: the quota above is the only
-- thing standing between this and a full roster dump, which is a large part of
-- why it exists. At 60 an hour per address, enumerating a club-sized membership
-- is slow and leaves a row per attempt behind. It is a real trade and it is
-- being made knowingly.
--
-- WHY UNIQUENESS IS NOT CHECKED FIRST. A `select … where nickname = …` followed
-- by an insert loses to a second signup that runs between the two, and the loser
-- is a 500 rather than a sentence. The unique indexes arbitrate instead:
-- auth.users.users_email_partial_key on the derived address, and
-- members_nickname_lower_uq inside the trigger for the case where a members row
-- exists with no auth account behind it (0001's FK is ON DELETE SET NULL, so
-- that state is reachable). The two are exactly aligned — the address is
-- lower(nickname) — so either one firing means the same thing, and one handler
-- translates both into the same Korean sentence.

create or replace function public.register_member_v1(p_nickname text, p_password text)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  -- 60 an hour from one address. Deliberately not a small number: a club sits
  -- ten people on one pool-wifi NAT and tells them all to install the app, and
  -- every one of them is the same client_key. A script wanting to fill the
  -- approval queue wants thousands, so the cap still bites where it matters.
  v_window   constant interval := interval '1 hour';
  v_max      constant int      := 60;
  -- Deliberately NO per-attempt cooldown, unlike 0023. There the limited thing
  -- is an outbound push and a burst is the abuse; here a cooldown's only real
  -- effect is to refuse the second person on that shared wifi.
  v_nickname text;
  v_email    text;
  v_key      text;
  v_row      public.signup_attempt_quota;
  v_started  timestamptz;
  v_attempts int;
  v_retry    int;
  v_auth_id  uuid := gen_random_uuid();
begin
  v_nickname := btrim(coalesce(p_nickname, ''));

  -- The screen checks all four of these too (signup.ts). They are restated here
  -- because a direct RPC call never sees the screen, and "the client validates
  -- it" is not a rule, it is a hope. Validation runs before the quota so that
  -- somebody who mistypes their own password does not spend an attempt.
  if length(v_nickname) < 2 then
    return jsonb_build_object('ok', false, 'reason', 'nickname_short',
      'message', '닉네임은 2자 이상 입력해주세요.');
  end if;
  if length(v_nickname) > 30 then
    return jsonb_build_object('ok', false, 'reason', 'nickname_long',
      'message', '닉네임은 30자 이하로 입력해주세요.');
  end if;
  if length(coalesce(p_password, '')) < 8 then
    return jsonb_build_object('ok', false, 'reason', 'password_short',
      'message', '비밀번호는 8자 이상으로 설정해주세요.');
  end if;
  -- Bytes, not characters: bcrypt silently truncates at 72 and a Korean
  -- character is three bytes, so 25 Korean characters is already past the limit
  -- while reading as a short password. Refusing beats storing a password whose
  -- tail quietly does not count.
  if octet_length(coalesce(p_password, '')) > 72 then
    return jsonb_build_object('ok', false, 'reason', 'password_long',
      'message', '비밀번호가 너무 깁니다. 조금 짧게 설정해주세요.');
  end if;

  v_key := public.signup_client_key();

  -- Bounded retention. A key nobody has used for two windows is not evidence of
  -- anything, and this table would otherwise accumulate an IP address per
  -- visitor forever — an IP address is personal data, and keeping one for an
  -- hour to count with is a very different thing from keeping it indefinitely.
  --
  -- SKIP LOCKED and a bound are what keep this from becoming a global
  -- bottleneck. Written as a plain DELETE, two signups from different addresses
  -- would both try to remove the same stale rows: one blocks on the other, every
  -- signup in the club serialises behind whichever ran first, and rows locked in
  -- different scan orders can deadlock outright. Skipping a row another caller
  -- already holds costs nothing — it is being deleted either way — and the LIMIT
  -- stops a long-idle table from making one unlucky applicant pay to clean it.
  --
  -- Never the caller's own row, so the lock below always finds the row the
  -- insert above guaranteed.
  delete from public.signup_attempt_quota
   where client_key in (
     select q.client_key from public.signup_attempt_quota q
      where q.client_key <> v_key
        and coalesce(q.last_attempt_at, q.window_started_at) < now() - (v_window * 2)
      for update skip locked
      limit 100
   );

  insert into public.signup_attempt_quota (client_key)
  values (v_key)
  on conflict (client_key) do nothing;

  -- FOR UPDATE so two requests from one address queue rather than both reading
  -- the same count and both deciding they are under the cap.
  select * into v_row from public.signup_attempt_quota
   where client_key = v_key for update;

  v_started  := v_row.window_started_at;
  v_attempts := v_row.attempts_in_window;

  -- A window older than an hour is not a window any more.
  if v_started + v_window <= now() then
    v_started  := now();
    v_attempts := 0;
  end if;

  if v_attempts >= v_max then
    v_retry := ceil(extract(epoch from (v_started + v_window - now())))::int;
    return jsonb_build_object('ok', false, 'reason', 'rate_limited',
      'retry_after_seconds', greatest(v_retry, 1),
      'message', '가입 신청이 너무 많습니다. '
                 || greatest(ceil(v_retry / 60.0)::int, 1)
                 || '분 후에 다시 시도해주세요.');
  end if;

  -- Counted on the attempt, not on a success. A signup that fails on a taken
  -- nickname still cost a request, and nickname probing is precisely the thing
  -- an attacker would do with the successes thrown away.
  update public.signup_attempt_quota
     set window_started_at  = v_started,
         attempts_in_window = v_attempts + 1,
         last_attempt_at    = now()
   where client_key = v_key;

  -- lower(), matching emailForNickname() in the browser (auth/schema.ts) and the
  -- case-insensitive members_nickname_lower_uq. The nickname keeps the case the
  -- applicant typed; only the address is folded.
  v_email := lower(v_nickname) || '@eysl.local';

  begin
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data,
      -- These four are nullable with no default, and leaving them NULL is what
      -- makes GoTrue answer every later sign-in with 500 "Database error
      -- querying schema". See the header.
      confirmation_token, recovery_token, email_change_token_new, email_change
    ) values (
      '00000000-0000-0000-0000-000000000000',
      v_auth_id, 'authenticated', 'authenticated',
      v_email,
      -- Schema-qualified because this function pins search_path to public and
      -- pgcrypto lives in `extensions` on Supabase. Unqualified works in psql
      -- only because the default search_path happens to include it — which is
      -- why the bootstrap script got away with it and this cannot.
      extensions.crypt(p_password, extensions.gen_salt('bf')),
      -- Confirmed inline. There is no mail transport on this project and no real
      -- address behind the nickname, so an unconfirmed account could never sign
      -- in. This is the step that has no equivalent guarantee: nobody has proved
      -- the applicant owns anything, because there is nothing to own. Identity
      -- here is established by the admin who approves them, not by the address.
      now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      -- Read by the trigger, which takes `nickname` and nothing else from it.
      jsonb_build_object('nickname', v_nickname),
      '', '', '', ''
    );

    -- GoTrue resolves an email login through this table, not through auth.users
    -- alone. Without it sign-in fails even though the user exists.
    insert into auth.identities (
      provider_id, user_id, identity_data, provider,
      last_sign_in_at, created_at, updated_at
    ) values (
      v_auth_id::text, v_auth_id,
      jsonb_build_object('sub', v_auth_id::text, 'email', v_email,
                         'email_verified', true, 'phone_verified', false),
      'email', now(), now(), now()
    );
  exception
    -- Either arbiter: the address index on auth.users, or
    -- members_nickname_lower_uq re-raised by the trigger. Caught rather than
    -- allowed to propagate so the quota increment above survives — the block
    -- rolls back only the two inserts, and the function still returns normally.
    --
    -- Nothing else is caught. An unexpected error here means the auth schema is
    -- not the shape this function believes it is, and that must surface as a
    -- failure rather than as a polite Korean sentence.
    when unique_violation then
      return jsonb_build_object('ok', false, 'reason', 'nickname_taken',
        'message', '이미 사용 중인 닉네임입니다. 다른 닉네임을 입력해주세요.');
  end;

  -- Nothing about the created row is returned. The caller already knows the
  -- nickname it sent and derives the address the same way this function did; the
  -- member id is of no use to somebody who cannot yet reach a single screen.
  return jsonb_build_object('ok', true);
end $$;

comment on function public.register_member_v1(text, text) is
  '가입 신청. auth 계정과 pending members 행을 한 트랜잭션에서 만든다. 거절 사유는 예외가 아니라 반환값으로 알린다.';

-- ============================================================ 4. execute rights
--
-- After 0026 a new function arrives with no execute grant at all, so this grant
-- is what puts the RPC in an anonymous browser's reach — and it is the only
-- grant in this migration. `anon` is right and `authenticated` is not: somebody
-- already signed in has an account, and a second door into account creation for
-- a role that does not need one is a door to close, not to open.
revoke all on function public.register_member_v1(text, text) from public, anon, authenticated;
revoke all on function public.signup_client_key()            from public, anon, authenticated;

grant execute on function public.register_member_v1(text, text) to anon;
-- signup_client_key gets no grant: it is called only from inside
-- register_member_v1, which runs as its definer and therefore does not need the
-- caller to hold anything.
