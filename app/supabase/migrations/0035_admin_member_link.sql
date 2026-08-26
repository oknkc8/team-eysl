-- 0035 — 회원 연결: an admin moves a new login onto the roster row it belongs to.
--
-- ============================================================================
-- THE SITUATION THIS EXISTS FOR
-- ============================================================================
--
-- Measured against this project's database while writing this migration:
--
--    members | no_login
--   ---------+----------
--         41 |       36
--
-- Thirty-six people who are members in every sense the club means it — years of
-- attendance, their records, their join date — and who have no way in. Their
-- rows came from the club's spreadsheet; nobody ever had an account.
--
-- 0032's roster guard is what stands between them and the app, and it is
-- correct. It recognises them by (short_name, birth_year % 100, gender) — the
-- three fields the nickname format encodes — and REFUSES, because attaching a
-- fresh login to a matched row automatically would be an account takeover
-- primitive: a name, a birth year and a gender are things a club-mate knows.
-- That guard stays exactly as it is. What was missing is the other half: the
-- human it tells them to go and ask had no screen to say yes on.
--
-- ============================================================================
-- TWO DOORS, AND WHY THEY ARE SEPARATE DECISIONS
-- ============================================================================
--
-- 가입 허용 (set_signup_pass_v1) lets ONE refused applicant through the roster
-- guard as a BRAND NEW pending row. It confers nothing else. It does not touch
-- the roster row, does not move a login, and does not approve anybody.
--
-- 회원 연결 (link_member_login_v1) is that second decision, and it is the one
-- that moves years of history onto a login.
--
-- SPLITTING THEM IS THE WHOLE DESIGN. The alternative — a pass that attaches the
-- new account to the matched roster row directly — was considered and rejected,
-- because it rebuilds the primitive 0032 refused to build. It would open a
-- window during which anyone who knows the triple could race the real member to
-- that row, and the admin who opened the window would not be watching when it
-- was used. Here the admin is looking at the applicant AT THE MOMENT THE HISTORY
-- MOVES, not days earlier. A stranger who rides somebody's pass gets a pending
-- row with no history attached and an admin who does not recognise them.
--
-- That is also the answer to the namesake — a genuinely new member who shares a
-- name, birth year and gender with somebody on the roster, refused through no
-- fault of their own. They get a pass, they sign up, they are approved through
-- the normal queue, and nobody links anything.
--
-- NOTE FOR WHOEVER FINISHES THIS. The pass column and its RPC are here, but
-- register_member_v1 is NOT modified by this migration, so nothing consumes the
-- pass yet and the guard still refuses all 36. Making it live means editing the
-- `if exists (...)` block at 0032:430-444 IN PLACE — read it out of 0032 and
-- change only that block — so a matched row carrying a live
-- signup_pass_expires_at falls through instead of returning already_registered,
-- and the pass is cleared AFTER the auth insert succeeds (not before: the
-- unique_violation arm returns normally, so consuming early would burn a pass on
-- a fumbled duplicate nickname). Do not touch updated_at while clearing it —
-- getApprovalQueue orders 최근 처리한 회원 by updated_at, and a consumed pass is
-- not a change to that member's standing.
--
-- ============================================================================
-- WHO MAY DO IT: master_admin, not is_staff()
-- ============================================================================
--
-- The ladder this repository already built, read off the functions:
--
--   set_member_status_v1    (0009:30)   is_staff()          가입 승인·거절
--   set_member_role_v1      (0009:81)   is_master_admin()   권한 지정
--   set_member_team_role_v1 (0011:41)   is_master_admin()   팀 역할
--   set_member_blocked_v1   (0011:101)  is_master_admin()   회원 내보내기
--
-- is_staff() covers exactly one thing: the routine verdict on a queue entry,
-- which creates no authority and destroys no data. Everything that changes what
-- an account IS is master_admin, and 0011 quotes the legacy app's own rule for
-- it (index.html:1127).
--
-- Moving auth_user_id between rows is strictly more dangerous than any of them.
-- A mistake does not remove somebody's access — it hands one person another
-- person's identity, attendance and records, with no undo.
--
-- ============================================================================
-- WHAT HAPPENS TO THE DISCARDED ROW
-- ============================================================================
--
-- It is deleted, and the reason that is safe is a property of the schema rather
-- than a promise: a `pending` member can write NOTHING. Every RLS policy and
-- self-service RPC routes through current_member_id() (0001:123-129), which
-- answers only for status = 'approved'.
--
-- BUT IT IS PROVED RATHER THAN ASSUMED, because the failure mode is silent and
-- permanent. records.member_id (0004:67), activity_applications.member_id
-- (0001:74), attendance.member_id (0001:104) and push_subscriptions.member_id
-- (0004:125) are all ON DELETE CASCADE — a wrong delete would not raise, it
-- would take the rows with it and say nothing.
--
-- So the check below reads pg_constraint and walks EVERY foreign key that
-- references public.members. Not a hand-written list of the fifteen that exist
-- today: a table added next month is covered automatically.
--
-- ============================================================================
-- WHY THE NICKNAME MOVES WITH THE LOGIN
-- ============================================================================
--
-- emailForNickname() (app/src/features/auth/schema.ts:39) derives the sign-in
-- address from the nickname. The account being moved was created under the
-- formatted nickname the applicant typed (철수/98/남/관악), and the roster row
-- carries the workbook's short one — measured, 35 of 41 rows have
-- nickname = short_name.
--
-- Leave the roster nickname in place and the member is left in a state nobody
-- can debug from the screen: the app calls them one thing, and that thing is not
-- what signs them in.
--
-- The two unique indexes are why the delete comes FIRST and the update second,
-- inside one transaction: members_nickname_lower_uq (0001:45) and the unique on
-- members.auth_user_id (0001:16) are both still held by the signup row until it
-- is gone. Neither is deferrable, so the reverse order fails.

