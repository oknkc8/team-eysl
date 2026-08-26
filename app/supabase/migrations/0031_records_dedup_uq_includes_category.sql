-- 0031 — records_dedup_uq learns about category.
--
-- THE DEFECT.
--
-- records_dedup_uq (0004:94) is unique on
--
--     (member_id, stroke, subcategory, event_date, distance_m, result_centiseconds)
--
-- and `category` is not in it. The club swims 일반 meets, 핀 (fin) meets and
-- 기타 events, and 0004 already models that distinction — records.category is a
-- CHECKed ('meet','fin','other') column, and 0016's 단축왕 deliberately reads
-- category='meet' only, because "comparing a meet time against a fin swim or a
-- practice time would invent improvements nobody made".
--
-- So the schema says a fin swim and a pool swim are different results, and this
-- index says two results agreeing on everything else are the same row. Those
-- cannot both be true.
--
-- It is not hypothetical. The club master workbook carries one meet in two
-- sections: 2026 수원 연맹회장배 appears under 일반 with a date, and again under
-- 핀 marked (단체전만), on that same date. A member swimming the same event in
-- the same time at both would have the fin result silently discarded — and a
-- row-count check cannot see it, because counting rows that arrived says
-- nothing about rows that should have.
--
-- WHY THE INDEX AND NOT JUST THE IMPORTER.
--
-- The importer has to collapse on this key too, since Postgres refuses an
-- INSERT whose own VALUES list hits one conflict key twice. But fixing only the
-- importer would leave upsert_record() — the path the app itself uses when an
-- admin uploads a meet sheet — still merging a fin result into a pool one. The
-- rule lives in the index, so the index is what changes.
--
-- WHAT THIS COSTS.
--
-- The key gets weaker: pairs that used to collide no longer do. That is the
-- point, and it cannot orphan existing rows — a superset key admits everything
-- the narrower one did, so the new index builds over current data with no
-- possible violation. Nothing is backfilled and nothing is deleted.

drop index if exists public.records_dedup_uq;

-- category sits second, beside member_id, because that is the prefix real
-- queries use: 0016's 단축왕 filters on category before anything else. Column
-- order does not affect uniqueness, and ON CONFLICT matches an index by column
-- *set* rather than by order, so this choice is purely about making the index
-- useful for lookups as well as for the constraint.
create unique index records_dedup_uq
  on public.records (
    member_id, category, stroke, subcategory, event_date, distance_m, result_centiseconds
  );

comment on index public.records_dedup_uq is
  '같은 사람의 같은 부문·종목·날짜·거리·기록은 유일하다. category가 빠지면 핀 기록이 일반 기록에 흡수된다.';

-- ---------------------------------------------------------------------------
-- upsert_record() has to move with it.
--
-- Its ON CONFLICT names the old column list, and ON CONFLICT requires a unique
-- index matching the columns it names. Dropping the old index without this
-- would leave every call raising 42P10 "no unique or exclusion constraint
-- matching the ON CONFLICT specification" — the admin record-upload screen
-- failing on its first row, with a message naming neither this migration nor
-- the index.
--
-- The body below is the live definition read out of pg_get_functiondef, with
-- FOUR lines changed and nothing else touched. All four follow from the key:
--
--   1. the advisory lock key      — must cover the same grain as the index, or
--                                   two categories serialise on one lock
--   2. the stale-placeholder scan — without category a '.00' fin placeholder is
--                                   deleted by a sharper *pool* reading
--   3. the ON CONFLICT list       — mandatory; 42P10 otherwise
--   4. the post-conflict re-read  — without category it can hand back the other
--                                   category's row as if it were the one just
--                                   written
--
-- Reconstructing a body from a description is how 0024 silently dropped a
-- parameter and changed a conflict target. This one was copied, not rewritten.
-- ---------------------------------------------------------------------------

create or replace function public.upsert_record(
  p_member_id uuid,
  p_category text,
  p_subcategory text,
  p_stroke text,
  p_distance_m integer,
  p_event_date date,
  p_result_display text,
  p_result_centiseconds integer,
  p_event_name text default ''::text,
  p_teammates text[] default '{}'::text[],
  p_metadata jsonb default '{}'::jsonb,
  p_upload_id uuid default null::uuid
)
returns public.records
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_lock_key bigint;
  v_stale_id uuid;
  v_row      public.records;
begin
  if not public.can_manage_records() then
    raise exception 'only staff or coach may record results' using errcode = '42501';
  end if;
  if p_category not in ('meet','fin','other') then
    raise exception 'invalid category: %', p_category using errcode = '22023';
  end if;
  if p_result_centiseconds is null or p_result_centiseconds <= 0 then
    raise exception 'invalid result_centiseconds' using errcode = '22023';
  end if;

  -- (1) category joins the lock key, so one lock covers exactly one index row.
  v_lock_key := hashtextextended(
    p_member_id::text || '|' || p_category || '|' || p_stroke || '|' ||
    coalesce(p_subcategory,'personal') || '|' ||
    p_event_date::text || '|' || p_distance_m::text, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  -- Replace an imprecise placeholder once a sharper reading for the same swim
  -- arrives, e.g. a bare ".00" pulled from a merged cell.
  -- (2) category, so a fin placeholder is only ever replaced by a fin reading.
  select id into v_stale_id
    from public.records
   where member_id = p_member_id and category = p_category and stroke = p_stroke
     and subcategory = coalesce(p_subcategory,'personal')
     and event_date = p_event_date and distance_m = p_distance_m
     and result_display like '%.00' and p_result_display not like '%.00'
   limit 1;
  if v_stale_id is not null then
    delete from public.records where id = v_stale_id;
  end if;

  insert into public.records (
    member_id, category, subcategory, stroke, distance_m, event_name, event_date,
    result_display, result_centiseconds, teammates, metadata, upload_id, created_by
  ) values (
    p_member_id, p_category, coalesce(p_subcategory,'personal'), p_stroke, p_distance_m,
    coalesce(p_event_name,''), p_event_date, p_result_display, p_result_centiseconds,
    coalesce(p_teammates,'{}'), coalesce(p_metadata,'{}'::jsonb), p_upload_id, public.current_member_id()
  )
  -- (3) matches records_dedup_uq above. These two lists change together.
  on conflict (member_id, category, stroke, subcategory, event_date, distance_m, result_centiseconds) do nothing
  returning * into v_row;

  if v_row.id is null then
    -- (4) category, or this hands back the other category's row.
    select * into v_row from public.records
     where member_id = p_member_id and category = p_category and stroke = p_stroke
       and subcategory = coalesce(p_subcategory,'personal')
       and event_date = p_event_date and distance_m = p_distance_m
       and result_centiseconds = p_result_centiseconds
     limit 1;
  end if;

  return v_row;
end $function$;

-- CREATE OR REPLACE preserves the ACL, so the existing grant still stands.
-- Restated anyway, per the convention 0030 follows: 0026 made a function
-- unreachable until somebody grants it on purpose, and the grant that keeps
-- this one reachable belongs in the migration that last touched it. Read off
-- pg_proc.proacl before writing: authenticated=X, plus service_role and
-- postgres by ownership.
grant execute on function public.upsert_record(
  uuid, text, text, text, integer, date, text, integer, text, text[], jsonb, uuid
) to authenticated;
