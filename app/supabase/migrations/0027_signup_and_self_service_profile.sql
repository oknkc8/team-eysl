-- 0027 — let a person join the club, and let a member maintain their own
-- profile once they are in.
--
-- Until this migration there was no way to create a members row at all. 0001
-- gave the table no INSERT policy on purpose ("every mutation goes through a
-- SECURITY DEFINER function") and then 0009 built the functions for approving,
-- rejecting and role-changing an applicant — but nothing that produces the
-- applicant. The approval queue had been reading an empty table by
-- construction: `select count(*) from public.members` on the dev project
-- returned 0, and there is no path in the app or the schema that could have
-- made it anything else.
--
-- WHY A TRIGGER AND NOT AN RPC. The obvious shape is: the browser calls
-- auth.signUp(), gets a session, then calls register_member_v1(). It has a hole
-- that cannot be closed from the client side — the applicant closes the tab
-- between the two calls, and now an auth.users row exists with no members row
-- behind it. That account can sign in forever and RequireAuth will hold it on a
-- loading screen permanently (guards.tsx: `if (!user) return <Loading />`),
-- because `session` is truthy and `getMyMember()` keeps answering null. Nothing
-- in the app can repair it and no admin screen can even see it: the approval
-- queue reads members, and there is no row.
--
-- A trigger on auth.users runs inside GoTrue's own INSERT transaction, so the
-- auth user and the members row commit together or neither exists. A nickname
-- collision aborts the signup instead of leaving half an account behind.
--
-- WHAT THE CLIENT MAY DECIDE, AND WHAT IT MAY NOT. `raw_user_meta_data` is
-- whatever the browser put in `signUp({ options: { data } })` — it is request
-- data wearing a database column's clothes. The trigger reads exactly one key
-- out of it, `nickname`, and nothing else. status and role are not read, not
-- defaulted from it, not overridable through it: they are simply absent from
-- the INSERT below, so 0001's column defaults ('pending', 'member') are what
-- lands. A signup that posts {"status":"approved","role":"master_admin"} gets a
-- pending ordinary member, the same as everyone else.
--
-- WHAT THIS DOES NOT SOLVE, stated because the screen depends on it and the
-- schema cannot fix it: this project's GoTrue refuses `auth.signUp` for an
-- address at `eysl.local` with 400 "Email address ... is invalid" — it checks
-- deliverability on signup, and `.local` does not resolve. Sign-IN accepts the
-- same address, which is why the existing login screen works against rows
-- inserted by hand. So the trigger below is correct and inert until account
-- creation itself has a working path: either the project accepts the address
-- the app builds, or the president's `register-member` Edge Function is rebuilt
-- against the service-role key (admin.createUser skips that validation, which
-- is very likely why his app has one). Neither is reachable from this
-- repository — no service-role key and no management token exist here.

-- ------------------------------------------------------------------ signup

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_nickname text;
begin
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
  '가입 시 members 행을 pending 상태로 생성한다. status·role은 클라이언트가 보낸 메타데이터에서 읽지 않는다.';

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- Never callable from a browser: it is a trigger function and takes its input
-- from the row being inserted. After 0026 a new function arrives with no
-- execute grant at all, so this revoke is belt-and-braces rather than the load
-- bearing part — but it is the statement that says the omission is on purpose.
revoke all on function public.handle_new_auth_user() from public, anon, authenticated;

-- ------------------------------------------------------------------ 실명
-- Why this is not a plain UPDATE with an RLS policy: members has no write
-- policy of any kind (0001:171-175) and 0009 kept it that way deliberately.
-- Adding one for this column would open the table's write path for a single
-- field; a function keeps the rule "members is written only by functions"
-- intact.
--
-- Approved-only, via current_member_id(). A pending applicant cannot reach the
-- screen that calls this anyway — RequireAuth sends them to /pending — and
-- letting them write here would be a second, quieter way into the row.

create or replace function public.set_my_real_name_v1(p_real_name text)
returns public.members
language plpgsql security definer set search_path = public
as $$
declare
  v_member uuid;
  v_name   text;
  v_row    public.members;
begin
  v_member := public.current_member_id();
  if v_member is null then
    raise exception '승인된 회원만 실명을 저장할 수 있습니다' using errcode = '42501';
  end if;

  v_name := btrim(coalesce(p_real_name, ''));
  -- The legacy screen's own rule (upstream:3602). Two characters is the
  -- shortest real Korean name.
  if length(v_name) < 2 then
    raise exception '실명은 2자 이상 입력해주세요' using errcode = '22023';
  end if;
  if length(v_name) > 30 then
    raise exception '실명은 30자 이하로 입력해주세요' using errcode = '22023';
  end if;

  update public.members
     set real_name = v_name, updated_at = now()
   where id = v_member
  returning * into v_row;

  return v_row;
end $$;

comment on function public.set_my_real_name_v1(text) is
  '본인 실명 저장. 결과지 파서가 이 값으로 회원을 찾으므로 비어 있으면 기록이 매칭되지 않는다.';

-- ---------------------------------------------------------------- avatar
-- The shape half of the same idea as 0021's is_my_media_object_path: one
-- definition of a legal path, consulted by both the storage policy and the
-- function that records it, so the object and the row cannot disagree about
-- who owns the file.
--
-- Two segments, not three: the president's app writes
-- `${memberId}/avatar-${Date.now()}.${ext}` (upstream:3609), so an avatar has
-- no library segment. Anchoring both ends and forbidding a separator in the
-- file name is what stops `<me>/../../someone-else` and a bucket a member can
-- shape however they like.

create or replace function public.is_my_avatar_object_path(p_path text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select p_path is not null
     and public.current_member_id() is not null
     and p_path ~ ('^' || public.current_member_id()::text || '/[^/]+$')
$$;

comment on function public.is_my_avatar_object_path(text) is
  '경로가 <내 member id>/<파일명> 형태인지. profile-images 정책과 set_my_avatar_path_v1이 함께 쓴다.';

-- '' means 사진 삭제, the same wire convention as set_member_team_role_v1
-- (0011): plpgsql cannot declare a nullable parameter in a way the generated
-- Args type expresses, so the two spellings of empty arrive at one NULL here
-- and the column never stores ''. A stored '' would read as "has an avatar"
-- everywhere and resolve to no object anywhere.
create or replace function public.set_my_avatar_path_v1(p_avatar_path text)
returns public.members
language plpgsql security definer set search_path = public
as $$
declare
  v_member uuid;
  v_path   text;
  v_row    public.members;
begin
  v_member := public.current_member_id();
  if v_member is null then
    raise exception '승인된 회원만 프로필 사진을 변경할 수 있습니다' using errcode = '42501';
  end if;

  v_path := nullif(btrim(coalesce(p_avatar_path, '')), '');

  -- A non-empty path must be one this caller could have written. Without this
  -- check a member could point their avatar at another member's object and the
  -- roster would sign a URL for it.
  if v_path is not null and not public.is_my_avatar_object_path(v_path) then
    raise exception '프로필 사진 경로가 올바르지 않습니다' using errcode = '22023';
  end if;

  update public.members
     set avatar_path = v_path, updated_at = now()
   where id = v_member
  returning * into v_row;

  return v_row;
end $$;

comment on function public.set_my_avatar_path_v1(text) is
  '본인 프로필 사진 경로 저장. 빈 문자열이면 사진 삭제로 처리한다.';

-- -------------------------------------------------------- storage: avatars
-- 0009 created the profile-images bucket with a read policy only, and said why:
-- "members.avatar_path is set by an RPC that has not been rebuilt yet ... a
-- write policy would be guessing at a feature that does not exist". The RPC now
-- exists, so the three write policies stop being a guess.
--
-- Owner-only, with no staff bypass — the same call 0021 made for media, and for
-- the same reason: the president removed the admin bypass from his own media
-- helper deliberately, and an avatar is more personal than a folder, not less.

drop policy if exists profile_images_insert on storage.objects;
create policy profile_images_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'profile-images' and public.is_my_avatar_object_path(name));

-- Update as well as insert, because replacing a photo uploads to a fresh path
-- and the old object is removed afterwards (upstream:3609) — but an `upsert`
-- from a client that reuses a path is an UPDATE, and refusing it here would
-- fail a save that the insert policy already allows in every other respect.
drop policy if exists profile_images_update on storage.objects;
create policy profile_images_update on storage.objects
  for update to authenticated
  using (bucket_id = 'profile-images' and public.is_my_avatar_object_path(name))
  with check (bucket_id = 'profile-images' and public.is_my_avatar_object_path(name));

drop policy if exists profile_images_delete on storage.objects;
create policy profile_images_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'profile-images' and public.is_my_avatar_object_path(name));

-- -------------------------------------------------------------- execute rights
-- After 0026 a new function is unreachable until it is granted on purpose, so
-- these two lines are what put the two RPCs in the browser's reach — and the
-- revokes above are what keep the trigger function out of it.
revoke all on function public.set_my_real_name_v1(text)      from public, anon, authenticated;
revoke all on function public.set_my_avatar_path_v1(text)    from public, anon, authenticated;
revoke all on function public.is_my_avatar_object_path(text) from public, anon, authenticated;

grant execute on function public.set_my_real_name_v1(text)   to authenticated;
grant execute on function public.set_my_avatar_path_v1(text) to authenticated;
-- Granted because the two storage policies above evaluate it as the calling
-- role, exactly as 0021 grants is_my_media_object_path for team_files_*.
grant execute on function public.is_my_avatar_object_path(text) to authenticated;