-- ------------------------------------------------------------------- the pass
alter table public.members
  add column if not exists signup_pass_expires_at timestamptz;

comment on column public.members.signup_pass_expires_at is
  '가입 허용 만료 시각. 이 회원 정보와 일치하는 가입 신청을 한 번 통과시킨다. 기존 행에 로그인을 붙이지는 않는다.';

create or replace function public.set_signup_pass_v1(
  p_member_id uuid,
  p_allowed   boolean
)
returns public.members
language plpgsql security definer set search_path = public
as $$
declare
  -- Seven days, not one. What is granted is "a pending row may exist", which is
  -- worth nothing without a second admin decision, so the window is sized for a
  -- club that talks over KakaoTalk — not for a secret that decays.
  v_window constant interval := interval '7 days';
  v_target public.members;
  v_row    public.members;
begin
  -- members has no write policy, so this line is the whole of the enforcement.
  if not public.is_master_admin() then
    raise exception 'only a master admin may allow a signup' using errcode = '42501';
  end if;
  if p_allowed is null then
    raise exception 'p_allowed is required' using errcode = '22023';
  end if;

  select * into v_target from public.members where id = p_member_id for update;
  if not found then
    raise exception 'no such member' using errcode = '23503';
  end if;

  -- A row that already has a login has nothing to be let through for.
  if v_target.auth_user_id is not null then
    raise exception 'member already has a login' using errcode = '42501';
  end if;
  -- Blocked and rejected are decisions somebody made. Reversing them is
  -- set_member_blocked_v1 and set_member_status_v1, not a side effect of this.
  if v_target.status not in ('approved', 'pending') then
    raise exception 'member is not in good standing' using errcode = '42501';
  end if;
  if v_target.role = 'master_admin' then
    raise exception 'cannot change a master admin' using errcode = '42501';
  end if;

  -- Both directions through one function, the shape set_member_blocked_v1
  -- settled on: withdrawing a pass issued by mistake is the same decision made
  -- the other way round.
  update public.members
     set signup_pass_expires_at = case when p_allowed then now() + v_window end,
         updated_at = now()
   where id = p_member_id
  returning * into v_row;

  return v_row;
