-- 0029 — three authority gaps an adversarial review of 0027/0028 found.
--
-- Each is independent of the others; they share a migration because they share a
-- review and shipping three files would only make the ledger longer.
--
--   1. signup hashed passwords at bcrypt cost 6, not GoTrue's 10.
--   2. any approved member could read any object in team-files, including an
--      attachment belonging to a DM they are not in.
--   3. the avatar bucket enforced neither a type nor a size, so the browser's
--      5MB image check was the only check there was.

-- ================================================ 1. the signup hash cost
--
-- 0028 wrote `gen_salt('bf')` with no second argument. THAT IS COST 6, and the
-- omission does not read as one — `bf` names the algorithm and looks complete.
-- Measured on this project rather than assumed:
--
--   gen_salt('bf')      -> $2a$06$
--   gen_salt('bf', 10)  -> $2a$10$
--
-- GoTrue writes cost 10. So every account created through our signup screen was
-- hashed sixteen times more cheaply than the same account created through
-- Supabase, and the two kinds sit in one auth.users table where an attacker who
-- ever obtained it would simply start with the cheap ones.
--
-- WHY 10 AND NOT MORE. Cost is a doubling ladder, timed on this database:
--
--   6 -> 4.7ms   8 -> 18.3ms   10 -> 72.9ms   12 -> 292.1ms
--
-- register_member_v1 is callable by `anon`, so its runtime is also a
-- denial-of-service surface: at cost 12 the rate limiter's 60 attempts an hour
-- buy an attacker 17.5 seconds of database CPU instead of 4.4. And raising ours
-- above 10 would buy nothing anyway while GoTrue keeps writing 10 for every
-- account made any other way — the table's strength is its weakest row, and a
-- mixed-cost table is defended at the lower number. Matching GoTrue exactly
-- means there is one answer to "how strong is a password in this system"
-- instead of two, and it is the answer Supabase itself keeps up to date.
--
-- EXISTING ROWS KEEP THEIR COST-6 HASH. Changing the salt function rehashes
-- nothing, and bcrypt is one-way, so no migration can fix a row already written.
-- The usual remedy — rehash on next successful login — IS NOT AVAILABLE TO US:
-- GoTrue verifies the password inside its own API tier and this database never
-- sees the plaintext at sign-in time, so there is no hook to rehash from. The
-- only real remedy is for the affected account to set a new password.
--
-- Measured before writing this: `select count(*) from auth.users` is 1, and that
-- one row is at $2a$06$. It is a live administrator account belonging to a
-- person, not a fixture, so it is deliberately left alone here and reported
-- instead. Every account created from this migration onward is at cost 10.
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
      --
      -- THE 10 IS NOT OPTIONAL AND NOT A DEFAULT. gen_salt('bf') alone is cost
      -- 6; the header has the measurements and the reasoning. Anyone editing
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

-- The grant is restated because `create or replace` on a function that already
-- exists keeps its ACL, but a fresh apply of this file against a database that
-- somehow lacks 0028 would otherwise leave the RPC unreachable — and after 0026
-- an ungranted function is unreachable rather than public. Cheap to restate,
-- expensive to discover missing.
revoke all on function public.register_member_v1(text, text) from public, anon, authenticated;
grant execute on function public.register_member_v1(text, text) to anon;

