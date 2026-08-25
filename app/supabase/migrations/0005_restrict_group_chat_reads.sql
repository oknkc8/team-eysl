-- 0005 — group chat was readable by anyone with a session.
--
-- 0004's messages_read policy allowed every 'group' row on the strength of
-- room_type alone. Any authenticated Supabase session could read the whole
-- club chat — including a member still in 'pending', and one already set to
-- 'blocked'. Blocking someone is supposed to end their access; it didn't.
--
-- current_member_id() already returns null unless the caller is an approved
-- member, so requiring it is the fix. The dm branches were fine: they compare
-- against current_member_id(), which was never null for a non-member.

drop policy if exists messages_read on public.messages;
create policy messages_read on public.messages
  for select using (
    public.current_member_id() is not null
    and (
      room_type = 'group'
      or sender_id = public.current_member_id()
      or recipient_id = public.current_member_id()
    )
  );
