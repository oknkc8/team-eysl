-- 0011 — the two member-administration gaps 0009 and 0010 left open, plus a
-- note on the third thing this slice needed and did not have to add.
--
-- Each checked against the dev database before writing rather than assumed:
--
--   1. can_manage_records() (0004:159-169) grants 결과지 업로드 to
--      `role in ('admin','master_admin') or team_role = '코치'`, and nothing
--      anywhere could set team_role. `select proname from pg_proc where proname
--      like 'set\_member%'` returned exactly two rows — set_member_status_v1 and
--      set_member_role_v1, both of which write other columns. So the 코치 branch
--      of can_manage_records() has been dead since 0004: a coach who is not also
--      an admin could not be appointed at all, in this app or by any RPC it can
--      call.
--   2. set_member_status_v1 accepts only 'approved'/'rejected', and since 0010
--      only against a row that is still 'pending'. members.status permits
--      'blocked' (0001:31-32) and current_member_id() returns null for such a
--      row, which is what actually ends somebody's access — but no path in this
--      app can set it. Blocking is a different decision from deciding a pending
--      application, so it gets its own function rather than a widened p_status.
--   3. Nothing new was needed for 미디어 이름 변경·삭제 or 자료실, and this
--      migration deliberately adds nothing for them. Checked live:
--      media_folders_update/delete and media_files_update/delete already read
--      owner-or-staff (0004:232-252), and `authenticated` already holds UPDATE
--      and DELETE on both tables, so RLS is the only gate and it is already the
--      one we want. media_files.folder_id is nullable on purpose (0004:109-110)
--      and a null there *is* a 자료실 file, so the resource library needs no
--      column, table or policy of its own.

-- ---------------------------------------------------------------- team_role
-- members.team_role is free text with no constraint, and one of its values is
-- load-bearing: can_manage_records() compares it against the literal '코치'.
-- A master admin typing '코 치' or '코치 ' would silently strip somebody's
-- upload rights with no error anywhere, so the set of writable values is fixed
-- here rather than left to whatever a text field receives.
--
-- The allow-list governs writes only. A row already carrying some other value
-- keeps it — this function never rewrites a column it was not asked to set, and
-- there is deliberately no CHECK on the column itself, because we cannot read
-- the president's production data and a constraint that rejects his existing
-- rows would fail the cutover rather than the typo.
create or replace function public.set_member_team_role_v1(
  p_member_id uuid,
  p_team_role text
)
returns public.members
language plpgsql security definer set search_path = public
as $$
declare
  v_value  text;
  v_target public.members;
  v_row    public.members;
begin
  if not public.is_master_admin() then
    raise exception 'only a master admin may change a team role'
      using errcode = '42501';
  end if;

  -- Empty and whitespace-only both mean 지정 안 함. Storing '' would leave a
  -- value that reads as set everywhere and matches nothing.
  v_value := nullif(btrim(coalesce(p_team_role, '')), '');

  -- '부관리자' is accepted because it exists in the legacy data (index.html:3720
  -- compares against it), not because it does anything: only '코치' is read by
  -- can_manage_records(). Widening this list is the president's call, since the
  -- vocabulary is his club's.
  if v_value is not null and v_value not in ('코치', '부관리자') then
    raise exception 'invalid team role: %', p_team_role using errcode = '22023';
  end if;

  select * into v_target from public.members where id = p_member_id for update;
  if not found then
    raise exception 'no such member' using errcode = '23503';
  end if;

  -- A team role carries operating rights through can_manage_records(), so it is
  -- decided in the order set_member_role_v1 decides a role in: approve first,
  -- then grant.
  if v_target.status <> 'approved' then
    raise exception 'member is not approved' using errcode = '42501';
  end if;

  update public.members
     set team_role = v_value, updated_at = now()
   where id = p_member_id
  returning * into v_row;

  return v_row;
end $$;

comment on function public.set_member_team_role_v1(uuid, text) is
  '팀 역할(코치 등) 지정·해제. 총관리자만 호출할 수 있고 승인된 회원만 대상이 된다.';

-- -------------------------------------------------------------------- block
-- The legacy 회원 내보내기. Reversible on purpose and in both directions through
-- one function, so restoring somebody is the same decision made the other way
-- round rather than a second, differently-gated path.
--
-- Note what this does NOT do: it deletes nothing. The member's row, records,
-- attendance and applications all stay exactly where they are; only
-- current_member_id() stops answering for them, which is what closes the app.
create or replace function public.set_member_blocked_v1(
  p_member_id uuid,
  p_blocked   boolean
)
returns public.members
language plpgsql security definer set search_path = public
as $$
declare
  v_actor  uuid;
  v_target public.members;
  v_row    public.members;
begin
  -- Matches the legacy gate: 가입 승인·회원 내보내기·권한 지정/해제는 총관리자만
  -- (index.html:1127). members has no write policy at all, so this check is the
  -- whole of the enforcement — there is no RLS behind it to catch a mistake.
  if not public.is_master_admin() then
    raise exception 'only a master admin may block or restore a member'
      using errcode = '42501';
  end if;
  if p_blocked is null then
    raise exception 'p_blocked is required' using errcode = '22023';
  end if;

  v_actor := public.current_member_id();

  select * into v_target from public.members where id = p_member_id for update;
  if not found then
    raise exception 'no such member' using errcode = '23503';
  end if;

  -- The same two rows set_member_status_v1 refused in 0009, for the same
  -- reasons: blocking yourself locks the club out of its own administration,
  -- and blocking a master admin lets one admin end the other's access.
  if v_target.id = v_actor then
    raise exception 'cannot block yourself' using errcode = '42501';
  end if;
  if v_target.role = 'master_admin' then
    raise exception 'cannot change a master admin' using errcode = '42501';
  end if;

  -- Only the two transitions this function is for. A pending or rejected
  -- application is not blocked, it is undecided or refused, and routing it
  -- through here would put it past the approval queue rather than through it.
  if p_blocked and v_target.status <> 'approved' then
    raise exception 'only an approved member can be blocked' using errcode = '42501';
  end if;
  if not p_blocked and v_target.status <> 'blocked' then
    raise exception 'member is not blocked' using errcode = '42501';
  end if;

  update public.members
     set status = case when p_blocked then 'blocked' else 'approved' end,
         updated_at = now()
   where id = p_member_id
  returning * into v_row;

  return v_row;
end $$;

comment on function public.set_member_blocked_v1(uuid, boolean) is
  '회원 내보내기·복구. 총관리자만 호출할 수 있으며 되돌릴 수 있고 데이터는 지우지 않는다.';

-- -------------------------------------------------------------- execute rights
-- Revoked from anon and authenticated by name, not merely from PUBLIC.
-- Supabase's default privileges on a new function are separate grants from
-- PUBLIC's, which is how 0002's expire_stale_offers ended up anonymously
-- callable and how anon kept SELECT on two views. The live ACL is queried back
-- after this migration applies; reading correctly here is not evidence.
revoke all on function public.set_member_team_role_v1(uuid, text)  from public, anon, authenticated;
revoke all on function public.set_member_blocked_v1(uuid, boolean) from public, anon, authenticated;

grant execute on function public.set_member_team_role_v1(uuid, text)  to authenticated;
grant execute on function public.set_member_blocked_v1(uuid, boolean) to authenticated;
