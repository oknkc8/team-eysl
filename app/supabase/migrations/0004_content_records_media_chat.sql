-- 0004 — notices/comments, records, media, push, messages.
--
-- Builds on 0001 (members/activities/attendance), 0002 (grant lockdown),
-- 0003 (offer-expiry schedule). Every new table gets RLS and every new function
-- is revoked from public, anon AND authenticated before being granted back —
-- the 0002 lesson applied up front rather than as a follow-up patch.
--
-- Dues (회비) is deliberately NOT here. The club tracks it in a spreadsheet
-- today and nobody has said whether the fee is uniform or per-member, or
-- whether partial payments must be representable. Guessing the grain would
-- mean rebuilding it once the real requirements arrive.

-- ============================================================== notices
create table if not exists public.notices (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  body        text not null,
  created_by  uuid references public.members(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.notices is '공지사항. 첨부와 댓글은 별도 테이블로 분리한다.';
create index if not exists notices_created_at_idx on public.notices (created_at desc);

create table if not exists public.notice_attachments (
  id            uuid primary key default gen_random_uuid(),
  notice_id     uuid not null references public.notices(id) on delete cascade,
  storage_path  text not null,
  file_name     text not null,
  mime_type     text not null default 'application/octet-stream',
  sort_order    int not null default 0,
  created_at    timestamptz not null default now()
);
comment on table public.notice_attachments is '공지 첨부파일. team-files 버킷의 경로만 저장한다.';
create index if not exists notice_attachments_notice_idx on public.notice_attachments (notice_id, sort_order);

-- Own table keyed by member_id — not the legacy's nickname string, and not a
-- jsonb array that two concurrent commenters overwrite each other in
-- (addComment(), index.html:2001, reads the whole array and writes it back).
create table if not exists public.notice_comments (
  id          uuid primary key default gen_random_uuid(),
  notice_id   uuid not null references public.notices(id) on delete cascade,
  member_id   uuid not null references public.members(id),
  body        text not null,
  created_at  timestamptz not null default now()
);
comment on table public.notice_comments is '공지 댓글. 작성자는 member_id로만 식별하며 닉네임을 복사하지 않는다.';
create index if not exists notice_comments_notice_idx on public.notice_comments (notice_id, created_at);

-- ============================================================ record uploads
create table if not exists public.record_uploads (
  id            uuid primary key default gen_random_uuid(),
  file_name     text not null,
  storage_path  text not null,
  mime_type     text not null default 'application/octet-stream',
  category      text not null default 'meet' check (category in ('meet','fin','other')),
  note          text,
  uploaded_by   uuid not null references public.members(id),
  created_at    timestamptz not null default now()
);
comment on table public.record_uploads is '기록지 업로드 이력. 삭제하면 이 업로드에서 나온 records도 함께 삭제된다.';
create index if not exists record_uploads_uploaded_by_idx on public.record_uploads (uploaded_by);

-- ==================================================================== records
create table if not exists public.records (
  id                    uuid primary key default gen_random_uuid(),
  member_id             uuid not null references public.members(id) on delete cascade,
  category              text not null check (category in ('meet','fin','other')),
  subcategory           text not null default 'personal' check (subcategory in ('personal','relay')),
  -- Free text on purpose: stroke and relay labels come from parsed meet sheets
  -- (자유형/배영/평영/접영/계영/혼계영…), not a set the app gets to define.
  stroke                text not null,
  distance_m            int not null check (distance_m > 0),
  event_name            text not null default '',
  event_date            date not null,
  -- The exact display string the parser read ("33.08", "1:05.32"). Kept beside
  -- the numeric form rather than reformatted on read.
  result_display        text not null,
  result_centiseconds   int not null check (result_centiseconds > 0),
  teammates             text[] not null default '{}',
  metadata              jsonb not null default '{}'::jsonb,
  upload_id             uuid references public.record_uploads(id) on delete cascade,
  created_by            uuid references public.members(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
comment on table public.records is '수영 기록. upsert_record()로만 기록하며 같은 사람의 같은 종목·날짜·거리·기록은 유일하다.';
create index if not exists records_member_idx on public.records (member_id, event_date desc);

-- Replaces the legacy client-side dedup (index.html:3182-3191): SELECT, compare
-- in JS with a tolerance, then INSERT — two uploads of the same sheet can both
-- pass and both insert. The advisory lock in upsert_record() serializes it;
-- this index is the backstop, same pairing as 0001's wait_order index and lock.
create unique index if not exists records_dedup_uq
  on public.records (member_id, stroke, subcategory, event_date, distance_m, result_centiseconds);

-- ============================================================== media
create table if not exists public.media_folders (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_by  uuid not null references public.members(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.media_folders is '미디어 폴더. 실제 파일은 버킷에 있고 여기는 경로만 가진다.';

create table if not exists public.media_files (
  id            uuid primary key default gen_random_uuid(),
  -- null이면 자료실 파일. 폴더를 지우면 그 안의 파일도 함께 사라진다.
  folder_id     uuid references public.media_folders(id) on delete cascade,
  uploader_id   uuid not null references public.members(id),
  file_name     text not null,
  storage_path  text not null,
  mime_type     text not null default 'application/octet-stream',
  created_at    timestamptz not null default now()
);
comment on table public.media_files is '미디어·자료실 파일. folder_id가 null이면 자료실 파일이다.';
create index if not exists media_files_folder_idx on public.media_files (folder_id);

-- ======================================================== push_subscriptions
create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  -- Cascade here, unlike members.auth_user_id in 0001: a subscription is a
  -- device token, not history worth keeping after the member is gone.
  member_id   uuid not null references public.members(id) on delete cascade,
  endpoint    text not null,
  p256dh      text not null,
  auth        text not null,
  user_agent  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (member_id, endpoint)
);
comment on table public.push_subscriptions is '기기별 웹푸시 구독. 한 회원이 여러 기기를 등록할 수 있다.';

-- ==================================================================== messages
create table if not exists public.messages (
  id                uuid primary key default gen_random_uuid(),
  room_type         text not null check (room_type in ('group','dm')),
  sender_id         uuid not null references public.members(id),
  recipient_id      uuid references public.members(id),
  body              text,
  attachment_path   text,
  attachment_type   text,
  created_at        timestamptz not null default now(),
  constraint recipient_matches_room_type
    check ((room_type = 'group') = (recipient_id is null)),
  constraint body_or_attachment
    check (coalesce(body, '') <> '' or attachment_path is not null)
);
comment on table public.messages is '단체·1:1 채팅. 읽기 정책은 Realtime 구독 인가용이며 쓰기는 서버 경유다.';
create index if not exists messages_created_at_idx on public.messages (created_at);
create index if not exists messages_recipient_idx on public.messages (recipient_id) where recipient_id is not null;

-- --------------------------------------------------------------- helper
-- The legacy gate for 결과지 업로드 is isAdminUser() || teamRole === '코치'.
-- team_role is free text, not the role enum is_staff() reads, so it needs its
-- own helper. Worth tightening later — a typo silently removes access.
create or replace function public.can_manage_records()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.members
     where auth_user_id = auth.uid()
       and status = 'approved'
       and (role in ('admin','master_admin') or team_role = '코치')
  )
$$;

-- ------------------------------------------------------------------------- RLS
alter table public.notices             enable row level security;
alter table public.notice_attachments  enable row level security;
alter table public.notice_comments     enable row level security;
alter table public.record_uploads      enable row level security;
alter table public.records             enable row level security;
alter table public.media_folders       enable row level security;
alter table public.media_files         enable row level security;
alter table public.push_subscriptions  enable row level security;
alter table public.messages            enable row level security;

drop policy if exists notices_read on public.notices;
create policy notices_read on public.notices
  for select using (public.current_member_id() is not null);
drop policy if exists notices_write on public.notices;
create policy notices_write on public.notices
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists notice_attachments_read on public.notice_attachments;
create policy notice_attachments_read on public.notice_attachments
  for select using (public.current_member_id() is not null);
drop policy if exists notice_attachments_write on public.notice_attachments;
create policy notice_attachments_write on public.notice_attachments
  for all using (public.is_staff()) with check (public.is_staff());

-- Comments are immutable: no UPDATE policy, and no INSERT policy either —
-- inserts go through append_notice_comment() so the author cannot be spoofed.
drop policy if exists notice_comments_read on public.notice_comments;
create policy notice_comments_read on public.notice_comments
  for select using (public.current_member_id() is not null);
drop policy if exists notice_comments_delete on public.notice_comments;
create policy notice_comments_delete on public.notice_comments
  for delete using (member_id = public.current_member_id() or public.is_staff());

-- Insert and update/delete are split so any staff member can manage a
-- colleague's upload without a shared WITH CHECK re-testing uploaded_by.
drop policy if exists record_uploads_read on public.record_uploads;
create policy record_uploads_read on public.record_uploads
  for select using (public.can_manage_records());
drop policy if exists record_uploads_insert on public.record_uploads;
create policy record_uploads_insert on public.record_uploads
  for insert with check (public.can_manage_records() and uploaded_by = public.current_member_id());
drop policy if exists record_uploads_update on public.record_uploads;
create policy record_uploads_update on public.record_uploads
  for update using (public.can_manage_records()) with check (public.can_manage_records());
drop policy if exists record_uploads_delete on public.record_uploads;
create policy record_uploads_delete on public.record_uploads
  for delete using (public.can_manage_records());

-- No write policy at all: every write goes through upsert_record(), and
-- deletes happen by cascade when an upload is removed.
drop policy if exists records_read on public.records;
create policy records_read on public.records
  for select using (member_id = public.current_member_id() or public.can_manage_records());

drop policy if exists media_folders_read on public.media_folders;
create policy media_folders_read on public.media_folders
  for select using (public.current_member_id() is not null);
drop policy if exists media_folders_insert on public.media_folders;
create policy media_folders_insert on public.media_folders
  for insert with check (created_by = public.current_member_id());
drop policy if exists media_folders_update on public.media_folders;
create policy media_folders_update on public.media_folders
  for update using (created_by = public.current_member_id() or public.is_staff())
             with check (created_by = public.current_member_id() or public.is_staff());
drop policy if exists media_folders_delete on public.media_folders;
create policy media_folders_delete on public.media_folders
  for delete using (created_by = public.current_member_id() or public.is_staff());

drop policy if exists media_files_read on public.media_files;
create policy media_files_read on public.media_files
  for select using (public.current_member_id() is not null);
drop policy if exists media_files_insert on public.media_files;
create policy media_files_insert on public.media_files
  for insert with check (uploader_id = public.current_member_id());
drop policy if exists media_files_update on public.media_files;
create policy media_files_update on public.media_files
  for update using (uploader_id = public.current_member_id() or public.is_staff())
             with check (uploader_id = public.current_member_id() or public.is_staff());
drop policy if exists media_files_delete on public.media_files;
create policy media_files_delete on public.media_files
  for delete using (uploader_id = public.current_member_id() or public.is_staff());

drop policy if exists push_subscriptions_self on public.push_subscriptions;
create policy push_subscriptions_self on public.push_subscriptions
  for all using (member_id = public.current_member_id())
  with check (member_id = public.current_member_id());

-- Read-only for clients. The policy exists so Realtime can authorize the INSERT
-- subscription; writes go through the server.
drop policy if exists messages_read on public.messages;
create policy messages_read on public.messages
  for select using (
    room_type = 'group'
    or sender_id = public.current_member_id()
    or recipient_id = public.current_member_id()
  );
revoke all on public.messages from anon, authenticated;
grant select on public.messages to authenticated;

-- ------------------------------------------------------------------------ RPCs

-- Derives the author from auth.uid(), so a client cannot claim to be someone
-- else — and each comment is one INSERT, so concurrent comments cannot
-- overwrite each other the way the legacy jsonb array did.
create or replace function public.append_notice_comment(p_notice_id uuid, p_body text)
returns public.notice_comments
language plpgsql security definer set search_path = public
as $$
declare
  v_member uuid;
  v_body   text;
  v_row    public.notice_comments;
begin
  v_member := public.current_member_id();
  if v_member is null then
    raise exception 'not an approved member' using errcode = '42501';
  end if;

  v_body := btrim(coalesce(p_body, ''));
  if v_body = '' then
    raise exception 'comment body is empty' using errcode = '22023';
  end if;

  if not exists (select 1 from public.notices where id = p_notice_id) then
    raise exception 'no such notice' using errcode = '23503';
  end if;

  insert into public.notice_comments (notice_id, member_id, body)
  values (p_notice_id, v_member, v_body)
  returning * into v_row;

  return v_row;
end $$;

-- Atomic replacement for the legacy read-then-write dedup. The advisory lock is
-- scoped to the natural key so two uploads of the same swim serialize.
create or replace function public.upsert_record(
  p_member_id           uuid,
  p_category            text,
  p_subcategory         text,
  p_stroke              text,
  p_distance_m          int,
  p_event_date          date,
  p_result_display      text,
  p_result_centiseconds int,
  p_event_name          text default '',
  p_teammates           text[] default '{}',
  p_metadata            jsonb default '{}'::jsonb,
  p_upload_id           uuid default null
)
returns public.records
language plpgsql security definer set search_path = public
as $$
declare
  v_lock_key bigint;
  v_stale_id uuid;
  v_row      public.records;
begin
  if not public.can_manage_records() then
    raise exception 'only staff or coach may record results' using errcode = '42501';
  end if;
  if p_category not in ('meet','fin','other') then
    raise exception 'invalid category: %', p_category using errcode = '22023';
  end if;
  if p_result_centiseconds is null or p_result_centiseconds <= 0 then
    raise exception 'invalid result_centiseconds' using errcode = '22023';
  end if;

  v_lock_key := hashtextextended(
    p_member_id::text || '|' || p_stroke || '|' || coalesce(p_subcategory,'personal') || '|' ||
    p_event_date::text || '|' || p_distance_m::text, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  -- Replace an imprecise placeholder once a sharper reading for the same swim
  -- arrives, e.g. a bare ".00" pulled from a merged cell.
  select id into v_stale_id
    from public.records
   where member_id = p_member_id and stroke = p_stroke
     and subcategory = coalesce(p_subcategory,'personal')
     and event_date = p_event_date and distance_m = p_distance_m
     and result_display like '%.00' and p_result_display not like '%.00'
   limit 1;
  if v_stale_id is not null then
    delete from public.records where id = v_stale_id;
  end if;

  insert into public.records (
    member_id, category, subcategory, stroke, distance_m, event_name, event_date,
    result_display, result_centiseconds, teammates, metadata, upload_id, created_by
  ) values (
    p_member_id, p_category, coalesce(p_subcategory,'personal'), p_stroke, p_distance_m,
    coalesce(p_event_name,''), p_event_date, p_result_display, p_result_centiseconds,
    coalesce(p_teammates,'{}'), coalesce(p_metadata,'{}'::jsonb), p_upload_id, public.current_member_id()
  )
  on conflict (member_id, stroke, subcategory, event_date, distance_m, result_centiseconds) do nothing
  returning * into v_row;

  if v_row.id is null then
    select * into v_row from public.records
     where member_id = p_member_id and stroke = p_stroke
       and subcategory = coalesce(p_subcategory,'personal')
       and event_date = p_event_date and distance_m = p_distance_m
       and result_centiseconds = p_result_centiseconds
     limit 1;
  end if;

  return v_row;
end $$;

-- --------------------------------------------------------------- execute rights
revoke all on function public.can_manage_records()                                                                   from public, anon, authenticated;
revoke all on function public.append_notice_comment(uuid, text)                                                      from public, anon, authenticated;
revoke all on function public.upsert_record(uuid, text, text, text, int, date, text, int, text, text[], jsonb, uuid) from public, anon, authenticated;

grant execute on function public.append_notice_comment(uuid, text)                                                      to authenticated;
grant execute on function public.upsert_record(uuid, text, text, text, int, date, text, int, text, text[], jsonb, uuid) to authenticated;
grant execute on function public.can_manage_records()                                                                   to authenticated;