-- ====================================== 2. who may read a team-files object
--
-- team_files_read (0009:143) was `bucket_id = 'team-files' and
-- current_member_id() is not null`: ANY approved member, ANY object. The row
-- rules underneath it are not that: messages_read (0005:13) confines a DM to its
-- two participants. RLS on the row does not reach the object, so a caller who
-- learned or guessed a path could mint a signed URL for it through
-- createSignedUrl (chat/api.ts:188), which takes a path and asks nothing else.
--
-- HOW BAD IS IT TODAY. Measured before writing this: `select count(*) from
-- storage.objects where bucket_id = 'team-files'` is 0, and `select count(*)
-- from public.messages where attachment_path is not null` is 0. So nothing is
-- exposed right now — the composer is text-only and team_files_insert (0021)
-- refuses any object a media_files row has not already claimed, which is why no
-- chat or notice attachment can exist yet. The hole is latent, and the moment
-- somebody builds the chat uploader it stops being latent silently.
--
-- THE FIX asks the object question the way the row question is asked. 0021 set
-- the pattern: one helper, named by both the table policy and the storage
-- policy, so the two cannot drift. This follows it with one deliberate
-- difference, spelled out because it is a real divergence and not an oversight.
--
-- 0021's media_object_is_claimed is SECURITY DEFINER, and said why: a policy on
-- storage.objects "has no business depending on whether media_files_read happens
-- to be readable by whoever is asking". That is right for media, where the
-- question is whether a row exists at all. It is exactly wrong here, where the
-- question is whether THIS CALLER may see the row. So the helper below is
-- SECURITY INVOKER, and every arm of it is filtered by that table's own SELECT
-- policy. Drift becomes impossible rather than merely discouraged: tighten
-- messages_read tomorrow and the bucket follows the same afternoon, with nothing
-- to remember and no second copy of the predicate to forget.
--
-- Three tables claim paths in this bucket, and each keeps its own answer:
--   media_files.storage_path        — media_files_read is club-wide, by design.
--   notice_attachments.storage_path — notice_attachments_read is club-wide too.
--   messages.attachment_path        — group is club-wide; a DM is its two people.
--
-- An object no row claims is now unreadable by anybody. That is the point, not a
-- side effect: it is precisely the state a leaked or guessed path exploits, and
-- team_files_insert already refuses to create one.
create or replace function public.team_file_is_readable(p_path text)
returns boolean
language sql stable security invoker set search_path = public
as $$
  select p_path is not null
     and (
       exists (select 1 from public.media_files
                where storage_path = p_path)
       or exists (select 1 from public.notice_attachments
                   where storage_path = p_path)
       or exists (select 1 from public.messages
                   where attachment_path = p_path)
     )
$$;

comment on function public.team_file_is_readable(text) is
  '이 호출자가 해당 경로를 가리키는 행을 볼 수 있는지. SECURITY INVOKER라서 각 테이블의 RLS가 그대로 답한다.';

-- The helper turns every object read into three lookups by path, and two of
-- those columns had no index. media_files.storage_path already has a unique one
-- (0021); these are the other two.
--
-- WITHOUT THEM THIS MIGRATION WOULD BE A PERFORMANCE REGRESSION rather than only
-- a security fix: opening a media folder signs one URL per file, so a fifty-photo
-- folder would mean fifty sequential scans of `messages` — a table that grows
-- with every chat line the club ever sends.
--
-- Partial, because an attachment is the rare case and a NULL carries no
-- information worth storing: the index holds only rows that could ever match.
create index if not exists messages_attachment_path_idx
  on public.messages (attachment_path)
  where attachment_path is not null;

create index if not exists notice_attachments_storage_path_idx
  on public.notice_attachments (storage_path);

-- current_member_id() stays in the policy rather than moving into the helper.
-- It is the cheap test and it short-circuits: a caller who is not an approved
-- member is refused without touching three tables. It also keeps the helper
-- about one thing — whether a row claims this path and admits this reader.
drop policy if exists team_files_read on storage.objects;
create policy team_files_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'team-files'
    and public.current_member_id() is not null
    and public.team_file_is_readable(name)
  );

-- Named inside a policy expression, so it is evaluated as whoever is asking and
-- `authenticated` needs EXECUTE for the policy to be evaluable at all — the same
-- reason 0021 grants is_my_media_object_path and 0027 grants
-- is_my_avatar_object_path. `anon` is left out: the policy names `authenticated`
-- and no anonymous caller ever reaches it.
revoke all on function public.team_file_is_readable(text) from public, anon, authenticated;
grant execute on function public.team_file_is_readable(text) to authenticated;

