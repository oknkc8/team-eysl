-- 0013 — take the leftover table grants off public.messages.
--
-- 0012 stripped push_subscriptions and stopped there. A live check afterwards
-- found messages still carrying Supabase's defaults:
--
--   messages            anon=INSERT,SELECT,UPDATE   authenticated=SELECT,INSERT,UPDATE
--   push_subscriptions  anon=(none)                 authenticated=INSERT,SELECT,UPDATE,DELETE
--
-- Nothing leaks today, and this migration is not a leak fix. The table has
-- exactly one policy — messages_read, SELECT only — and RLS denies by default
-- for any command without a permissive policy, so anon's INSERT and UPDATE
-- reach no row; messages_read itself requires current_member_id() to be
-- non-null, which it never is for anon.
--
-- The grants go because they are surplus that only becomes dangerous later.
-- Every write here runs through send_message_v1 (0012), a SECURITY DEFINER
-- function that bypasses RLS by design, so no client role needs table INSERT
-- or UPDATE at all. Leaving them means the day somebody adds an INSERT policy
-- for a legitimate reason, anon silently gains the write along with it — which
-- is how 0004 reopened the hole 0002 had closed two migrations earlier. The
-- safe shape is the grant being absent, not the policy having to be careful.
--
-- SELECT for authenticated stays: messages_read is what confines it, and the
-- read path is a plain PostgREST select rather than an RPC.

revoke all on public.messages from anon;

revoke insert, update, delete, truncate, references, trigger
  on public.messages from authenticated;

grant select on public.messages to authenticated;
