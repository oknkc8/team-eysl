-- 0008 — an offered seat was not actually reserved.
--
-- apply_to_activity() counted only rows with application_type='participant'.
-- A member holding a live offer still has application_type='waitlist', so their
-- seat was invisible to the count: a new applicant walking up could take it,
-- and the offered member would then fail to accept inside their own deadline.
--
-- Offering someone a seat has to mean holding it for them. Count live offers
-- alongside confirmed participants. An expired offer is not held — it stops
-- counting the moment it lapses, whether or not the sweep has run yet.

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

  -- Seats in use = confirmed participants + unexpired offers, excluding this
  -- member's own row so reapplying never competes with itself.
  select count(*) into v_taken
    from public.activity_applications
   where activity_id = p_activity_id
     and member_id <> v_member
     and (
       application_type = 'participant'
       or (offer_status = 'offered'
           and offer_expires_at is not null
           and offer_expires_at > now())
     );

  if v_capacity is null or v_taken < v_capacity then
    insert into public.activity_applications (activity_id, member_id, application_type)
    values (p_activity_id, v_member, 'participant')
    on conflict (activity_id, member_id) do update
      set application_type = 'participant',
          wait_order       = null,
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
