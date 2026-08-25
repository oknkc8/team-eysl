-- 0016 — team event rankings (출석왕·지각왕·단축왕) and a member's own race history.
--
-- Both functions stand in for RPCs the president added upstream whose bodies
-- live in his Supabase project and are not readable from here. His call sites
-- and render code are therefore the entire specification, and the contract
-- below was reconstructed from them. What was read off his code is marked
-- EVIDENCE; what we decided because his code does not say is marked INFERENCE.
-- Nobody can spot a wrong aggregation rule by eye on a leaderboard, so the
-- guesses are labelled rather than blended in with the facts.
--
-- ---------------------------------------------------------------------------
-- CONTRACT 1 — get_team_event_rankings_v2()  (upstream-index.html:4147)
-- ---------------------------------------------------------------------------
-- EVIDENCE, from getTeamEventRankingData :4146 and openEventRankingPage :4159:
--   * Returns a single object, not a row set: the client reads data.year,
--     data.attendance, data.late and data.improvements off the value directly.
--   * `if(error||!data||data.error)` — an object carrying an `error` key is a
--     failure the client already handles, so the unauthorised path below
--     returns {"error": ...} rather than raising.
--   * data.year is numeric: the improvements heading computes `data.year-1`.
--   * data.attendance and data.late each have .lifetime, .h1 and .h2, labelled
--     누적 / ${year} 상반기 / ${year} 하반기 (:4168, :4171).
--   * A ranking row is {rank, nickname, count}; eventRankRows :4151 prints
--     `${r.rank||i+1}`, escHtml(r.nickname) and `${r.count}회`.
--   * An improvement row is {rank, nickname, stroke, distance, seconds};
--     improvementRows :4155 prints `${r.distance}M · ▼ ${Number(r.seconds)
--     .toFixed(2)}초`. The key is `distance`, not distance_m, and `seconds` is
--     a decimal number, not centiseconds.
--   * data.improvements has .within_year and .yoy_pb (:4174-4175), headed
--     "${year}년 올해 안에서 가장 많이 단축" and "${year-1}년 PB 대비 ${year}년
--     PB 단축" (:4178).
--   * Improvement rows are grouped client-side into exactly four strokes,
--     자유형·배영·평영·접영 (:4176), by exact string equality on r.stroke.
--   * Every list is sliced to the top 5 client-side (:4152, :4156).
--   * `Array.isArray(imp)?imp:(imp.within_year||[])` at :4174 is compatibility
--     with the v1 shape we never saw, in which improvements was a bare array.
--     We emit the v2 object shape only.
--
-- INFERENCE, where his code is silent:
--   * Rank is per stroke inside the improvement lists, not global. His client
--     filters a flat list down to one stroke and then prints r.rank verbatim,
--     so a globally-ranked list would render as 1, 4, 7, 8, 12 under 자유형.
--     Per-stroke ranking is the only reading that makes his output sensible.
--   * Ten rows per list, not five. His client slices five; sending a few spare
--     costs nothing and leaves room to widen the screen later.
--
-- ---------------------------------------------------------------------------
-- The half-year split
-- ---------------------------------------------------------------------------
-- H1 is 1월 1일–6월 30일 and H2 is 7월 1일–12월 31일 of the year this function
-- reports — the plain calendar reading of 상반기/하반기.
--
-- Why: his client prints the labels as `${data.year} 상반기` and `${data.year}
-- 하반기` and computes nothing itself, so the only constraint his code places on
-- the boundary is that both halves belong to the year it displays. 상반기/하반기
-- in ordinary Korean usage means the calendar halves, and this club has no
-- season that starts anywhere else: activities carry a plain activity_date with
-- no season column for a season boundary to be derived from. A swim-season
-- split (a 9월 start, say) would be a guess with nothing behind it.
--
-- Because the boundary is ours rather than one his RPC dictates, the year is
-- returned in the payload instead of being recomputed in the browser. The
-- server's windows and the screen's headings then cannot drift apart, whatever
-- the boundary later turns out to be.
--
-- The year is taken in Asia/Seoul, not UTC. On 1월 1일 08:00 KST the server
-- clock still reads 12월 31일, and a rankings screen that resets a day late on
-- New Year is exactly the kind of wrong that looks fine.
--
-- ---------------------------------------------------------------------------
-- Ties
-- ---------------------------------------------------------------------------
-- Standard competition ranking: tied members share the smaller rank and the
-- next distinct count skips the numbers they used up — two members on 40회 are
-- both rank 1 and the next is rank 3, never rank 2. That is rank(), not
-- dense_rank() and not row_number().
--
-- Display order inside a tie is by nickname, so the rows do not reshuffle
-- between refreshes. That matters more than it sounds: the client shows a top
-- five off a longer list, so an unordered tie sitting on the cut line would
-- show different people on every load.
--
-- ---------------------------------------------------------------------------
-- What counts
-- ---------------------------------------------------------------------------
-- 출석 counts present AND late, because the legacy screen counts them that way
-- (`x.status==='출석'||x.status==='지각'` in renderAttendance, upstream :2927).
-- Somebody who turned up late still turned up. 지각 counts late only.
--
-- Lifetime adds members.historical_*_count_legacy to what the attendance table
-- holds, which is what 0001 says those columns are for: pre-app history frozen
-- at cutover, with everything since counted from rows. The half-year lists
-- cannot include them — the legacy counters are totals with no dates attached —
-- so h1 + h2 will not add up to lifetime for anyone who swam here before the
-- cutover. That is correct rather than an accounting slip.
--
-- Only status='approved' members are ranked. Blocking is how this club removes
-- somebody; leaving them on a leaderboard would undo that.
--
-- Zero is not a rank. A member with no attendance is absent from the list
-- rather than sitting at the bottom on 0회.