end $$;

comment on function public.set_signup_pass_v1(uuid, boolean) is
  '가입 허용 발급·회수. 총관리자만 호출할 수 있고 로그인이 없는 회원 행에만 붙는다.';

-- --------------------------------------------------------- what the admin sees
-- WHAT IS HERE AND WHY. nickname, short_name, gender and birth_year are the
-- match itself. 실명 and 가입일 are what tell one club member from another when
-- two roster rows match the same triple. The three counts are the weight of what
-- a 연결 would move.
--
-- WHAT IS DELIBERATELY NOT HERE: birth_date_text (the YEAR is what the guard
-- matched; the day adds nothing to the decision and everything to the dossier),
-- notes, join_reason, lesson_level, swim_experience.
--
-- SECURITY INVOKER, on purpose. Called from inside the SECURITY DEFINER board it
-- runs as the definer; called directly by anybody else it runs as them, and
-- members_read hands a non-staff caller one row. Combined with having no execute
-- grant at all, that is two independent reasons this cannot leak the roster.
create or replace function public.member_link_summary_v1(p_member_id uuid)
returns jsonb
language sql stable set search_path = public
as $$
  select jsonb_build_object(
    'id',                     m.id,
    'nickname',               m.nickname,
    'short_name',             m.short_name,
    'real_name',              m.real_name,
    'join_date_text',         m.join_date_text,
    'birth_year',             m.birth_year,
    'gender',                 m.gender,
    'status',                 m.status,
    'signup_pass_expires_at', m.signup_pass_expires_at,
    'attendance_count',
      (select count(*) from public.attendance a where a.member_id = m.id),
    'record_count',
      (select count(*) from public.records r where r.member_id = m.id),
    'application_count',
      (select count(*) from public.activity_applications p where p.member_id = m.id)
  )
    from public.members m
   where m.id = p_member_id
$$;

comment on function public.member_link_summary_v1(uuid) is
  '회원 연결 화면이 보여주는 한 행. 실행 권한을 아무에게도 주지 않으며 member_link_board_v1 안에서만 쓴다.';

-- ------------------------------------------------------------------ the board
create or replace function public.member_link_board_v1()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_signups jsonb;
  v_roster  jsonb;
begin
  if not public.is_master_admin() then
    raise exception 'only a master admin may read the member link board'
      using errcode = '42501';
  end if;

  -- Pending rows that HAVE a login: somebody who signed up and is waiting. A
  -- pending row without one is a roster row whose auth account was deleted
  -- (members.auth_user_id is ON DELETE SET NULL, 0001:16).
  select coalesce(jsonb_agg(t.entry order by t.created_at), '[]'::jsonb)
    into v_signups
    from (
      select s.created_at,
             jsonb_build_object(
               'id',         s.id,
               'nickname',   s.nickname,
               'created_at', s.created_at,
               'candidates', coalesce(c.list, '[]'::jsonb)
             ) as entry
        from (
          select m.id, m.nickname, m.created_at,
                 -- normalize() for the same reason 0032 does it: NFC and NFD
                 -- Hangul render identically and compare unequal.
                 string_to_array(normalize(m.nickname, nfc), '/') as parts
            from public.members m
           where m.status = 'pending'
             and m.auth_user_id is not null
        ) s
        -- The guard's rule, restated. Deliberately not shared with
        -- register_member_v1 through a helper: this copy only decides what to
        -- SHOW, and a drift offers a candidate the admin still confirms by hand.
        left join lateral (
          select jsonb_agg(public.member_link_summary_v1(r.id) order by r.nickname) as list
            from public.members r
           where r.auth_user_id is null
             and r.status in ('approved', 'pending')
             and r.role <> 'master_admin'
             and array_length(s.parts, 1) = 4
             and lower(normalize(r.short_name, nfc)) = lower(s.parts[1])
             -- CASE around the cast, not a filter beside it. `'ab'::int` RAISES
             -- rather than failing to match, and a planner does not promise to
             -- evaluate an AND left to right.
             and r.birth_year % 100 =
                 (case when s.parts[2] ~ '^[0-9]{2}$' then s.parts[2] end)::int
             and r.gender = s.parts[3]
        ) c on true
    ) t;

  -- Every roster row with no login. Two jobs: 가입 허용 for the person who has
  -- not got in yet, and the override — a match the guard could not make because
  -- the workbook spells their name differently or carries the wrong year.
  select coalesce(jsonb_agg(t.entry order by t.nickname), '[]'::jsonb)
    into v_roster
    from (
      select m.nickname, public.member_link_summary_v1(m.id) as entry
        from public.members m
       where m.auth_user_id is null
         and m.status in ('approved', 'pending')
         and m.role <> 'master_admin'
    ) t;

  return jsonb_build_object('signups', v_signups, 'roster', v_roster);
