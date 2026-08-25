-- 0012 — the write half of chat, plus the grants push needed and never got.
--
-- 0004 created public.messages with a read policy and no write path at all: its
-- own comment says "쓰기는 서버 경유", meaning an Edge Function in the president's
-- project whose source we cannot read and whose replacement we cannot deploy.
-- So the send path becomes a SECURITY DEFINER RPC here, which is where every
-- other write in this schema already lives (append_notice_comment, upsert_record,
-- set_member_*_v1).
--
-- Three things are settled below:
--   1. send_message_v1() — derives the sender from the session, validates the
--      room shape, and turns the table's CHECK constraints into errors a screen
--      can print.
--   2. public.messages joins the supabase_realtime publication. Verified empty
--      before this migration: `select … from pg_publication_tables where
--      pubname='supabase_realtime'` returned 0 rows, so the legacy app's
--      postgres_changes pattern would have delivered nothing at all here.
--   3. push_subscriptions loses the default grants 0004 left on it. anon held
--      INSERT/UPDATE/DELETE/SELECT on that table — the same shape of hole 0002
--      was written to close, missed because 0004 added the table afterwards.

-- ==================================================================== send RPC

-- The sender is auth.uid()'s member row and nothing else: p_* carries no
-- sender_id, so a client has no field to lie in. Same reasoning as
-- append_notice_comment (0004), where the author is derived rather than sent.
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
  '채팅 메시지 전송. 보낸 사람은 세션에서 정하며 클라이언트가 지정할 수 없다.';

-- ================================================================== realtime
-- Without this the client's postgres_changes subscription connects, reports
-- SUBSCRIBED and then never fires: a publication a table is not in produces no
-- WAL messages for it. RLS still applies on top — Realtime evaluates
-- messages_read (0005) as the subscriber, so a DM reaches its two participants
-- and nobody else.
--
-- No exception handler on purpose. If the migration user cannot alter the
-- publication, chat looks like it works and silently never updates; failing the
-- migration is the outcome we can actually see.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;

-- ========================================================= push_subscriptions
-- 0004 created this table and relied on push_subscriptions_self for safety. The
-- policy does hold — member_id = current_member_id() is never true for anon,
-- whose current_member_id() is null — but the table still carried Supabase's
-- default grants, so anon's refusal came from one layer where every other table
-- here uses two. messages got the same treatment in 0004:268-269; this table
-- was simply missed.
revoke all on public.push_subscriptions from anon, authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;

-- --------------------------------------------------------------- execute rights
-- Revoked from anon and authenticated by name before being granted back, not
-- only from PUBLIC: Supabase's default privileges on a new function are separate
-- grants, which is how 0002's expire_stale_offers stayed anonymously callable
-- after a `revoke … from public` that read correctly.
revoke all on function public.send_message_v1(text, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.send_message_v1(text, text, uuid, text, text)
  to authenticated;