-- ---------------------------------------------------------------------------
-- 1. Team event rankings
-- ---------------------------------------------------------------------------
create or replace function public.team_event_rankings_v1()
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_year         int;
  v_h1_from      date;
  v_h1_to        date;
  v_h2_from      date;
  v_h2_to        date;
  v_counts       jsonb;
  v_improvements jsonb;
begin
  -- SECURITY DEFINER reads members, attendance and records past RLS, so the
  -- caller is checked here instead. current_member_id() is null for anyone who
  -- is not an approved member, which covers signed-out, pending, rejected and
  -- blocked in one condition.
  if public.current_member_id() is null then
    return jsonb_build_object('error', 'unauthorized');
  end if;

  v_year    := extract(year from (now() at time zone 'Asia/Seoul')::date)::int;
  v_h1_from := make_date(v_year, 1, 1);
  v_h1_to   := make_date(v_year, 6, 30);
  v_h2_from := make_date(v_year, 7, 1);
  v_h2_to   := make_date(v_year, 12, 31);

  -- 출석왕 · 지각왕. All six lists come out of one pass: the per-member tally is
  -- unpivoted into (metric, period, nickname, count) rows, ranked within each
  -- bucket, then folded back into the nested object his client reads.
  with roster as (
    select m.id,
           m.nickname,
           m.historical_attendance_count_legacy as legacy_present,
           m.historical_late_count_legacy       as legacy_late
      from public.members m
     where m.status = 'approved'
  ),
  marks as (
    select a.member_id, act.activity_date, a.status
      from public.attendance a
      join public.activities act on act.id = a.activity_id
  ),
  tally as (
    -- LEFT JOIN, so a member with nothing marked yet still reaches the tally at
    -- zero and is dropped by the `> 0` filter below rather than by the join.
    select r.id,
           r.nickname,
           r.legacy_present
             + count(*) filter (where k.status in ('present', 'late')) as lifetime_present,
           r.legacy_late
             + count(*) filter (where k.status = 'late')               as lifetime_late,
           count(*) filter (
             where k.status in ('present', 'late')
               and k.activity_date between v_h1_from and v_h1_to)      as h1_present,
           count(*) filter (
             where k.status in ('present', 'late')
               and k.activity_date between v_h2_from and v_h2_to)      as h2_present,
           count(*) filter (
             where k.status = 'late'
               and k.activity_date between v_h1_from and v_h1_to)      as h1_late,
           count(*) filter (
             where k.status = 'late'
               and k.activity_date between v_h2_from and v_h2_to)      as h2_late
      from roster r
      left join marks k on k.member_id = r.id
     group by r.id, r.nickname, r.legacy_present, r.legacy_late
  ),
  unpivoted as (
    select 'attendance'::text as metric, 'lifetime'::text as period,
           nickname, lifetime_present as tally_count                  from tally
    union all select 'attendance', 'h1',       nickname, h1_present    from tally
    union all select 'attendance', 'h2',       nickname, h2_present    from tally
    union all select 'late',       'lifetime', nickname, lifetime_late from tally
    union all select 'late',       'h1',       nickname, h1_late       from tally
    union all select 'late',       'h2',       nickname, h2_late       from tally
  ),
  ranked as (
    select metric,
           period,
           nickname,
           tally_count,
           -- Ties share a rank; the next distinct count skips.
           rank() over (partition by metric, period order by tally_count desc) as tally_rank,
           -- Nickname breaks the tie for display order only, so the top-five
           -- cut is the same list on every load.
           row_number() over (
             partition by metric, period
             order by tally_count desc, nickname
           ) as slot
      from unpivoted
     where tally_count > 0
  ),
  -- Every metric/period pair is listed so an empty bucket still arrives as [],
  -- rather than going missing from the object and reaching the screen as
  -- undefined. A fresh season with nothing recorded yet is a legitimate state,
  -- not an error.
  pairs (metric, period) as (
    values ('attendance'::text, 'lifetime'::text), ('attendance', 'h1'), ('attendance', 'h2'),
           ('late', 'lifetime'), ('late', 'h1'), ('late', 'h2')
  ),
  lists as (
    select p.metric,
           p.period,
           coalesce(
             jsonb_agg(
               jsonb_build_object('rank', r.tally_rank, 'nickname', r.nickname, 'count', r.tally_count)
               order by r.slot
             ) filter (where r.nickname is not null),
             '[]'::jsonb
           ) as entries
      from pairs p
      left join ranked r
        on r.metric = p.metric and r.period = p.period and r.slot <= 10
     group by p.metric, p.period
  ),
  by_metric as (
    select metric, jsonb_object_agg(period, entries) as periods
      from lists
     group by metric
  )
  select jsonb_object_agg(metric, periods) into v_counts from by_metric;

  -- 단축왕. Two lists over the same base rows.
  with rec as (
    -- category='meet' only. Comparing a meet time against a fin swim or a
    -- practice time would invent improvements nobody made, and the legacy
    -- record screen already computes bests one category at a time
    -- (effectiveRecordCategory(r)===recordMajor, upstream :2918).
    --
    -- subcategory='personal' only: a relay leg starts from a flying push worth
    -- roughly half a second, the same reason derive.ts keeps subcategory in its
    -- event key.
    --
    -- The stroke filter is exact equality on the four his client groups by, not
    -- a LIKE. '핀 자유형' is a different stroke that a LIKE would fold into
    -- 자유형 and compare against pool times.
    select rc.member_id, rc.stroke, rc.distance_m, rc.event_date, rc.result_centiseconds
      from public.records rc
      join public.members m on m.id = rc.member_id and m.status = 'approved'
     where rc.category = 'meet'
       and rc.subcategory = 'personal'
       and rc.stroke in ('자유형', '배영', '평영', '접영')
  ),
  within_year as (
    -- Improvement across this year = the first time they swam the event this
    -- year, minus their best of the year. Where the earliest date holds more
    -- than one swim (a heat and a final) the baseline is the faster of the two,
    -- so a bad heat cannot inflate somebody's improvement.
    --
    -- No minimum swim count is imposed: baseline > best already requires two
    -- swims, and a lone swim collapses to a delta of 0 and drops out on its
    -- own. Same-day improvement counts, because it is real.
    select member_id,
           stroke,
           distance_m,
           (array_agg(result_centiseconds order by event_date, result_centiseconds))[1]
             - min(result_centiseconds) as delta
      from rec
     where event_date between make_date(v_year, 1, 1) and make_date(v_year, 12, 31)
     group by member_id, stroke, distance_m
  ),
  yoy_pb as (
    -- Last year's best for the event against this year's. "PB" in his heading
    -- is year-scoped, not all-time — it reads ${year-1}년 PB 대비 ${year}년 PB.
    -- Needing a swim in both years is what makes the comparison exist at all;
    -- a null on either side falls out at the `> 0` filter below.
    select member_id,
           stroke,
           distance_m,
           min(result_centiseconds) filter (where event_date < make_date(v_year, 1, 1))
             - min(result_centiseconds) filter (where event_date >= make_date(v_year, 1, 1)) as delta
      from rec
     where event_date between make_date(v_year - 1, 1, 1) and make_date(v_year, 12, 31)
     group by member_id, stroke, distance_m
  ),
  candidates as (
    select 'within_year'::text as list, member_id, stroke, distance_m, delta
      from within_year where delta > 0
    union all
    select 'yoy_pb', member_id, stroke, distance_m, delta
      from yoy_pb      where delta > 0
  ),
  -- One row per member per stroke, carrying the event that improved most.
  -- Otherwise a swimmer who dropped time at 50, 100 and 200 자유형 takes three
  -- of the five visible slots and reads as a duplicated row. The distance field
  -- exists to say which event the number came from, which only means something
  -- if there is a single row to attach it to.
  best_per_stroke as (
    select distinct on (list, member_id, stroke)
           list, member_id, stroke, distance_m, delta
      from candidates
     order by list, member_id, stroke, delta desc, distance_m
  ),
  ranked_improvements as (
    select b.list,
           m.nickname,
           b.stroke,
           b.distance_m,
           b.delta,
           -- Per stroke, because the client filters by stroke and then prints
           -- this number as-is.
           rank() over (partition by b.list, b.stroke order by b.delta desc) as imp_rank,
           row_number() over (
             partition by b.list, b.stroke
             order by b.delta desc, m.nickname
           ) as slot
      from best_per_stroke b
      join public.members m on m.id = b.member_id
  ),
  imp_lists (list) as (values ('within_year'::text), ('yoy_pb'))
  select coalesce(
           jsonb_object_agg(
             l.list,
             coalesce(
               (select jsonb_agg(
                         jsonb_build_object(
                           'rank',     r.imp_rank,
                           'nickname', r.nickname,
                           'stroke',   r.stroke,
                           'distance', r.distance_m,
                           -- Centiseconds are a storage detail; his client
                           -- prints Number(seconds).toFixed(2).
                           'seconds',  round(r.delta::numeric / 100, 2)
                         )
                         order by r.stroke, r.slot
                       )
                  from ranked_improvements r
                 where r.list = l.list and r.slot <= 10),
               '[]'::jsonb
             )
           ),
           '{}'::jsonb
         ) into v_improvements
    from imp_lists l;

  return jsonb_build_object(
    'year',         v_year,
    'attendance',   coalesce(v_counts -> 'attendance', '{}'::jsonb),
    'late',         coalesce(v_counts -> 'late',       '{}'::jsonb),
    'improvements', v_improvements
  );
