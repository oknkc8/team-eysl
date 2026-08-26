-- 0033 — 자유게시판. The club board any approved member writes to.
--
-- His screens are `freeBoard` / `boardDetail` / `boardWrite` (upstream:1278-1292)
-- and the table behind them is `board_posts` with exactly
-- `id, author_id, title, body, created_at, updated_at` (upstream:2595). The
-- column names are his, unchanged, so a future cutover reads his rows rather
-- than a translation of them.
--
-- WHO MAY DO WHAT, read out of his file rather than assumed:
--
--   write   — anybody approved. The ＋ that opens 글 작성 is unconditional
--             markup (upstream:1279) and applyRole() (upstream:2407-2416) never
--             touches a board control, so there is no role behind it.
--   edit    — the author, and nobody else. editBoardPost refuses a non-author
--             (upstream:2639) and the update itself carries
--             `.eq('author_id', currentUser.memberId)` (upstream:2656). Staff
--             are deliberately NOT an exception; he did not make one.
--   delete  — the author or staff. `own || isAdminUser()` (upstream:2668), and
--             isAdminUser() (upstream:2418) is our is_staff().
--
-- WHERE THE AUTHORITY LIVES. His client sends the author with the row
-- (`insert({author_id: currentUser.memberId, ...})`, upstream:2660), which is a
-- browser naming who wrote a post. Ours cannot: the table has a read policy and
-- no write policy at all — the same arrangement `records` (0004:220-224) and
-- `notice_comments` (0004:196-203) already use — and the three RPCs below are
-- the only way in. Each derives the author from auth.uid() via
-- current_member_id(), so there is no field a client could fill in wrongly.
--
-- WHY THE RPCs RAISE INSTEAD OF RETURNING NOTHING. deleteNotice
-- (notices/api.ts:136-139) is this repo's standing example of the other shape:
-- it never looks at what it changed, so a policy refusal arrives as a resolved
-- promise and the screen reports success. Every function here reads the row
-- under FOR UPDATE first, refuses by exception, and returns what it actually
-- wrote — a caller cannot mistake a refusal for a save.

-- ==================================================================== table
create table if not exists public.board_posts (
  id          uuid primary key default gen_random_uuid(),
  -- NOT NULL and no cascade, matching media_files.uploader_id (0004:111).
  -- Authorship is the entire authority model for this table, so a post without
  -- an author is not a state worth being able to represent; members are blocked
  -- rather than deleted, so a cascade would never fire anyway.
  author_id   uuid not null references public.members(id),
  title       text not null,
  body        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- btrim inside the check, not merely `<> ''`: a title of three spaces passes
  -- a length test and renders as an empty row. The bounds are his input
  -- attributes (maxlength 120 / 10000, upstream:1289-1290) — presentation in
  -- his app, an actual limit here.
  constraint board_posts_title_len check (char_length(btrim(title)) between 1 and 120),
  constraint board_posts_body_len  check (char_length(btrim(body))  between 1 and 10000)
);

comment on table public.board_posts is
  '자유게시판 글. 작성자는 세션에서 정하며 클라이언트가 author_id를 보내지 않는다. 쓰기는 board_post RPC로만 한다.';

-- Ordered exactly the way the list reads it. The id is in the index for the
-- same reason listComments carries a tiebreak (notices/api.ts:171-173): two
-- posts written in the same second would otherwise swap places between
-- refetches and the list would flicker.
create index if not exists board_posts_created_at_idx
  on public.board_posts (created_at desc, id desc);

-- ====================================================================== RLS
alter table public.board_posts enable row level security;

-- Read: any approved member, same sentence as notices_read (0004:183-184).
drop policy if exists board_posts_read on public.board_posts;
create policy board_posts_read on public.board_posts
  for select using (public.current_member_id() is not null);

-- No INSERT, UPDATE or DELETE policy anywhere in this file, and that is the
-- gate. With RLS enabled and no permissive policy for a command, PostgreSQL
-- refuses it outright — so `supabase.from('board_posts').insert(...)` cannot
-- reach this table however the row is shaped.
drop policy if exists board_posts_insert on public.board_posts;
drop policy if exists board_posts_update on public.board_posts;
drop policy if exists board_posts_delete on public.board_posts;

-- ================================================================== helpers

-- One definition of "acceptable post text", shared by the create and update
-- RPCs so the two cannot drift into disagreeing about what a valid title is.
--
-- Never granted to anyone. It is called only from inside the SECURITY DEFINER
-- functions below, which execute as this function's owner and therefore need no
-- grant — so leaving it ungranted costs nothing and keeps it off the list of
-- things a browser can reach.
create or replace function public.board_post_text(p_value text, p_field text, p_max int)
returns text
language plpgsql immutable
as $$
declare
  v text := btrim(coalesce(p_value, ''));
begin
  if v = '' then
    raise exception '% is empty', p_field using errcode = '22023';
  end if;
  if char_length(v) > p_max then
    raise exception '% is longer than % characters', p_field, p_max using errcode = '22001';
  end if;
  return v;
end $$;

