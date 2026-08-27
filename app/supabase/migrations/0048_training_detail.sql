-- Training detail: coach, gear, notes, link, and a written training plan.
--
-- The president's 일정 등록 form carries these and ours did not. His are a live
-- round trip — written into activities.details at index.html:4597-4607, read
-- back at :1502, rendered at :3319-3324 — so this is a port of something that
-- works, not a new idea.
--
-- WHY AN RPC AND NOT A COLUMN UPDATE FROM THE BROWSER.
--
-- His client builds the whole details object and sends it:
--
--   details = { coach, gear, lane, info, link, plan, planBy, planDate,
--               participants: old?.participants||[], ... }
--   dbClient.from('activities').update(payload)
--
-- Whatever it does not name is gone. That is not a hypothetical — it is the
-- documented defect where editing a past training erases its backfilled
-- attendance register, because `historical_participants` and
-- `historical_attendance` are not in that list. Still true at final98.
--
-- A browser that sends a whole jsonb blob destroys every key it has not heard
-- of. Today we do not write historical_* ourselves; that is a fact about today,
-- not about next year. So the write goes through a function that MERGES:
--
--   details = coalesce(details, '{}') || jsonb_build_object(<only our keys>)
--
-- Unknown keys survive by construction rather than by everyone remembering to
-- carry them forward. The next person to add a key gets that for free.
--
-- NOT PORTED, DELIBERATELY:
--   레인별 마감인원 — his single aCapacity box feeds BOTH details.lane (free
--     text) and capacity (int, via parseCapacityText). We already have capacity
--     and the same box fills it, so only the free text is dropped. Whether a
--     per-lane cap should exist at all is a product decision, not a port.
--   훈련표 파일 / 사진·파일 — the inputs exist in his markup (aPlanFile, aAttach
--     at index.html:1388) and NOTHING reads them: each name appears exactly once
--     in the whole file. Picking a file there does nothing. Porting that would
--     be building it, which is the president's call.

create or replace function public.save_activity_details_v1(
  p_activity_id         uuid,
  p_coach               text,
  p_gear                text,
  p_info                text,
  p_link                text,
  p_plan                text,
  p_expected_updated_at timestamptz
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_me       uuid;
  v_row      public.activities;
  v_patch    jsonb := '{}'::jsonb;
  v_details  jsonb;
  v_coach    text;
  v_gear     text;
  v_info     text;
  v_link     text;
  v_plan     text;
  v_updated  timestamptz;
begin
  -- SECURITY DEFINER means activities_write is not consulted, so this line is
  -- the whole of the enforcement. Same gate that policy carries.
  if not public.is_staff() then
    raise exception 'only staff may edit a training' using errcode = '42501';
  end if;

  v_me := public.current_member_id();

  if p_expected_updated_at is null then
    raise exception 'expected updated_at is required' using errcode = '22023';
  end if;

  -- FOR UPDATE so a concurrent save queues behind this one rather than both
  -- reading the same details and both merging onto a stale copy.
  select * into v_row from public.activities where id = p_activity_id for update;
  if not found then
    raise exception 'no such activity' using errcode = '42704';
  end if;

  if v_row.updated_at <> p_expected_updated_at then
    raise exception 'activity changed elsewhere'
      using errcode = 'PT409',
            detail = jsonb_build_object('updated_at', v_row.updated_at)::text;
  end if;

  -- Trimmed, capped, and empty means absent. Storing '' would make every
  -- untouched field a key, and the screens would then have to tell '' from
  -- "never set" for no benefit.
  v_coach := nullif(btrim(coalesce(p_coach, '')), '');
  v_gear  := nullif(btrim(coalesce(p_gear,  '')), '');
  v_info  := nullif(btrim(coalesce(p_info,  '')), '');
  v_link  := nullif(btrim(coalesce(p_link,  '')), '');
  v_plan  := nullif(btrim(coalesce(p_plan,  '')), '');

  if length(v_coach) > 100   then raise exception '코치 이름이 너무 깁니다' using errcode = '22001'; end if;
  if length(v_gear)  > 300   then raise exception '준비물이 너무 깁니다'   using errcode = '22001'; end if;
  if length(v_info)  > 2000  then raise exception '상세 내용이 너무 깁니다' using errcode = '22001'; end if;
  if length(v_link)  > 500   then raise exception '링크가 너무 깁니다'     using errcode = '22001'; end if;
  if length(v_plan)  > 10000 then raise exception '훈련표가 너무 깁니다'   using errcode = '22001'; end if;

  -- A link is rendered as an anchor, so the scheme is checked here rather than
  -- trusted from the form. javascript: in an href is script execution.
  if v_link is not null and v_link !~* '^https?://' then
    raise exception '링크는 http:// 또는 https:// 로 시작해야 합니다' using errcode = '22023';
  end if;

  v_patch := jsonb_build_object(
    'coach', to_jsonb(v_coach),
    'gear',  to_jsonb(v_gear),
    'info',  to_jsonb(v_info),
    'link',  to_jsonb(v_link),
    'plan',  to_jsonb(v_plan)
  );

  -- Authorship of the plan is set here, never accepted from the caller. His
  -- version stores planBy as a nickname string, which is the same shape that
  -- makes notice comments unattributable once somebody renames themselves.
  if v_plan is null then
    v_patch := v_patch || jsonb_build_object('plan_by', null, 'plan_at', null);
  else
    v_patch := v_patch || jsonb_build_object('plan_by', to_jsonb(v_me), 'plan_at', to_jsonb(now()));
  end if;

  -- THE MERGE, AND THE POINT OF THE WHOLE FUNCTION. `||` replaces the keys it
  -- names and leaves every other key untouched, so historical_participants,
  -- historical_attendance, and anything a later migration adds all survive an
  -- edit. Stripping the nulls afterwards keeps absent fields absent rather than
  -- storing a jsonb null that every reader would have to special-case.
  v_details := coalesce(v_row.details, '{}'::jsonb) || v_patch;
  v_details := jsonb_strip_nulls(v_details);

  v_updated := greatest(now(), v_row.updated_at + interval '1 microsecond');

  update public.activities
     set details = v_details,
         updated_at = v_updated
   where id = p_activity_id;

  return jsonb_build_object('details', v_details, 'updated_at', v_updated);
end;
$$;

comment on function public.save_activity_details_v1(uuid, text, text, text, text, text, timestamptz) is
  'Merges the training-detail fields into activities.details, leaving keys it does not name alone.';

revoke all on function public.save_activity_details_v1(uuid, text, text, text, text, text, timestamptz) from public;
revoke all on function public.save_activity_details_v1(uuid, text, text, text, text, text, timestamptz) from anon;
grant execute on function public.save_activity_details_v1(uuid, text, text, text, text, text, timestamptz) to authenticated;
