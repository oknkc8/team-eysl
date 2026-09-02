-- 0045 — 대회 신청: which events a member is entering, alongside their seat.
--
-- ============================================================================
-- TWO PEOPLE MEASURED THIS AND DISAGREED. BOTH WERE RIGHT ABOUT ONE HALF.
-- ============================================================================
--
-- The disagreement was whether our schema can hold this at all.
--
--   "단체전 종목 자체가 모델링돼 있지 않다 — 대회가 어떤 종목을 여는지부터
--    새로 모델링해야 한다"                                        (media2)
--   "스키마가 이미 지원한다, 격차는 UI + API"                      (badges2)
--
-- Measured against upstream `4475128` rather than argued:
--
--   his 그룹 select        hardcoded <option>s in the markup
--   his 개인종목 1·2       hardcoded <option>s in the markup
--   his 단체전 choices     activities.details.relays
--   who writes details.relays?   NOTHING IN HIS UI. His admin form has 14
--                                controls and `relay` appears 0 times in it.
--                                The only write is `relays: old?.relays||[]`,
--                                a carry-forward on edit. It is seeded out of
--                                band, like historical_participants.
--
-- So the ANSWER a member gives is modelled and round-trips — `submitRace()`
-- writes `{group,s1,s2,relays,noRelay}` and the form reads it back to pre-fill
-- and to relabel its button 수정 완료. The QUESTION a race asks is not modelled
-- by anybody, him included. media2 was describing the question, badges2 the
-- answer. Neither had to invent a catalogue, and this migration does not.
--
-- ============================================================================
-- WHY A NEW FUNCTION AND NOT A PARAMETER ON apply_to_activity
-- ============================================================================
--
-- The obvious move is `apply_to_activity(p_activity_id, p_details)`. Reading
-- its body first is what argued against it. That function has four early
-- returns before it writes anything, and each one is load-bearing history:
--
--   participant already          return unchanged  (idempotent re-tap)
--   live offer outstanding       raise             (respond_waitlist_offer's job)
--   queued, nothing outstanding  return unchanged  (0007: re-applying must NOT
--                                                   move somebody up the queue)
--   offer spent                  falls through to rejoin at the back
--
-- Threading a details write through all four means editing every branch of the
-- one function whose branches were each added to fix a real defect. Editing an
-- entry is not a seat decision and has no business in there.
--
-- So the seat decision stays where it is, untouched, and this function CALLS it
-- rather than reimplementing it. Nothing about capacity, queue order or offers
-- is duplicated here — there is exactly one implementation of that, still.
--
-- ============================================================================
-- WHY AN RPC AT ALL, WHEN HIS CLIENT JUST UPSERTS
-- ============================================================================
--
-- `saveActivityApplication` upserts `activity_applications` straight from the
-- browser. Ours cannot: the live policy set on that table is
--
--   applications_read         SELECT  (member_id = current_member_id() OR is_staff())
--   applications_self_delete  DELETE  (member_id = current_member_id())
--
-- and nothing else. There is no INSERT or UPDATE policy, so every write already
-- goes through a SECURITY DEFINER function. An RPC is the only door, not a
-- stylistic preference.
--
-- Staff can already read what this writes — `applications_read` admits
-- `is_staff()` — so the roster screens need no policy change to show entries.
--
-- ============================================================================
-- STRICT ABOUT SHAPE, ON PURPOSE
-- ============================================================================
--
-- The column is `jsonb` and the caller is a browser, so without a check this
-- accepts anything of any size. The five keys below are his five. Unknown keys
-- are refused rather than stored: we control both ends, and a column that
-- quietly accumulates whatever a client sent is how `activities.details` ended
-- up with two sources of truth in the legacy app.

-- ---------------------------------------------------------------- the entry
create or replace function public.set_race_entry_v1(
  p_activity_id uuid,
  p_entry       jsonb
)
returns public.activity_applications
language plpgsql security definer set search_path = public
as $$
declare
  v_member uuid;
  v_kind   text;
  v_key    text;
  v_relay  jsonb;
  v_row    public.activity_applications;
begin
  v_member := public.current_member_id();
  if v_member is null then
    raise exception 'not an approved member' using errcode = '42501';
  end if;

  if p_entry is null or jsonb_typeof(p_entry) <> 'object' then
    raise exception '신청 내용을 읽을 수 없습니다' using errcode = '22023';
  end if;

  -- Race only. Trainings and 기타 have no events to enter, and letting an entry
  -- land on one would put data on a row no screen reads.
  select kind into v_kind from public.activities where id = p_activity_id;
  if not found then
    raise exception 'no such activity' using errcode = '23503';
  end if;
  if v_kind <> 'race' then
    raise exception '대회에만 종목을 신청할 수 있습니다' using errcode = '22023';
  end if;

  -- Shape. Every branch names the key it refuses so the client can say which
  -- box is wrong rather than "저장에 실패했습니다".
  for v_key in select k from jsonb_object_keys(p_entry) k loop
    if v_key not in ('group', 's1', 's2', 'relays', 'noRelay') then
      raise exception '알 수 없는 신청 항목입니다: %', v_key using errcode = '22023';
    end if;
  end loop;

  foreach v_key in array array['group', 's1', 's2'] loop
    if p_entry ? v_key and jsonb_typeof(p_entry -> v_key) not in ('string', 'null') then
      raise exception '% 은(는) 문자열이어야 합니다', v_key using errcode = '22023';
    end if;
    if coalesce(length(p_entry ->> v_key), 0) > 40 then
      raise exception '% 이(가) 너무 깁니다', v_key using errcode = '22023';
    end if;
  end loop;

  if p_entry ? 'noRelay' and jsonb_typeof(p_entry -> 'noRelay') <> 'boolean' then
    raise exception 'noRelay 는 참/거짓이어야 합니다' using errcode = '22023';
  end if;

  if p_entry ? 'relays' then
    if jsonb_typeof(p_entry -> 'relays') <> 'array' then
      raise exception '단체전 목록을 읽을 수 없습니다' using errcode = '22023';
    end if;
    if jsonb_array_length(p_entry -> 'relays') > 20 then
      raise exception '단체전은 20개까지 고를 수 있습니다' using errcode = '22023';
    end if;
    for v_relay in select value from jsonb_array_elements(p_entry -> 'relays') loop
      if jsonb_typeof(v_relay) <> 'string' or length(v_relay #>> '{}') > 40 then
        raise exception '단체전 종목 이름이 올바르지 않습니다' using errcode = '22023';
      end if;
    end loop;
  end if;

  -- The seat first, and only where there is not one already. apply_to_activity
  -- is idempotent for a seated member and deliberately does not disturb a
  -- queued one's place, so calling it here is safe on every path -- but calling
  -- it only when needed keeps this function's failure modes to its own.
  if not exists (
    select 1 from public.activity_applications
     where activity_id = p_activity_id and member_id = v_member
  ) then
    perform public.apply_to_activity(p_activity_id);
  end if;

  update public.activity_applications
     set details    = p_entry,
         updated_at = now()
   where activity_id = p_activity_id
     and member_id   = v_member
  returning * into v_row;

  if not found then
    raise exception '신청 정보를 찾지 못했습니다' using errcode = 'P0002';
  end if;

  return v_row;
end $$;

comment on function public.set_race_entry_v1(uuid, jsonb) is
  '대회 신청 종목을 저장한다. 신청이 없으면 apply_to_activity 로 자리를 먼저 잡고, 종목만 갱신한다. 자리·대기 판정은 여기서 하지 않는다.';

revoke all on function public.set_race_entry_v1(uuid, jsonb) from public;
revoke all on function public.set_race_entry_v1(uuid, jsonb) from anon;
grant execute on function public.set_race_entry_v1(uuid, jsonb) to authenticated;
