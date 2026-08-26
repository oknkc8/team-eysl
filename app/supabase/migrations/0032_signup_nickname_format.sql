-- 0032 — 가입 신청 must supply a nickname shaped 이름/출생년도/성별/지역.
--
--   창호/98/남/관악
--
-- The club identifies people by 닉네임 and nothing else — there is no email, and
-- 실명 is filled in later on 마이페이지 — so a bare given name is all an approving
-- admin sees in the queue. Two 창호 in a club of forty is not hypothetical, and
-- the admin has nothing to tell them apart with. The format carries enough to
-- disambiguate at the moment of approval, which is the only moment it is cheap.
--
-- ============================================================================
-- WHY THIS IS NOT A CHECK CONSTRAINT, A DOMAIN, OR A TRIGGER
-- ============================================================================
--
-- Because it would refuse the club. Measured against this project's database
-- on 2026-08-26, while writing this migration:
--
--   select count(*) as members,
--          count(*) filter (where nickname !~ '^[^/]+/[0-9]{2}/(남|여)/[^/]+$')
--     from public.members;
--
--    members | not_matching
--   ---------+--------------
--         41 |           37
--
-- Thirty-seven real people imported from the club's own spreadsheet, carrying
-- short given names of two or three syllables, whom this format would refuse.
-- (철수 / 영희 / 길동 below stand in for them — the Korean John Doe. This
-- repository is public and the club's actual nicknames do not belong in it.)
-- A CHECK would refuse every
-- one of those rows on the spot, and it does not stop at INSERT: a CHECK is
-- re-evaluated on every UPDATE, so the first admin to change somebody's 실명,
-- avatar, role or status would be refused by a rule about a column they did not
-- touch. The same is true of a domain and of a validating trigger.
--
-- THE FIGURE MOVES, AND THE WAY IT MOVED IS THE ARGUMENT. The same query read
-- 41 | 41 an hour earlier; four imported members were renamed into the format by
-- hand in between. That is an UPDATE against a pre-existing row — exactly the
-- statement a CHECK would have had to permit for the rename to be possible at
-- all, and exactly the statement it would have blocked for the other 37.
--
-- Those forty-one are not bad data to be migrated away. They are members who
-- joined before the rule existed, and renaming them is a decision for the club,
-- not a side effect of shipping a signup rule.
--
-- SO THE RULE LIVES ON THE SIGNUP PATH, which is the only place a *new* nickname
-- is chosen: register_member_v1() below, and src/features/auth/nickname.ts in
-- the browser. Everything that reads, displays, searches or updates an existing
-- nickname is untouched and keeps working on 영희 exactly as it did.
--
-- WHAT IS DELIBERATELY LEFT ALONE, and it is worth being explicit because it
-- looks like an omission:
--
--   * handle_new_auth_user() (0028:150) still checks only length. It fires for
--     ANY auth.users insert, and e2e/seed.sql:101 inserts its fixtures that way
--     with nicknames like `pwtestadmin`. Adding the format there would break
--     the Playwright fixtures and would also refuse an account created by hand
--     from the Supabase dashboard — a door the club may well need.
--   * The workbook importer writes members rows directly and never touches this
--     function, so the next import still lands 영희 without complaint.
--
-- ============================================================================
-- THE PATTERN IS SHARED WITH THE BROWSER, LITERALLY
-- ============================================================================
--
-- The string handed to `~` below is byte-for-byte NICKNAME_PATTERN_SOURCE in
-- src/features/auth/nickname.ts. nickname.test.ts reads THIS FILE off disk and
-- fails if the two ever stop matching, so a change to one and not the other is a
-- red test rather than a divergence found in production.
--
-- It is written to mean the same thing in both engines. `[^/]`, `{2}`, `(a|b)`,
-- `^` and `$` are interpreted identically by PostgreSQL's ARE and JavaScript's
-- u-mode RegExp. There is deliberately no `\s`, `\d` or `\w` in it — see the
-- forbidden-character check below, which is where the two engines genuinely
-- disagree and which is therefore asked separately in each one's own idiom.

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
  v_parts    text[];
  v_email    text;
  v_key      text;
  v_row      public.signup_attempt_quota;
  v_started  timestamptz;
  v_attempts int;
  v_retry    int;
  v_auth_id  uuid := gen_random_uuid();
begin
  v_nickname := btrim(coalesce(p_nickname, ''));

  -- The screen checks all of these too (signup.ts, nickname.ts). They are
  -- restated here because a direct RPC call never sees the screen, and "the
  -- client validates it" is not a rule, it is a hope. Validation runs before the
  -- quota so that somebody who mistypes their own password does not spend an
  -- attempt.
  if length(v_nickname) < 2 then
    return jsonb_build_object('ok', false, 'reason', 'nickname_short',
      'message', '닉네임은 2자 이상 입력해주세요.');
  end if;
  if length(v_nickname) > 30 then
    return jsonb_build_object('ok', false, 'reason', 'nickname_long',
      'message', '닉네임은 30자 이하로 입력해주세요.');
  end if;

  -- ------------------------------------------------------------- the format
  --
  -- Diagnosed part by part rather than answered with one boolean. A person who
  -- typed `창호/1998/남/관악` and is told only "형식이 올바르지 않습니다" has to
  -- guess which of four parts to change; being told the year wants two digits
  -- costs one extra branch here and saves them the guess. Every `reason` and
  -- every sentence below is mirrored exactly by checkNicknameFormat() in
  -- nickname.ts, in this order, and the tests pin them against each other.

  -- FORBIDDEN CHARACTERS ARE ASKED SEPARATELY FROM THE PATTERN, because a POSIX
  -- class cannot be shared: `[^/[:space:]]` means "not /, [, :, s, p, a, c, e,
  -- ]" to JavaScript. A pattern carrying one stops being a single string with a
  -- single meaning, so the class question is asked here in Postgres's idiom and
  -- in nickname.ts in JavaScript's, over one agreed set.
  --
  -- BOTH HALVES ARE LOAD-BEARING. `[:print:]` admits NBSP, and `[:space:]`
  -- misses every zero-width character, so neither test alone closes this.
  --
  -- AN ENUMERATION WAS TRIED HERE FIRST AND IT WAS WRONG. The earlier version
  -- listed the invisible characters it knew about — U+00AD, U+200B-200F,
  -- U+2060-2064, U+FEFF — alongside `[[:cntrl:]]`. It read as complete. Driven
  -- against the deployed function with a name chosen so that nothing else could
  -- refuse it, SIX characters still came back ok:true:
  --
  --   U+061C ALM    U+202A LRE    U+202E RTLO
  --   U+2066 LRI    U+2069 PDI    U+FFF9 IAA
  --
  -- The bidi controls and the isolates are category Cf, which [[:cntrl:]] does
  -- not cover, and they were simply missing from the hand-written range. U+202E
  -- is the worst: it reverses the display order of everything after it, so it
  -- does not merely hide, it rearranges. `[^[:print:]]` is the whole family at
  -- once instead of the members of it somebody remembered.
  --
  -- WHY THIS MATTERS AT ALL: `창호/98/남/관악<ZWSP>` renders identically to
  -- `창호/98/남/관악` and is a different string, which members_nickname_lower_uq
  -- is perfectly happy to hold alongside it. Two rows the roster shows as one
  -- person, with no way to tell which is which.
  --
  -- MEASURED, 32 codepoints, zero disagreements with the browser's `[\s\p{C}]`:
  -- both catch U+0001, NBSP, SHY, ALM, the figure and ideographic spaces,
  -- U+200B-200F, U+2028, U+202A-202E, U+2060, U+2066-2069, U+FEFF, U+FFF9-FFFB;
  -- both pass Hangul, Latin, digits, `/`, `€` and emoji. Emoji passing is
  -- deliberate — the rule is about characters that cannot be SEEN, not about
  -- narrowing the alphabet.
  --
  -- AND THE PART TO REMEMBER: the two sides already agreed once and were both
  -- wrong. A parity test between them passed on all six characters above.
  -- nickname.test.ts therefore pins an explicit codepoint list rather than
  -- asserting the implementations match each other.
  if v_nickname ~ '[[:space:]]' or v_nickname ~ '[^[:print:]]' then
    return jsonb_build_object('ok', false, 'reason', 'nickname_invisible',
      'message', '닉네임에는 공백이나 보이지 않는 문자를 넣을 수 없습니다. 예: 창호/98/남/관악');
  end if;

  v_parts := string_to_array(v_nickname, '/');

  -- Too many separators means a slash inside the name or the region, which is a
  -- different mistake from leaving a part out and deserves a different sentence.
  if array_length(v_parts, 1) > 4 then
    return jsonb_build_object('ok', false, 'reason', 'nickname_slashes',
      'message', '이름과 지역에는 /를 넣을 수 없습니다. 예: 창호/98/남/관악');
  end if;
  if array_length(v_parts, 1) < 4 then
    return jsonb_build_object('ok', false, 'reason', 'nickname_parts',
      'message', '닉네임은 이름/출생년도/성별/지역 형식으로 입력해주세요. 예: 창호/98/남/관악');
  end if;

  if v_parts[1] = '' then
    return jsonb_build_object('ok', false, 'reason', 'nickname_name',
      'message', '이름을 입력해주세요. 예: 창호/98/남/관악');
  end if;
  -- Names the year rather than saying "두 자리", because somebody born in 1998
  -- types 1998 and "two digits" does not tell them which two.
  if v_parts[2] !~ '^[0-9]{2}$' then
    return jsonb_build_object('ok', false, 'reason', 'nickname_year',
      'message', '출생년도는 뒤 두 자리만 입력해주세요. 1998년생이면 98입니다.');
  end if;
  if v_parts[3] <> '남' and v_parts[3] <> '여' then
    return jsonb_build_object('ok', false, 'reason', 'nickname_gender',
      'message', '성별은 남 또는 여로 입력해주세요. 예: 창호/98/남/관악');
  end if;
  if v_parts[4] = '' then
    return jsonb_build_object('ok', false, 'reason', 'nickname_region',
      'message', '지역을 입력해주세요. 예: 창호/98/남/관악');
  end if;

  -- THE SHARED PATTERN, and the reason the branches above are braces rather than
  -- the belt. Six hand-written conditions can drift apart from the one-line
  -- shape they are supposed to be diagnosing; this line cannot, because it *is*
  -- the shape, byte-identical to NICKNAME_PATTERN_SOURCE in nickname.ts. If the
  -- diagnosis above ever grows a hole, the nickname is still refused here.
  if v_nickname !~ '^[^/]+/[0-9]{2}/(남|여)/[^/]+$' then
    return jsonb_build_object('ok', false, 'reason', 'nickname_format',
      'message', '닉네임은 이름/출생년도/성별/지역 형식으로 입력해주세요. 예: 창호/98/남/관악');
  end if;

  -- ============================================================================
  -- THE GHOST ROW. This block is why the format rule is safe to ship.
  -- ============================================================================
  --
  -- WHAT THE FORMAT BREAKS IF THIS IS NOT HERE. 36 of the 41 members in this
  -- database have no login — they came from the club's spreadsheet, and they are
  -- exactly the people this signup form exists for. TODAY a returning member
  -- typing their own name is stopped dead by members_nickname_lower_uq:
  --
  --   register_member_v1('영희', …)             -> nickname_taken
  --
  -- Under the format their nickname is a DIFFERENT STRING, so nothing collides:
  --
  --   register_member_v1('영희/94/남/관악', …)  -> ok:true
  --
  -- That was reproduced against a real roster row, inside a transaction that was
  -- rolled back; 영희 stands in for that person here because this repository is
  -- public. What came back was two rows:
  --
  --   영희             approved  no login   <- attendance, records, birth year
  --   영희/94/남/관악  pending   has login  <- the account, and no history at all
  --
  -- Nothing raises. The member signs in, lands in the approval queue, is
  -- approved, and finds an empty app. Their attendance and records are still on
  -- a row nobody is attached to. The format would have converted a LOUD refusal
  -- into a SILENT duplicate, which is a strictly worse failure.
  --
  -- WHY THE MATCH IS RELIABLE, and this is the part that made a cheap fix
  -- possible. members already carries the columns the format encodes — the
  -- workbook import filled them in — so the nickname is a rendering of data the
  -- roster row already has. Measured:
  --
  --   short_name  40/41 populated      gender      40/41, values exactly 남 / 여
  --   birth_year  40/41 populated      location     0/41 populated
  --
  --   select count(*), count(distinct (lower(short_name), birth_year%100, gender))
  --     ->  40 | 40      ... zero collisions across the whole roster
  --
  -- So the first three segments are a unique key into the existing roster. The
  -- fourth is not: `location` is empty for every row, which is precisely why the
  -- match deliberately ignores 지역. It is the one thing the signup form adds
  -- that the spreadsheet never had.
  --
  -- `birth_year % 100` rather than a century guess. Two digits cannot say
  -- whether 98 is 1998 or 2098, and inventing a cutoff would be a rule nobody
  -- could see; the modulus asks the only question that has an answer.
  --
  -- WHY IT REFUSES INSTEAD OF LINKING. Linking the new login to the matched row
  -- would be an account takeover primitive: a name, a birth year and a gender
  -- are things a club-mate knows, and anyone holding them could seize somebody
  -- else's history by signing up. The safe operation is the one that creates
  -- nothing and asks a human — an admin already links these by hand.
  --
  -- WHAT IT COSTS. A genuinely new member who shares a name, birth year AND
  -- gender with somebody on the roster is refused and has to ask an admin. With
  -- 41 members and zero collisions today that is rare, and the failure is "talk
  -- to a person", not "lose eleven years of records".
  --
  -- ON THE INFORMATION IT GIVES AWAY: this tells an anonymous caller that a
  -- name/year/gender is on the roster. 0028's header already accepted exactly
  -- this trade for nickname_taken — a signup form cannot both refuse duplicates
  -- and keep the roster secret — and the rate limit above is the mitigation for
  -- both. It is a slightly richer answer than before, not a new kind of answer.
  --
  -- Not indexed on purpose: this is a sequential scan over a table that holds a
  -- swimming club, and an index maintained on three columns to serve one query
  -- per signup would cost more than it saves.
  if exists (
    select 1 from public.members m
     where lower(m.short_name) = lower(v_parts[1])
       and m.birth_year % 100  = v_parts[2]::int
       and m.gender            = v_parts[3]
  ) then
    return jsonb_build_object('ok', false, 'reason', 'existing_member',
      'message', '이미 클럽 명단에 있는 회원입니다. 새로 가입하지 마시고 관리자에게 계정 연결을 요청해주세요.');
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
  --
  -- THE ADDRESS NOW CONTAINS SLASHES — `창호/98/남/관악@eysl.local`. That is a
  -- legal local part under RFC 5322 (`/` is in atext), but legality was not the
  -- question; whether GoTrue would sign it in was. Verified against this project
  -- before the format was chosen: an account registered through this function
  -- with a slashed nickname signed in at /auth/v1/token?grant_type=password and
  -- came back HTTP 200 with a real access token. Nothing here had to change.
  v_email := lower(v_nickname) || '@eysl.local';

  begin
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data,
      -- These four are nullable with no default, and leaving them NULL is what
      -- makes GoTrue answer every later sign-in with 500 "Database error
      -- querying schema". See the header of 0028.
      confirmation_token, recovery_token, email_change_token_new, email_change
    ) values (
      '00000000-0000-0000-0000-000000000000',
      v_auth_id, 'authenticated', 'authenticated',
      v_email,
      -- Schema-qualified because this function pins search_path to public and
      -- pgcrypto lives in `extensions` on Supabase. Unqualified works in psql
      -- only because the default search_path happens to include it — which is
      -- why the bootstrap script got away with it and this cannot.
      --
      -- THE 10 IS NOT OPTIONAL AND NOT A DEFAULT. gen_salt('bf') alone is cost
      -- 6; 0029's header has the measurements and the reasoning. Anyone editing
      -- this line must carry the second argument with it.
      extensions.crypt(p_password, extensions.gen_salt('bf', 10)),
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
    -- THE SENTENCE CHANGED IN 0032 AND HAD TO. It used to read "다른 닉네임을
    -- 입력해주세요", which was good advice while a nickname was free text and is
    -- bad advice now: under a forced format the applicant has nothing to change.
    -- Their name, birth year and gender are facts, and the only field left to
    -- vary is 지역 — so the old sentence invited them to misstate where they
    -- live in order to get past a collision. Whoever is on the other side of
    -- this refusal is either the same person twice or a genuine namesake, and
    -- both of those are an admin's to sort out.
    when unique_violation then
      return jsonb_build_object('ok', false, 'reason', 'nickname_taken',
        'message', '이미 같은 닉네임으로 등록된 회원이 있습니다. 관리자에게 문의해주세요.');
  end;

  -- Nothing about the created row is returned. The caller already knows the
  -- nickname it sent and derives the address the same way this function did; the
  -- member id is of no use to somebody who cannot yet reach a single screen.
  return jsonb_build_object('ok', true);
end $$;

comment on function public.register_member_v1(text, text) is
  '가입 신청. auth 계정과 pending members 행을 한 트랜잭션에서 만든다. 닉네임은 이름/출생년도/성별/지역 형식이어야 하며, 거절 사유는 예외가 아니라 반환값으로 알린다.';

-- The grant is restated for the same reason 0029 restated it: `create or
-- replace` on an existing function keeps its ACL, but a fresh apply against a
-- database that somehow lacks 0028 would otherwise leave the RPC unreachable —
-- after 0026 an ungranted function is unreachable rather than public.
--
-- `anon` and only `anon`: somebody already signed in has an account, and a
-- second door into account creation for a role that does not need one is a door
-- to close, not to open.
revoke all on function public.register_member_v1(text, text) from public, anon, authenticated;
grant execute on function public.register_member_v1(text, text) to anon;
