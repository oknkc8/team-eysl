-- 0009 — member administration (approval, roles) and the storage buckets every
-- file-bearing screen has been reading from.
--
-- Three gaps, each checked against the dev database rather than assumed:
--
--   1. public.members carries exactly one policy — members_read (SELECT). There
--      is no write policy at all, by 0001's design, so approving a member and
--      changing a role are reachable only through SECURITY DEFINER functions.
--      Neither function existed, so both screens had nothing to call.
--   2. `select count(*) from storage.buckets` returned 0. The team-files bucket
--      that 0004 documents and notices/api.ts already signs URLs against was
--      never created, and storage.objects had no policy of any kind.
--   3. member_public_v is owned by postgres with no security_invoker, so it
--      bypasses members' RLS deliberately — that is what lets one member see
--      another's nickname. anon still held Supabase's default SELECT grant on
--      it, though, so the publishable key alone read the whole approved roster.
--      Confirmed in a rolled-back transaction: as anon, the view returned the
--      seeded row instead of refusing it.

-- ------------------------------------------------------------- roster exposure
-- The view stays RLS-bypassing on purpose; what it must not stay is readable
-- without a session. Same lesson as 0002: PUBLIC and anon are separate grants,
-- and revoking one says nothing about the other.
revoke all on public.member_public_v from anon;
grant select on public.member_public_v to authenticated;

-- --------------------------------------------------------------- approval RPC
-- Replaces the legacy manage-member-approval Edge Function, whose source lives
-- in the president's project and cannot be read from here.
create or replace function public.set_member_status_v1(p_member_id uuid, p_status text)
returns public.members
language plpgsql security definer set search_path = public
as $$
declare
  v_actor  uuid;
  v_target public.members;
  v_row    public.members;
begin
  if not public.is_staff() then
    raise exception 'only staff may decide membership' using errcode = '42501';
  end if;

  -- Only the two verdicts the approval queue offers. Blocking someone (the
  -- legacy 회원 내보내기) is a different decision with a different blast radius
  -- and does not belong on a function gated by is_staff().
  if p_status not in ('approved','rejected') then
    raise exception 'invalid status: %', p_status using errcode = '22023';
  end if;

  v_actor := public.current_member_id();

  select * into v_target from public.members where id = p_member_id for update;
  if not found then
    raise exception 'no such member' using errcode = '23503';
  end if;

  -- Two rows nobody decides about through this function: your own, and a master
  -- admin's. The second is what stops an admin from rejecting the one person who
  -- could undo it.
  if v_target.id = v_actor then
    raise exception 'cannot decide your own membership' using errcode = '42501';
  end if;
  if v_target.role = 'master_admin' then
    raise exception 'cannot change a master admin' using errcode = '42501';
  end if;

  update public.members
     set status = p_status, updated_at = now()
   where id = p_member_id
  returning * into v_row;

  return v_row;
end $$;

comment on function public.set_member_status_v1(uuid, text) is
  '가입 승인·거절. 총관리자 회원과 본인 계정은 대상이 될 수 없다.';

-- ------------------------------------------------------------------ roles RPC
-- The only real enforcement behind /members/roles. RequireMasterAdmin decides
-- what renders; is_master_admin() here decides what happens.
create or replace function public.set_member_role_v1(p_member_id uuid, p_role text)
returns public.members
language plpgsql security definer set search_path = public
as $$
declare
  v_target public.members;
  v_row    public.members;
begin
  if not public.is_master_admin() then
    raise exception 'only a master admin may change roles' using errcode = '42501';
  end if;

  -- 'master_admin' is deliberately not assignable. The legacy screen grants and
  -- revokes 부관리자 only, and a function that can mint a second master is a
  -- function that can be used to lock the first one out.
  if p_role not in ('member','admin') then
    raise exception 'invalid role: %', p_role using errcode = '22023';
  end if;

  select * into v_target from public.members where id = p_member_id for update;
  if not found then
    raise exception 'no such member' using errcode = '23503';
  end if;

  -- Refuses the caller's own row as a side effect, since only a master admin
  -- reaches this line — which is the point: no path here reduces the number of
  -- master admins.
  if v_target.role = 'master_admin' then
    raise exception 'cannot change a master admin' using errcode = '42501';
  end if;

  -- Operating rights on someone who is not yet a member would be a decision
  -- made in the wrong order; approve first.
  if v_target.status <> 'approved' then
    raise exception 'member is not approved' using errcode = '42501';
  end if;

  update public.members
     set role = p_role, updated_at = now()
   where id = p_member_id
  returning * into v_row;

  return v_row;
end $$;

comment on function public.set_member_role_v1(uuid, text) is
  '회원 등급 변경. 총관리자만 호출할 수 있고 총관리자 회원은 대상이 될 수 없다.';

-- ================================================================== storage
-- Both private. media_files and notice_attachments store a path, never a URL,
-- so every read is a short-lived signed URL rather than a public object.
insert into storage.buckets (id, name, public)
values ('team-files', 'team-files', false),
       ('profile-images', 'profile-images', false)
on conflict (id) do nothing;

-- `to authenticated` rather than an unqualified policy: current_member_id() is
-- not executable by anon (0002), so an anon request evaluating this predicate
-- would fail with "permission denied for function" instead of a clean refusal.
-- Naming the role means no policy applies to anon at all, which is the answer
-- we actually want.
drop policy if exists team_files_read on storage.objects;
create policy team_files_read on storage.objects
  for select to authenticated
  using (bucket_id = 'team-files' and public.current_member_id() is not null);

-- The first path segment is the uploader's member id, so this is the storage
-- half of media_files_insert (0004): the row and the object agree on who owns
-- the file, and neither can be written on somebody else's behalf.
drop policy if exists team_files_insert on storage.objects;
create policy team_files_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'team-files'
    and (storage.foldername(name))[1] = public.current_member_id()::text
  );

drop policy if exists team_files_update on storage.objects;
create policy team_files_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'team-files'
    and ((storage.foldername(name))[1] = public.current_member_id()::text or public.is_staff())
  )
  with check (
    bucket_id = 'team-files'
    and ((storage.foldername(name))[1] = public.current_member_id()::text or public.is_staff())
  );

drop policy if exists team_files_delete on storage.objects;
create policy team_files_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'team-files'
    and ((storage.foldername(name))[1] = public.current_member_id()::text or public.is_staff())
  );

-- Read only. members.avatar_path is set by an RPC that has not been rebuilt yet
-- (the legacy set_my_avatar_path), so nothing in this app writes here — a write
-- policy would be guessing at a feature that does not exist.
drop policy if exists profile_images_read on storage.objects;
create policy profile_images_read on storage.objects
  for select to authenticated
  using (bucket_id = 'profile-images' and public.current_member_id() is not null);

-- -------------------------------------------------------------- execute rights
-- Revoked from anon and authenticated by name, not just from PUBLIC: Supabase's
-- default privileges on new functions are separate grants, which is how 0002's
-- expire_stale_offers ended up anonymously callable.
revoke all on function public.set_member_status_v1(uuid, text) from public, anon, authenticated;
revoke all on function public.set_member_role_v1(uuid, text)   from public, anon, authenticated;

grant execute on function public.set_member_status_v1(uuid, text) to authenticated;
grant execute on function public.set_member_role_v1(uuid, text)   to authenticated;