-- ------------------------------ and the row that claims a path must be honest
--
-- The policy above is only as good as the claims it trusts, and the claim tables
-- would take any claim at all. send_message_v1 (0012:27) accepts
-- p_attachment_path as a free string and stores it — so any approved member
-- could send a message naming somebody ELSE'S object path, thereby become the
-- sender of a row they are entitled to read, and satisfy team_file_is_readable
-- through their own forged claim.
--
-- MEASURED on this database, with the policy above already in place, as member C
-- who is not in A's DM:
--
--   select public.send_message_v1('group', '...', null,
--            '<A-member-id>/media/<A''s attachment>', 'application/octet-stream');
--   -> returns a row id, accepted
--
--   select count(*) from storage.objects
--    where bucket_id = 'team-files' and name = '<A-member-id>/media/<...>';
--   -> 1     (it answered 0 for the same caller one statement earlier)
--
-- So the storage policy alone was one RPC call away from being no fix at all.
--
-- 0021 had already learned this on the media side and wrote it down: media_files
-- rows must satisfy is_my_media_object_path, because "without this check a member
-- could file a row pointing at another member's object and re-publish their file
-- under their own name". The chat and notice tables never got the same rule
-- because neither has an uploader yet — the rule was missing exactly where
-- nobody had had to think about it.
--
-- THE RULE IS OWNERSHIP OF THE FIRST SEGMENT, AND DELIBERATELY NO MORE. Every
-- other writer to this bucket already holds that invariant — team_files_insert
-- through is_my_media_object_path, profile_images_insert through
-- is_my_avatar_object_path — and the member id is the part all of them agree on.
-- What comes AFTER it is left open on purpose: chat has no uploader, so fixing a
-- directory name here would be designing a feature nobody has specified. 0021's
-- team_files_insert still refuses anything outside (media|resources), which is
-- its own documented decision to revisit when that uploader is built.
create or replace function public.is_my_team_file_path(p_path text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select p_path is not null
     and public.current_member_id() is not null
     -- Anchored, and requiring a non-slash character after the separator, so
     -- neither `<someone-else>/...` nor a bare `<me>/` satisfies it. A member id
     -- is a uuid, so it carries nothing the regex would treat specially.
     and p_path ~ ('^' || public.current_member_id()::text || '/[^/]')
$$;

comment on function public.is_my_team_file_path(text) is
  '경로가 내 member id 아래에 있는지. 남의 파일을 자기 것이라고 주장하는 행을 막는다.';

-- Named inside notice_attachments_write below, which is evaluated as the caller.
revoke all on function public.is_my_team_file_path(text) from public, anon, authenticated;
grant execute on function public.is_my_team_file_path(text) to authenticated;

-- send_message_v1, unchanged except for the one guard. Restated in full rather
-- than patched, because a function is replaced whole and a reader deserves to
-- see what they are getting.
create or replace function public.send_message_v1(
  p_room_type       text,
  p_body            text default null,
  p_recipient_id    uuid default null,
  p_attachment_path text default null,
  p_attachment_type text default null
)
returns public.messages
language plpgsql security definer set search_path = public
as $$
declare
  v_sender     uuid;
  v_body       text;
  v_attachment text;
  v_row        public.messages;
begin
  v_sender := public.current_member_id();
  if v_sender is null then
    raise exception 'not an approved member' using errcode = '42501';
  end if;

  if p_room_type is null or p_room_type not in ('group', 'dm') then
    raise exception 'invalid room_type: %', coalesce(p_room_type, '(null)') using errcode = '22023';
  end if;

  -- recipient_matches_room_type (0004:146-147) already says this, but a CHECK
  -- violation surfaces as 23514 naming a constraint. Raising first turns the
  -- same rule into a sentence a screen can show without translating pgcodes.
  if p_room_type = 'dm' and p_recipient_id is null then
    raise exception 'a direct message needs a recipient' using errcode = '22023';
  end if;
  if p_room_type = 'group' and p_recipient_id is not null then
    raise exception 'a group message cannot have a recipient' using errcode = '22023';
  end if;

  if p_room_type = 'dm' then
    if p_recipient_id = v_sender then
      raise exception 'cannot send a direct message to yourself' using errcode = '22023';
    end if;
    -- Approved, not merely present. current_member_id() stops answering for a
    -- blocked member (0001:123-129), so a DM addressed to one would be a row
    -- only the sender could ever read.
    if not exists (
      select 1 from public.members
       where id = p_recipient_id and status = 'approved'
    ) then
      raise exception 'no such approved member' using errcode = '23503';
    end if;
  end if;

  -- Trim before the emptiness test, not after. body_or_attachment (0004:148-149)
  -- compares against '' and a body of three spaces satisfies it — a message that
  -- passes the constraint and renders as an empty bubble.
  v_body       := nullif(btrim(coalesce(p_body, '')), '');
  v_attachment := nullif(btrim(coalesce(p_attachment_path, '')), '');

  if v_body is null and v_attachment is null then
    raise exception 'a message needs text or an attachment' using errcode = '22023';
  end if;

  -- THE NEW GUARD. An attachment must be a file this sender could have uploaded.
  -- Without it, naming a path is enough to gain read access to it — see the
  -- measurement above is_my_team_file_path.
  --
  -- 42501 rather than 22023: this is not a malformed argument, it is a refusal of
  -- authority, and it should read like one in a log.
  if v_attachment is not null and not public.is_my_team_file_path(v_attachment) then
    raise exception 'an attachment must be a file you uploaded' using errcode = '42501';
  end if;

  -- The column is unbounded text. Nothing in the app can send more than a
  -- composer holds, but nothing in the app is what a hostile client uses.
  if length(v_body) > 4000 then
    raise exception 'message is too long (max 4000 characters)' using errcode = '22001';
  end if;

  insert into public.messages (
    room_type, sender_id, recipient_id, body, attachment_path, attachment_type
  ) values (
    p_room_type,
    v_sender,
    case when p_room_type = 'dm' then p_recipient_id end,
    v_body,
    v_attachment,
    -- A type without a path describes nothing, so it is dropped rather than
    -- stored beside a null attachment.
    case when v_attachment is null then null
         else nullif(btrim(coalesce(p_attachment_type, '')), '') end
  )
  returning * into v_row;

  return v_row;
end $$;

comment on function public.send_message_v1(text, text, uuid, text, text) is
  '메시지 보내기. 보낸 사람은 세션에서 읽고, 첨부 경로는 본인이 올린 파일만 허용한다.';

-- 0013 stripped this down to `authenticated` alone; restated so a replace cannot
-- quietly widen it.
revoke all on function public.send_message_v1(text, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.send_message_v1(text, text, uuid, text, text)
  to authenticated;

-- The same forgery, one table over, and worth closing for a sharper reason.
-- notice_attachments_write is `for all using (is_staff())` with no WITH CHECK, so
-- a staff member could file an attachment row pointing at a member's DM object
-- and then read it through notice_attachments_read, which is club-wide.
-- messages_read has NO staff arm — the president's design says 운영진 do not get
-- to read other people's direct messages — and this was a way around that rule
-- rather than an exception to it.
--
-- USING keeps `is_staff()` alone: a staffer must still be able to delete a row
-- whose path predates this rule, for the same reason 0021 kept a broader arm on
-- team_files_delete. It is WITH CHECK, the write half, that gains the test.
drop policy if exists notice_attachments_write on public.notice_attachments;
create policy notice_attachments_write on public.notice_attachments
  for all
  using (public.is_staff())
  with check (public.is_staff() and public.is_my_team_file_path(storage_path));

-- =============================== 3. what the avatar bucket will actually hold
--
-- profile/api.ts:40 checks the MIME type and a 5MB ceiling, and 0027's storage
-- policies check the path prefix and nothing else. So the size limit lived only
-- in the browser: an approved member calling the storage API directly could put
-- a gigabyte of anything under their own prefix, repeatedly, and every check
-- that was supposed to stop them ran on the machine they control.
--
-- storage.buckets carries both limits and enforces them in the storage service,
-- which is where a limit belongs — in front of the bytes rather than behind
-- them. Setting them costs one UPDATE and no policy.
--
-- HONEST ABOUT WHAT EACH ONE IS WORTH. file_size_limit is a real control: the
-- service counts the bytes it receives. allowed_mime_types is a weaker one — it
-- tests the Content-Type the client declares, and a hostile client declares
-- whatever it likes. It is worth setting anyway because it turns the ordinary
-- accident (someone picks a PDF) into a clean refusal, but it is not what stops
-- a determined uploader; the size limit and the path policy are.
update storage.buckets
   set file_size_limit    = 5242880,  -- 5MB, matching MAX_AVATAR_BYTES exactly.
       -- Enumerated rather than a wildcard, because Supabase matches these
       -- literally and `image/*` would refuse everything. The list is the browser
       -- allowlist in profile/api.ts, and the two are meant to be read together:
       -- a type in one and not the other is a member told "yes" by the screen and
       -- "no" by the bucket.
       allowed_mime_types = array['image/jpeg','image/png','image/webp','image/gif']
 where id = 'profile-images';

-- team-files is deliberately NOT given a MIME allowlist. 자료실 exists to hold
-- whatever the club needs to share — a PDF entry form, an xlsx of results, a hwp
-- — so enumerating types there would be inventing a policy nobody asked for and
-- breaking the feature to do it. Its size is already bounded by the project-wide
-- upload limit, and no per-bucket number here would be anything but a guess.
--
-- NO PER-MEMBER OBJECT CAP, either, and this is a decision rather than an
-- omission. Counting a member's objects inside a policy is both expensive and
-- racy — two uploads read the same count and both pass. Worse, it would break
-- the legitimate case: avatarObjectPath() timestamps every save, so replacing a
-- photo writes a NEW object and deletes the old one afterwards on a best-effort
-- basis (profile/api.ts:164). A cap plus one failed cleanup is a member who can
-- never change their photo again. The real bound is the project storage quota,
-- and the club is around forty people.