comment on function public.board_post_text(text, text, int) is
  '게시글 제목·본문을 다듬고 검사한다. board_post RPC 내부 전용이며 아무에게도 EXECUTE를 주지 않는다.';

-- ===================================================================== RPCs

create or replace function public.create_board_post_v1(p_title text, p_body text)
returns public.board_posts
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_me  uuid := public.current_member_id();
  v_row public.board_posts;
begin
  -- null for anyone pending, rejected or blocked, so this is the approval gate
  -- as well as the identity — the same one every other RPC in this schema uses.
  if v_me is null then
    raise exception 'not an approved member' using errcode = '42501';
  end if;

  insert into public.board_posts (author_id, title, body)
  values (
    v_me,
    public.board_post_text(p_title, 'title', 120),
    public.board_post_text(p_body,  'body',  10000)
  )
  returning * into v_row;

  return v_row;
end $$;

comment on function public.create_board_post_v1(text, text) is
  '자유게시판 글 작성. 작성자는 세션에서 정한다. 승인된 회원 누구나 호출할 수 있다.';

create or replace function public.update_board_post_v1(p_post_id uuid, p_title text, p_body text)
returns public.board_posts
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_me   uuid := public.current_member_id();
  v_post public.board_posts%rowtype;
  v_row  public.board_posts;
begin
  if v_me is null then
    raise exception 'not an approved member' using errcode = '42501';
  end if;

  -- Locked before the authority check, so the row this function decides about
  -- is the row it then writes. Without it a concurrent delete lands between the
  -- two and the UPDATE silently touches nothing — the exact "changed zero rows,
  -- reported success" shape this file exists to avoid.
  select * into v_post from public.board_posts where id = p_post_id for update;
  if not found then
    raise exception 'no such post' using errcode = '42704';
  end if;

  -- Author only. Staff are not an exception on this path; see the header.
  if v_post.author_id <> v_me then
    raise exception 'not your post' using errcode = '42501';
  end if;

  update public.board_posts
     set title      = public.board_post_text(p_title, 'title', 120),
         body       = public.board_post_text(p_body,  'body',  10000),
         -- Set explicitly. The column defaults to now() on insert and no trigger
         -- touches it afterwards, so it would otherwise freeze at creation time
         -- and 수정됨 would never appear — the same note updateNotice carries
         -- (notices/api.ts:125-127).
         updated_at = now()
   where id = p_post_id
  returning * into v_row;

  -- author_id is not in the SET list at all, so an edit cannot walk a post over
  -- to somebody else one column at a time.
  return v_row;
end $$;

comment on function public.update_board_post_v1(uuid, text, text) is
  '자유게시판 글 수정. 작성자만 호출할 수 있고 작성자는 바뀌지 않는다.';

create or replace function public.delete_board_post_v1(p_post_id uuid)
returns uuid
language plpgsql volatile security definer set search_path = public
as $$
declare
  v_me   uuid := public.current_member_id();
  v_post public.board_posts%rowtype;
  v_id   uuid;
begin
  if v_me is null then
    raise exception 'not an approved member' using errcode = '42501';
  end if;

  select * into v_post from public.board_posts where id = p_post_id for update;
  if not found then
    raise exception 'no such post' using errcode = '42704';
  end if;

  -- Author or staff, matching `own || isAdminUser()` (upstream:2668). This is
  -- the one place his app admits an admin, and it is deliberate on both sides:
  -- somebody has to be able to take a post down.
  if v_post.author_id <> v_me and not public.is_staff() then
    raise exception 'not your post' using errcode = '42501';
  end if;

  delete from public.board_posts where id = p_post_id returning id into v_id;

  -- Unreachable while the FOR UPDATE above holds, and asserted anyway: the id
  -- this returns is the caller's only evidence that a row went away, so it must
  -- never be able to come back null.
  if v_id is null then
    raise exception 'delete affected no rows' using errcode = 'P0002';
  end if;

  return v_id;
end $$;

comment on function public.delete_board_post_v1(uuid) is
  '자유게시판 글 삭제. 작성자 또는 운영진만 호출할 수 있으며 실제로 지운 행의 id를 돌려준다.';

-- ========================================================== execute rights
-- From public, anon and authenticated by name rather than from PUBLIC alone:
-- 0002's expire_stale_offers ended up anonymously callable exactly that way and
-- 0014 traced it to default privileges rather than to the revoke. 0026 has since
-- closed those defaults, so these are belt and braces — and cheap enough that
-- the next reader does not have to know 0026 exists to trust this file.
revoke all on function public.board_post_text(text, text, int)          from public, anon, authenticated;
revoke all on function public.create_board_post_v1(text, text)          from public, anon, authenticated;
revoke all on function public.update_board_post_v1(uuid, text, text)    from public, anon, authenticated;
revoke all on function public.delete_board_post_v1(uuid)                from public, anon, authenticated;

grant execute on function public.create_board_post_v1(text, text)       to authenticated;
grant execute on function public.update_board_post_v1(uuid, text, text) to authenticated;
grant execute on function public.delete_board_post_v1(uuid)             to authenticated;
-- board_post_text stays ungranted on purpose; see its comment.