end $$;

comment on function public.team_event_rankings_v1() is
  '팀 이벤트 랭킹(출석왕·지각왕·단축왕). 상·하반기는 달력 기준이고 연도는 Asia/Seoul 기준으로 계산한다. 동점은 공동 순위이며 다음 순위는 그만큼 건너뛴다.';

-- ---------------------------------------------------------------------------
-- 2. A member's own race history
-- ---------------------------------------------------------------------------
-- CONTRACT 2 — get_my_race_history_v1()  (upstream-index.html:1371)
--
-- EVIDENCE:
--   * Takes no arguments (`dbClient.rpc('get_my_race_history_v1')`, :1371) and
--     is only called when currentUser.memberId is set, so the member comes from
--     the session — the same shape as attendance_my_history_v1 in 0001, and
--     unlike the legacy member_history_v4(p_member_id), which takes an
--     arbitrary id from the browser.
--   * Returns a row set: `(raceHistoryRes?.data||[]).map(...)` at :1411.
--   * Each row is read as {title, activity_date, status, source}, defaulting to
--     '대회' / '' / '종료' / 'history' when a field is missing.
--   * renderMyStatusList :2741 merges these rows with live applications built
--     from activity_applications, dedupes on `${title}|${date}` and keeps the
--     first occurrence — live applications are concatenated first, so a live
--     row always wins over a historical row for the same meet.
--   * The merged row carries id:null for historical entries, which is what
--     makes 상세보기 fall back to the records screen instead of opening a
--     schedule detail page for an activity that no longer exists.
--   * `source` is captured but never branched on in his render: the dedupe key
--     is title|date and the button switches on r.id. It is there to tell the
--     two halves apart, not to drive layout.
--
-- INFERENCE:
--   * source='application' for a row backed by a live activity_applications
--     row. His client hardcodes exactly that string for the half it builds
--     itself (:2741) and defaults the RPC's half to 'history', so those two
--     values are the whole vocabulary.
--   * status mirrors what his client would compute: 종료 once the date has
--     passed, 대기 for a waitlisted application, otherwise 신청완료.
--
-- WHAT IS MISSING — the historical half. Our schema has nowhere to record races
-- a member swam before this app existed: members.historical_*_count_legacy
-- carry attendance and lateness only, as bare totals with no per-meet rows and
-- no dates. So this function serves the live half and returns nothing for the
-- historical half until there is somewhere to put it. Those rows are not being
-- filtered out; there is nothing there to filter.
create or replace function public.race_my_history_v1()
returns table (
  title         text,
  activity_date date,
  status        text,
  source        text
)
language sql stable security definer set search_path = public
as $$
  select act.title,
         act.activity_date,
         case
           when app.application_type = 'waitlist' then '대기'
           when act.activity_date < (now() at time zone 'Asia/Seoul')::date then '종료'
           else '신청완료'
         end,
         'application'::text
    from public.activity_applications app
    join public.activities act on act.id = app.activity_id
   where app.member_id = public.current_member_id()
     and act.kind = 'race'
   order by act.activity_date desc
