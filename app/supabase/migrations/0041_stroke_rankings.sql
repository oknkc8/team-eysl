-- 0041 — 영법별 랭킹: the per-gender, per-stroke 50M ranking.
--
-- WHAT THIS PORTS, AND FROM WHERE. The release the brief named,
-- `final69-events-gender-first2026`, does not contain this feature: it has
-- `openFunEventPage` but no `stroke_rankings` and no gender split at all. The
-- gender-split stroke ranking enters at `final71-event-data-rpc` and reaches its
-- current shape at `final75-medal-rank`. Traced across every upload:
--
--   final69-events-gender-first2026   stroke_rankings 0  gender-split 0  v2 0
--   final70-force-event-refresh       0  0  0
--   final71-event-data-rpc            1  1  0
--   final75-medal-rank                1  1  1   <- current shape
--   … unchanged through final92
--
-- So the release name promises what the release does not hold, and the spec is
-- `final92:index.html:4999-5013` (`openFunEventPage('stroke')`).
--
-- WHAT HIS APP DOES. It calls one RPC, `get_team_fun_event_rankings_v2`, and
-- renders rows of {gender, stroke, nickname, rank, pb_seconds, score}: two
-- gender groups (여 then 남) x four strokes, 50M only, TOP 5 with the rest
-- behind a toggle, each row printed as `${pb_seconds}초 · ${score}점`.
--
-- **This one actually runs in his app**, which is not true of everything in that
-- file. `openFunEventPage` hangs off an onclick and calls its own RPC, so it is
-- not downstream of the `historicalTrainingRes` throw at `index.html:1631`, and
-- it reads nothing `loadPersistentContent()` populates — the RPC returns
-- nicknames directly, so there is no `members` lookup to be starved. There is
-- reference behaviour here.
--
-- WHAT WE CANNOT SEE. `get_team_fun_event_rankings_v2` lives in his Supabase
-- project. Its SQL is not in the repository and is not knowable from here, so
-- the scoring rule below comes from the sentence his own screen prints:
--
--   남녀를 따로 계산해요. 각 성별·영법의 팀내 최고 50M PB를 100점으로 두고
--   상대점수를 표시해요. 종합점수는 사용하지 않습니다.
--
-- That fixes the anchor (best in group = 100), the direction (relative to it),
-- and one explicit exclusion (no combined score across strokes). Everything
-- below that the sentence does not settle is **ours**, and is marked as such.
--
-- OURS, FIFTH: a member with no eligible result does not appear in that group at
-- all — not as a row with a null time or a zero score. `eligible` is built from
-- `records`, so somebody with no 50M meet swim simply produces no row, and the
-- screen renders the group without them. A member with a gender and no records
-- anywhere is therefore absent from all eight groups. Verified deliberately
-- rather than assumed: a synthetic member with a gender and no records does not
-- appear in the payload.
--
-- MEASURED ON THE LIVE DEV DATA, so nobody has to wonder whether the feature has
-- anything to show. 191 eligible records collapse to 65 ranked rows:
--
--   여 자유형 11   남 자유형 12
--   여 평영   10   남 평영    9
--   여 접영    7   남 접영    7
--   여 배영    5   남 배영    4
--
-- Every group has at least four swimmers, so no section is a screen with two
-- names on it.
--
-- THE TIE RULE WAS PROVED BY BUILDING A TIE. The live data contains **no tie in
-- any group**, which means correct handling and a `dense_rank` bug produce
-- identical output on it. Two synthetic members were given the same 50M 접영
-- time and the group came back:
--
--   rank  1   36.00  100.0   <- both fixtures share rank 1, both score 100
--   rank  3   38.26   94.1   <- rank 2 is SKIPPED, which is what rank() does
--   rank  4   40.00   90.0
--
-- `dense_rank()` would have emitted 2 there. The fixtures were removed.

create or replace function public.stroke_rankings_v1()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_year int;
  v_rows jsonb;
