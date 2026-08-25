-- 0007 — reapplying after receiving an offer hit a CHECK constraint.
--
-- apply_to_activity()'s ON CONFLICT branch flips application_type back to
-- 'participant' and clears wait_order, but left offer_status alone. The table
-- has `check (offer_status = 'none' or application_type = 'waitlist')`, so a
-- waitlister holding an 'offered' row who applied again got a constraint
-- violation instead of a seat.
--
-- Not reachable from our UI (an applied member is shown cancel, not apply) but
-- reachable through the API, and a constraint violation is the worst way to
-- learn that. Also clear offer_expires_at so no stale deadline lingers.

create or replace function public.apply_to_activity(p_activity_id uuid)
returns public.activity_applications
language plpgsql security definer set search_path = public
as $$
declare
  v_member   uuid;
  v_capacity int;
  v_taken    int;
  v_next     int;
  v_row      public.activity_applications;
begin
  v_member := public.current_member_id();
  if v_member is null then
    raise exception 'not an approved member' using errcode = '42501';
  end if;

  select capacity into v_capacity
    from public.activities where id = p_activity_id for update;
  if not found then
    raise exception 'no such activity' using errcode = '23503';
  end if;

  select count(*) into v_taken
    from public.activity_applications
   where activity_id = p_activity_id and application_type = 'participant';

  if v_capacity is null or v_taken < v_capacity then
    insert into public.activity_applications (activity_id, member_id, application_type)
    values (p_activity_id, v_member, 'participant')
    on conflict (activity_id, member_id) do update
      set application_type = 'participant',
          wait_order       = null,
          -- Both cleared: a participant row must carry no offer state.
          offer_status     = 'none',
          offer_expires_at = null,
          updated_at       = now()
    returning * into v_row;
  else
    select coalesce(max(wait_order), 0) + 1 into v_next
      from public.activity_applications
     where activity_id = p_activity_id and application_type = 'waitlist';

    insert into public.activity_applications (activity_id, member_id, application_type, wait_order)
    values (p_activity_id, v_member, 'waitlist', v_next)
    on conflict (activity_id, member_id) do update
      set application_type = 'waitlist',
          wait_order       = v_next,
          updated_at       = now()
    returning * into v_row;
  end if;

  return v_row;
end $$;

revoke all on function public.apply_to_activity(uuid) from public, anon, authenticated;
grant execute on function public.apply_to_activity(uuid) to authenticated;