$$;

comment on function public.race_my_history_v1() is
  '내 대회 참가 이력. 회원은 세션에서 가져오며 인자를 받지 않는다. 앱 도입 전 이력을 담을 테이블이 아직 없어 지금은 활동 신청 기반 내역만 돌려준다.';

-- ---------------------------------------------------------------------------
-- 3. Execution rights
-- ---------------------------------------------------------------------------
-- `revoke ... from public` alone has been wrong here three times: it drops the
-- PUBLIC pseudo-role's grant and leaves the separate grants Supabase hands to
-- anon and authenticated, so anon keeps EXECUTE while the revoke reads as if it
-- worked. Both roles are named explicitly below, and 0014's default-privileges
-- revoke covers functions created after it — belt and braces, because a
-- rankings function answering anon would publish every member's nickname and
-- attendance to anyone holding the publishable key.
revoke all on function public.team_event_rankings_v1() from public;
revoke all on function public.race_my_history_v1()     from public;
revoke all on function public.team_event_rankings_v1() from anon;
revoke all on function public.race_my_history_v1()     from anon;

-- Rankings show other approved members' nicknames and counts to every approved
-- member, which is what his app does. current_member_id() inside the function
-- is what holds that line: authenticated is the widest role Supabase has, and
-- it includes members still waiting on approval.
grant execute on function public.team_event_rankings_v1() to authenticated;
grant execute on function public.race_my_history_v1()     to authenticated;
