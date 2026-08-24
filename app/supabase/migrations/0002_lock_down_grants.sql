-- 0002 — close two holes that 0001 left open.
--
-- Both were found by review and then confirmed against the live dev database,
-- not assumed. `revoke ... from public` in 0001 was not enough: Supabase grants
-- EXECUTE on new functions to anon and authenticated through default privileges,
-- and those grants are separate from PUBLIC's.
--
--   expire_stale_offers | postgres=X | anon=X | authenticated=X | service_role=X
--   schema_migrations   | relrowsecurity=f | anon=arwdDxtm
--
-- The first let an unauthenticated caller advance the waitlist queue, because
-- expire_stale_offers() is the one SECURITY DEFINER function with no caller
-- check inside it. The second gave anonymous users full write access to the
-- migration ledger, so a forged version row could make a later migration skip.

-- ------------------------------------------------------- function execute rights
-- Revoke from every role that can reach the Data API, then grant back only the
-- authenticated client surface. Listing anon and authenticated explicitly is the
-- point — PUBLIC alone does not cover them.

revoke all on function public.expire_stale_offers()                              from public, anon, authenticated;
revoke all on function public.attendance_mark_v1(uuid, uuid, text, boolean)      from public, anon, authenticated;
revoke all on function public.attendance_for_activity_v1(uuid)                   from public, anon, authenticated;
revoke all on function public.attendance_my_history_v1(date, date)               from public, anon, authenticated;
revoke all on function public.apply_to_activity(uuid)                            from public, anon, authenticated;
revoke all on function public.current_member_id()                                from public, anon, authenticated;
revoke all on function public.is_staff()                                         from public, anon, authenticated;
revoke all on function public.is_master_admin()                                  from public, anon, authenticated;

-- Client-callable surface. Each of these checks the caller itself.
grant execute on function public.attendance_mark_v1(uuid, uuid, text, boolean)   to authenticated;
grant execute on function public.attendance_for_activity_v1(uuid)                to authenticated;
grant execute on function public.attendance_my_history_v1(date, date)            to authenticated;
grant execute on function public.apply_to_activity(uuid)                         to authenticated;

-- Helpers stay reachable so RLS policies can call them, but no client needs to.
grant execute on function public.current_member_id() to authenticated;
grant execute on function public.is_staff()          to authenticated;
grant execute on function public.is_master_admin()   to authenticated;

-- expire_stale_offers() gets NO client grant at all. It is a scheduled sweep;
-- only a scheduler or an operator with elevated rights should ever run it.

-- Stop the same default grant from reappearing on functions added later.
alter default privileges in schema public revoke execute on functions from anon;

-- ------------------------------------------------------------- migration ledger
-- Not application data, and nothing outside the migration runner should read or
-- write it. RLS with no policy plus revoked grants makes it invisible to the API.
alter table if exists public.schema_migrations enable row level security;
revoke all on public.schema_migrations from anon, authenticated;

comment on table public.schema_migrations is '마이그레이션 적용 이력. 애플리케이션 데이터가 아니며 클라이언트에 노출하지 않는다.';