begin
  -- Same gate as team_event_rankings_v1 (0016): SECURITY DEFINER reads members
  -- and records past RLS, so the caller is checked here. current_member_id() is
  -- null for signed-out, pending, rejected and blocked alike.
  if public.current_member_id() is null then
    return jsonb_build_object('error', 'unauthorized');
  end if;

  v_year := extract(year from (now() at time zone 'Asia/Seoul')::date)::int;

  with eligible as (
    -- The category/subcategory/distance filter is his, read out of the client
    -- code that renders the equivalent PB card (final92:index.html:4715-4717):
    --   stroke === st && metadata.distance === 50
    --   && category === 'meet' && subcategory === 'personal' && seconds > 0
    -- His PB-collector note says the same in prose — 일반 개인 50M. Our columns
    -- carry distance and time properly (distance_m int, result_centiseconds
    -- int) where his live in jsonb and in text parsed at read time.
    --
    -- OURS, AND THE ONE THAT NEEDED MEASURING: the stroke is matched by prefix
    -- and folded to a canonical label, not compared for equality. The imported
    -- club workbook carries round suffixes — `배영(결승)`, `배영(예선)`,
    -- `자유형(결승)`, `평영(결승)` — and an equality test silently drops them.
    --
    -- His own file does it both ways: the PB card uses `===`
    -- (final92:index.html:4716) and `bestRecordByStroke` uses `.includes`
    -- (final92:index.html:4355), so his app does not settle it either.
    --
    -- Measured on the live dev data before choosing: 4 members have a suffixed
    -- swim, every one of them also has a plain-round swim at that stroke, and in
    -- all four the plain swim is the faster of the two. **So today this choice
    -- changes no ranking at all** — which is exactly why it is worth writing
    -- down rather than leaving to whoever notices next. The first time somebody
    -- swims a lifetime best in a final, equality matching would understate them
    -- and nothing would look wrong.
    --
    -- Prefix rather than substring (`like '자유형%'`, not `position(...) > 0`):
    -- a fin event labelled `핀 자유형` must not be folded into 자유형. Those
    -- carry category='fin' and are already excluded, but the narrower operator
    -- costs nothing and does not depend on that staying true. `개인혼영` matches
    -- no prefix and is correctly left out — it is not one of the four strokes.
    select m.id,
           m.nickname,
           m.gender,
           case
             when r.stroke like '자유형%' then '자유형'
             when r.stroke like '배영%'   then '배영'
             when r.stroke like '평영%'   then '평영'
             when r.stroke like '접영%'   then '접영'
           end as stroke,
           r.result_centiseconds
      from public.records r
      join public.members m on m.id = r.member_id
     -- OURS: `m.gender in ('남','여')`. A member with no recorded gender appears
     -- in NEITHER group rather than in a third. His screen renders exactly two
     -- groups, and inventing a third would put people on a screen his app never
     -- shows them on. The cost is real and is stated so nobody rediscovers it:
     -- a member with records and no gender is invisible here until their
     -- profile is filled in.
     where m.status = 'approved'
       and m.gender in ('남', '여')
       and r.category = 'meet'
       and r.subcategory = 'personal'
       and r.distance_m = 50
       and (r.stroke like '자유형%' or r.stroke like '배영%'
         or r.stroke like '평영%'   or r.stroke like '접영%')
  ),
  best as (
    -- OURS: one row per member per gender x stroke, their fastest eligible
    -- swim. His screen shows a member once per stroke with a single PB, so a
    -- swimmer with six 50M 자유형 results has to collapse to one; `min` is the
    -- only collapse consistent with the word PB.
    select gender, stroke, id, nickname, min(result_centiseconds) as pb
      from eligible
     group by gender, stroke, id, nickname
  ),
  scored as (
    select gender,
           stroke,
           nickname,
           -- Centiseconds are a storage detail, as 0016 already says: his client
           -- prints Number(pb_seconds).toFixed(2), so the decimal is what
           -- crosses the wire.
           round(pb::numeric / 100, 2) as pb_seconds,
           -- OURS: standard competition ranking. Ties share a rank and the next
           -- rank skips, which is what a swim meet does and what `rank()` gives
           -- for free. `dense_rank()` would have been the other defensible
           -- choice; his payload carries a `rank` field and no rule for ties.
           rank() over (partition by gender, stroke order by pb) as rank,
           -- The scoring sentence, in SQL. The group's fastest pb is the
           -- numerator: best/mine, so the best swimmer scores exactly 100.0 and
           -- everyone else falls below it. One decimal, because his client
           -- prints Number(score).toFixed(1).
           round(100.0 * min(pb) over (partition by gender, stroke) / pb, 1) as score
      from best
  )
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'gender',     gender,
               'stroke',     stroke,
               'nickname',   nickname,
               'rank',       rank,
               'pb_seconds', pb_seconds,
               'score',      score
             )
             order by gender, stroke, rank, nickname
           ),
           '[]'::jsonb
         )
    into v_rows
    from scored;

  -- One flat list rather than a nested gender -> stroke object. The screen
  -- filters it twice anyway (his does exactly that at final92:index.html:5004),
  -- and a flat list has one empty state instead of eight.
  return jsonb_build_object('year', v_year, 'rows', v_rows);
end $$;

comment on function public.stroke_rankings_v1() is
  '성별·영법별 50M 개인 기록 랭킹. 각 성별·영법의 팀내 최고 기록을 100점으로 둔 상대점수를 함께 돌려준다.';

-- Named the way 0016's is, and granted the same way: the browser calls it, and
-- nothing else needs to.
revoke all on function public.stroke_rankings_v1() from public, anon, authenticated;
grant execute on function public.stroke_rankings_v1() to authenticated;