end $$;

comment on function public.member_link_board_v1() is
  '회원 연결 화면 데이터. 로그인 없는 회원 목록과, 승인 대기 중인 가입 신청마다 가드가 찾아낸 후보 행을 함께 돌려준다.';

-- ------------------------------------------------------------------- the link
-- The most dangerous write in this application. Everything above exists so that
-- this function is reached by a human who has already looked at both rows.
--
-- ON THE OVERRIDE: this function does NOT require that the guard matched the two
-- rows. The workbook is a spreadsheet a human typed, and a member whose name is
-- spelled differently there would otherwise be refused by the guard for having
-- the wrong data and refused by the fix for the same reason. The authority is
-- the master admin's judgement about a person they know. The database's job is
-- the refusals below, which no judgement may override.
create or replace function public.link_member_login_v1(
  p_signup_member_id uuid,
  p_target_member_id uuid
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_signup public.members;
  v_target public.members;
  v_fk     record;
  v_found  boolean;
  v_auth   uuid;
  v_name   text;
begin
  if not public.is_master_admin() then
    raise exception 'only a master admin may link a member login'
      using errcode = '42501';
  end if;
  if p_signup_member_id is null or p_target_member_id is null then
    raise exception 'both member ids are required' using errcode = '22023';
  end if;
  if p_signup_member_id = p_target_member_id then
    raise exception 'cannot link a member to itself' using errcode = '22023';
  end if;

  -- LOCKED IN ID ORDER, not argument order. Two admins linking two signups that
  -- name each other's rows would otherwise deadlock; a fixed order makes one
  -- wait instead.
  if p_signup_member_id < p_target_member_id then
    select * into v_signup from public.members where id = p_signup_member_id for update;
    select * into v_target from public.members where id = p_target_member_id for update;
  else
    select * into v_target from public.members where id = p_target_member_id for update;
    select * into v_signup from public.members where id = p_signup_member_id for update;
  end if;

  if v_signup.id is null then
    raise exception 'no such signup' using errcode = '23503';
  end if;
  if v_target.id is null then
    raise exception 'no such member' using errcode = '23503';
  end if;

  -- ---- the signup side -----------------------------------------------------
  if v_signup.auth_user_id is null then
    raise exception 'signup has no login to move' using errcode = '42501';
  end if;
  -- ONLY AN UNDECIDED SIGNUP. Moving an APPROVED member's login onto another
  -- member's row would take a person who is using the app and silently reseat
  -- them on somebody else's history. Restricting to 'pending' also excludes the
  -- caller's own row, since a master admin is by definition approved.
  if v_signup.status <> 'pending' then
    raise exception 'only a pending signup can be linked' using errcode = '42501';
  end if;
  if v_signup.role <> 'member' then
    raise exception 'cannot move a login that carries a role' using errcode = '42501';
  end if;

  -- ---- the target side -----------------------------------------------------
  -- THE REFUSAL THIS FUNCTION EXISTS TO MAKE. auth_user_id is unique so the
  -- write would fail anyway, but a constraint error gives the admin Postgres
  -- where they need a sentence — and relying on the index would mean this
  -- function's safety came from somewhere else.
  if v_target.auth_user_id is not null then
    raise exception 'member already has a login' using errcode = '42501';
  end if;
  if v_target.status not in ('approved', 'pending') then
    raise exception 'member is not in good standing' using errcode = '42501';
  end if;
  if v_target.role = 'master_admin' then
    raise exception 'cannot change a master admin' using errcode = '42501';
  end if;

  -- ---- prove the discarded row is empty ------------------------------------
  -- Read off pg_constraint so a table added later is covered without anybody
  -- remembering to come back here. conkey is unnested: a composite key is
  -- checked one column at a time, which is stricter than the constraint and
  -- never wrong — it can only refuse a delete that would have been fine.
  for v_fk in
    select nsp.nspname::text as schema_name,
           src.relname::text as table_name,
           att.attname::text as column_name
      from pg_constraint con
      join pg_class src        on src.oid = con.conrelid
      join pg_namespace nsp    on nsp.oid = src.relnamespace
      join lateral unnest(con.conkey) as k(attnum) on true
      join pg_attribute att    on att.attrelid = con.conrelid
                              and att.attnum   = k.attnum
     where con.contype   = 'f'
       and con.confrelid = 'public.members'::regclass
  loop
    execute format('select exists (select 1 from %I.%I where %I = $1)',
                   v_fk.schema_name, v_fk.table_name, v_fk.column_name)
       into v_found
      using p_signup_member_id;

    if v_found then
      -- Named, because a bare refusal would send the admin to ask somebody to
      -- read the logs. This should never fire, and if it does the table name is
      -- the whole diagnosis.
      raise exception '가입 신청 계정에 이미 %.% 데이터가 있어 연결할 수 없습니다',
        v_fk.table_name, v_fk.column_name using errcode = '42501';
    end if;
  end loop;

  -- ---- the move ------------------------------------------------------------
  v_auth := v_signup.auth_user_id;
  v_name := v_signup.nickname;

  -- DELETE FIRST. Both unique indexes are still held by this row and neither is
  -- deferrable. The auth.users row is untouched: the foreign key runs the other
  -- way, and the account is being re-seated rather than removed.
  delete from public.members where id = p_signup_member_id;

  update public.members
     set auth_user_id           = v_auth,
         nickname               = v_name,
         -- The admin identified this person against years of their own history,
         -- a stronger check than the approval queue performs.
         status                 = 'approved',
         signup_pass_expires_at = null,
         updated_at             = now()
   where id = p_target_member_id;

  -- The counts are the receipt: an admin who picked the wrong row sees it
  -- immediately rather than trusting a green tick.
  return jsonb_build_object(
    'ok', true,
    'member', public.member_link_summary_v1(p_target_member_id)
  );
end $$;

comment on function public.link_member_login_v1(uuid, uuid) is
  '가입 신청 계정을 기존 회원 행으로 옮긴다. 총관리자만 호출할 수 있고 대상 행에 이미 로그인이 있으면 거절한다. 비어 있는 신청 행은 삭제한다.';

-- -------------------------------------------------------------- execute rights
-- Revoked from anon and authenticated BY NAME, not merely from PUBLIC — 0011's
-- header records why, and 0026 made an ungranted function unreachable rather
-- than public. The live ACL is queried back after this applies; reading
-- correctly here is not evidence.
--
-- member_link_summary_v1 is granted to NOBODY. It has no authority check of its
-- own by design and exists only to be called from inside member_link_board_v1.
revoke all on function public.set_signup_pass_v1(uuid, boolean) from public, anon, authenticated;
revoke all on function public.member_link_board_v1()            from public, anon, authenticated;
revoke all on function public.link_member_login_v1(uuid, uuid)  from public, anon, authenticated;
revoke all on function public.member_link_summary_v1(uuid)      from public, anon, authenticated;

grant execute on function public.set_signup_pass_v1(uuid, boolean) to authenticated;
grant execute on function public.member_link_board_v1()            to authenticated;
grant execute on function public.link_member_login_v1(uuid, uuid)  to authenticated;
