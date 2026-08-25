-- 0010 — three cleanups, one of them a real leak.
--
-- 1. activity_seats_v was readable by anon, same class as the member_public_v
--    leak 0009 closed. Both views are postgres-owned without security_invoker,
--    so they bypass RLS by design — which is what makes Supabase's default anon
--    SELECT grant on them a hole rather than a nuisance. Milder here (only
--    per-activity counts) but it is the same mistake and it is still open.
--
-- 2. Member approval was widened from master_admin to any staff. The legacy app
--    gates it on master_admin, and a feature that exists in the legacy app is
--    the spec — widening who can admit members is the president's call, not
--    ours to make silently.
--
-- 3. A stale ledger row from renaming 0005_waitlist_offer_response to 0006.
--    Harmless (migrate.sh keys off filename) but it claims a migration that has
--    no file, which will mislead whoever reads the ledger next.

-- ------------------------------------------------------------------ the leak
revoke all on public.activity_seats_v from anon;
-- Stop the platform default from putting it back on views added later.
alter default privileges in schema public revoke select on tables from anon;

-- --------------------------------------------------- approval back to master
create or replace function public.set_member_status_v1(
  p_member_id uuid,
  p_status    text
)
returns public.members
language plpgsql security definer set search_path = public
as $$
declare
  v_row public.members;
begin
  -- Matches the legacy gate (isMasterAdmin), not the wider is_staff().
  if not public.is_master_admin() then
    raise exception 'only a master admin may approve or reject members'
      using errcode = '42501';
  end if;
  if p_status not in ('approved','rejected') then
    raise exception 'invalid status: %', p_status using errcode = '22023';
  end if;

  update public.members
     set status = p_status, updated_at = now()
   where id = p_member_id
     -- Never flip an existing member's standing through the approval queue;
     -- that path is for pending applications only.
     and status = 'pending'
   returning * into v_row;

  if v_row.id is null then
    raise exception 'no pending member with that id' using errcode = '23503';
  end if;

  return v_row;
end $$;

revoke all on function public.set_member_status_v1(uuid, text) from public, anon, authenticated;
grant execute on function public.set_member_status_v1(uuid, text) to authenticated;

-- ------------------------------------------------------------- stale ledger
delete from public.schema_migrations where version = '0005_waitlist_offer_response';
