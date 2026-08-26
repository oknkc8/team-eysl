-- 0034 — 나의 성과·배지 and 월간 활동 요약.
--
-- Two read-only functions behind the screens the president shipped in
-- final72-my-achievements and final73-badge-reveal, plus the much older
-- `#activity` page. As in 0016, his call sites and render code are the entire
-- specification — the bodies of his own RPCs live in his Supabase project and
-- cannot be read from here — so what was read off his code is marked EVIDENCE
-- and what we decided because his code does not say is marked INFERENCE.
--
-- NOTHING HERE IS STORED. Every number below is derived from `attendance`,
-- `activity_applications` and `records` at read time, and that is the one design
-- decision this migration is really making. A stored badge would survive the
-- correction that should have revoked it: an admin who fixes a mis-marked 출석
-- back to 불참 drops the member under the threshold while the stored badge stays
-- lit, and nothing in the app would ever notice. This repository has been bitten
-- twice already by derived values that were written down —
-- `historical_attendance_count_legacy` is *added* to a live count (0016:155-157),
-- so a member imported twice ranks twice as high, and
-- `activities.details.participants` is rebuilt from `activity_applications` on
-- every load (0001:20-22), making the stored copy write-only. A third is not
-- needed to make the point.
--
-- ---------------------------------------------------------------------------
-- CONTRACT 1 — get_my_achievement_v1(p_member_id, p_year)  (upstream:2174)
-- ---------------------------------------------------------------------------
-- EVIDENCE, from renderMyAchievements (upstream:2166-2189):
--   * Returns a single object: the client reads data.year, data.attendance_count
--     and data.pb_moments off the value directly.
--   * data.year is numeric and is printed as `${y}년 누적 ${count}회`, so the
--     server decides the year and the screen never recomputes it.
--   * data.attendance_count is a plain integer, compared against 5/10/15/20/25.
--   * data.pb_moments is an array, guarded with `Array.isArray(...)?...:[]`.
--   * A moment row is read as {stroke, event_date, old_pb, new_pb, improvement,
--     event_name} and rendered as
--       `${Number(m.old_pb).toFixed(2)} → ${Number(m.new_pb).toFixed(2)}`
--       `▼ ${Number(m.improvement).toFixed(2)}초 단축`
--     so all three are decimal SECONDS, not centiseconds.
--   * event_date is interpolated as a bare string; event_name may be absent and
--     is defaulted to '' by the client.
--   * The five badge thresholds and their messages live in his client
--     (attendanceBadgeDefs, upstream:2144-2150), not in the payload. The server
--     therefore owes only the count, and the ladder stays a render-time concern —
--     which is also what lets a message be retuned without a migration.
--
-- INFERENCE, where his code is silent:
--
--   * NO p_member_id. His client sends currentUser.memberId from the browser
--     (upstream:2174). A function that takes a member id and answers with that
--     member's attendance and race history is one edited fetch away from being
--     every member's achievement page, and the browser is not allowed to name
--     whose row it wants — the same rule 0016's race_my_history_v1 follows, and
--     the same one CLAUDE.md draws from the member_public_v escalation closed in
--     0019. The member comes from the session. p_year survives, because a year
--     is not an identity.
--
--   * 출석 counts present AND late, matching 0016:86-88 and the legacy
--     attendance screen (`x.status==='출석'||x.status==='지각'`). Somebody who
--     turned up late still turned up, so a 지각-only member does earn badges.
--     Deliberate, and asserted in the tests, because the opposite reading is
--     just as plausible until somebody writes it down.
--
--   * The legacy counters are NOT added. members.historical_*_count_legacy are
--     pre-app totals with no dates attached (0001:35-38) and this count is
--     year-scoped — his heading says `${y}년 누적`. Folding an undated lifetime
--     total into one year would hand a long-standing member all five badges on
--     1월 1일, and is exactly the double-count 0016's half-year lists avoid.
--
--   * A PB moment is a swim that beat the member's own best in the same event
--     BEFORE it. The baseline looks back over their whole history, not merely
--     the reported year: "올해 새로 달성한 PB" (his empty state, upstream:2182)
--     is a PB set this year, not a best-of-this-year. A first-ever swim in an
--     event is not a moment — there is no old_pb to print, and
--     `Number(null).toFixed(2)` renders "0.00 → 29.50", which reads as a
--     29-second regression.
--
--   * Event identity is (stroke, distance_m). Comparing a 50 자유형 against a
--     100 자유형 would manufacture improvements nobody swam.
--
--   * category='meet' and subcategory='personal' only, and the four pool
--     strokes — the same filter, for the same reasons, as 0016:236-248. A fin
--     time or a relay leg (a flying start is worth roughly half a second) is not
--     comparable against a pool time from a standing block.
--
--   * Where a member swam an event more than once on one day, that day's fastest
--     is the one that can be a moment and the slower ones are measured against
--     it. So a heat/final pair yields one moment, not two, and a slow heat after
--     a fast final never reads as a regression. Same rule as 0016:252-254.
--
--   * distance is included in the payload even though his card prints only the
--     stroke. His render says `NEW PB · 자유형` for both a 50 and a 100, so two
--     genuine moments in one stroke reach the screen as what looks like a
--     duplicated row. The field costs nothing and lets the screen say which
--     event it was.
--
--   * Newest first. His card is a feed of things that just happened, and his
--     empty state ("첫 PB 모먼트를 만들어봐요") reads it as recent news.
--
-- ---------------------------------------------------------------------------
-- CONTRACT 2 — 월간 활동 요약  (renderActivity, upstream:3512)
-- ---------------------------------------------------------------------------
-- He has no RPC for this one: renderActivity filters the browser's own caches.
-- We have no such caches, so the same four numbers are computed in the database
-- and his filter expressions are the specification.
--
-- EVIDENCE, from renderActivity (upstream:3512) and the page markup (:1337):
--   * A month is (current year, a month stepped through with ‹ ›), and
--     summaryMonth is clamped to 1..12 by changeSummaryMonth (:3511) — the
--     arrows never cross into another year.
--   * 훈련 참여 = trainings that month where he is in t.participants.
--   * 대회 참가 = races that month where r.application is set.
--   * 기타     = events that month where he is in x.participants.
--   * 출석률   = round(present+late / marked * 100) over his attendance rows
--               that month, and 0 when nothing is marked.
--   * The closing sentence reads `${month}월에는 훈련 ${tr}회, 대회 ${ra}회,
--     기타 ${ev}회에 참여했어요.` when tr+ra+ev > 0 and
--     '이번 달 등록된 활동 내역이 없습니다.' otherwise — so the three counts,
--     not 출석률, decide whether a month is empty.
--
-- INFERENCE:
--
--   * participants means an application of type 'participant'. His client builds
--     t.participants from activity_applications and pushes waitlist rows into a
--     separate t.waitlist (upstream:1622-1626), so a waitlisted member is not a
--     participant. For races and 기타 his loop has no waitlist branch and files
--     every application row as a participant (:1628-1629); we apply the
--     participant rule to all three kinds instead, because somebody still on a
--     race waitlist has not 참가'd, and his own status vocabulary agrees — a
--     waitlisted application reads 대기, not 신청완료 (0016:404-406).
--
--   * A walk-in counts. 0030 established that the roster is not application
--     bound: attendance_mark_v1 will happily mark somebody who never applied,
--     and reading participation off applications alone silently loses them. So
--     participation is "has a participant application OR was marked present or
--     late", the same union 0030 settled on.
--
--   * The month is selected on activities.activity_date, the only date these
--     rows carry.
--
--   * 출석률 is over marked rows only. A training nobody got round to marking is
--     not a 불참, it is an unanswered question, and counting it as a miss would
--     charge members for an admin's backlog. This matches his `ar` — the rows
--     that exist — rather than a denominator of every training that month.

-- ---------------------------------------------------------------------------
-- 1. 나의 성과 — 출석 배지 집계와 PB 모먼트
-- ---------------------------------------------------------------------------
create or replace function public.my_achievement_v1(p_year int default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_member  uuid;
  v_year    int;
  v_from    date;
  v_to      date;
  v_count   int;
  v_moments jsonb;
begin
  -- SECURITY DEFINER reads attendance and records past RLS, so the caller is
  -- checked here instead. current_member_id() is null for anyone who is not an
  -- approved member, which covers signed-out, pending, rejected and blocked in
  -- one condition.
  v_member := public.current_member_id();
  if v_member is null then
    return jsonb_build_object('error', 'unauthorized');
  end if;

  -- Asia/Seoul, not UTC. At 08:00 KST on 1월 1일 the server clock still reads
  -- 12월 31일, and a badge screen that rolls over a day late on New Year is the
  -- kind of wrong that looks fine.
  v_year := coalesce(p_year, extract(year from (now() at time zone 'Asia/Seoul')::date)::int);

  if v_year < 1900 or v_year > 2999 then
    raise exception '연도가 올바르지 않습니다.' using errcode = '22023';
  end if;

  v_from := make_date(v_year, 1, 1);
  v_to   := make_date(v_year, 12, 31);

  select count(*)
    into v_count
    from public.attendance a
    join public.activities act on act.id = a.activity_id
   where a.member_id = v_member
     and a.status in ('present', 'late')
     and act.activity_date between v_from and v_to;

  with rec as (
    select r.stroke,
           r.distance_m,
           r.event_date,
           r.event_name,
           r.result_centiseconds
      from public.records r
     where r.member_id   = v_member
       and r.category    = 'meet'
       and r.subcategory = 'personal'
       and r.stroke in ('자유형', '배영', '평영', '접영')
  ),
  -- One row per event per day, holding that day's fastest swim. Collapsing the
  -- day first is what turns a heat/final pair into a single moment instead of
  -- two, and stops the slower of the pair reading as a regression.
  --
  -- `distinct on` rather than group-by-with-aggregates, and the difference
  -- matters. min(result_centiseconds) and min(event_name) are computed
  -- INDEPENDENTLY: where a member swam the same event at two meets on one day,
  -- the fastest time would be paired with whichever meet name happened to sort
  -- first, and the card would credit the wrong competition. Taking a whole row,
  -- ordered by the time, keeps the name attached to the swim it describes.
  --
  -- event_name is the final tiebreak so the choice stays deterministic when two
  -- rows match on everything before it.
  per_day as (
    select distinct on (stroke, distance_m, event_date)
           stroke,
           distance_m,
           event_date,
           result_centiseconds,
           event_name
      from rec
     order by stroke, distance_m, event_date, result_centiseconds, event_name
  ),
  with_baseline as (
    select p.*,
           -- The best over every STRICTLY EARLIER day in the same event. The
           -- frame excludes the current row, which is what makes this "the PB
           -- they had to beat" rather than "the PB including this swim".
           min(result_centiseconds) over (
             partition by stroke, distance_m
             order by event_date
             rows between unbounded preceding and 1 preceding
           ) as prev_best
      from per_day p
  ),
  moments as (
    select stroke,
           distance_m,
           event_date,
           event_name,
           prev_best,
           result_centiseconds
      from with_baseline
     where prev_best is not null
       and result_centiseconds < prev_best
       and event_date between v_from and v_to
  )
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'stroke',      stroke,
               'distance',    distance_m,
               'event_date',  to_char(event_date, 'YYYY-MM-DD'),
               'event_name',  coalesce(event_name, ''),
               -- Centiseconds are a storage detail. His client prints
               -- Number(x).toFixed(2), so these cross the wire as seconds.
               'old_pb',      round(prev_best::numeric / 100, 2),
               'new_pb',      round(result_centiseconds::numeric / 100, 2),
               'improvement', round((prev_best - result_centiseconds)::numeric / 100, 2)
             )
             order by event_date desc, result_centiseconds
           ),
           '[]'::jsonb
         )
    into v_moments
    from moments;

  return jsonb_build_object(
    'year',             v_year,
    'attendance_count', v_count,
    'pb_moments',       v_moments
  );
end $$;

comment on function public.my_achievement_v1(int) is
  '나의 출석 배지 집계와 PB 모먼트. 회원은 세션에서 가져오며 인자로 받지 않는다. 출석 횟수는 해당 연도의 출석·지각 합계이고 앱 도입 전 legacy 카운터는 더하지 않는다. PB 모먼트는 같은 영법·거리에서 이전 최고 기록을 깬 날만 담는다.';

-- ---------------------------------------------------------------------------
-- 2. 월간 활동 요약
-- ---------------------------------------------------------------------------
create or replace function public.my_monthly_activity_v1(p_year int, p_month int)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_member   uuid;
  v_from     date;
  v_to       date;
  v_training int;
  v_race     int;
  v_other    int;
  v_marked   int;
  v_present  int;
begin
  v_member := public.current_member_id();
  if v_member is null then
    return jsonb_build_object('error', 'unauthorized');
  end if;

  if p_year is null or p_month is null then
    raise exception '연도와 월이 필요합니다.' using errcode = '22023';
  end if;
  if p_month < 1 or p_month > 12 then
    raise exception '월이 올바르지 않습니다.' using errcode = '22023';
  end if;
  if p_year < 1900 or p_year > 2999 then
    raise exception '연도가 올바르지 않습니다.' using errcode = '22023';
  end if;

  v_from := make_date(p_year, p_month, 1);
  v_to   := (v_from + interval '1 month' - interval '1 day')::date;

  -- Participation, per 0030: a participant application, or an attendance mark
  -- saying they turned up. A walk-in has the second and not the first, and
  -- counting applications alone would lose them.
  with mine as (
    select act.id, act.kind
      from public.activities act
     where act.activity_date between v_from and v_to
       and (
         exists (
           select 1
             from public.activity_applications ap
            where ap.activity_id      = act.id
              and ap.member_id        = v_member
              and ap.application_type = 'participant'
         )
         or exists (
           select 1
             from public.attendance a
            where a.activity_id = act.id
              and a.member_id   = v_member
              and a.status in ('present', 'late')
         )
       )
  )
  select count(*) filter (where kind = 'training'),
         count(*) filter (where kind = 'race'),
         count(*) filter (where kind = 'event')
    into v_training, v_race, v_other
    from mine;

  -- 출석률 is over rows that were actually marked. An unmarked training is an
  -- unanswered question, not a 불참, and folding it into the denominator would
  -- charge members for an admin's backlog.
  select count(*),
         count(*) filter (where a.status in ('present', 'late'))
    into v_marked, v_present
    from public.attendance a
    join public.activities act on act.id = a.activity_id
   where a.member_id = v_member
     and act.activity_date between v_from and v_to;

  return jsonb_build_object(
    'year',               p_year,
    'month',              p_month,
    'training_count',     v_training,
    'race_count',         v_race,
    'other_count',        v_other,
    'attendance_marked',  v_marked,
    'attendance_present', v_present,
    -- Integer percent, matching his Math.round(...*100). 0 when nothing is
    -- marked, which is his `ar.length ? ... : 0`.
    'attendance_rate',    case when v_marked = 0 then 0
                               else round(v_present::numeric * 100 / v_marked)::int
                          end
  );
end $$;

comment on function public.my_monthly_activity_v1(int, int) is
  '월간 활동 요약. 회원은 세션에서 가져온다. 참여는 참가 신청 또는 출석·지각 기록 중 하나만 있어도 인정하며(0030), 출석률의 분모는 실제로 체크된 기록만 센다.';

-- ---------------------------------------------------------------------------
-- 3. Execution rights
-- ---------------------------------------------------------------------------
-- `revoke ... from public` alone has been wrong here three times: it drops the
-- PUBLIC pseudo-role's grant and leaves the separate grants Supabase hands to
-- anon and authenticated untouched, so anon keeps EXECUTE while the revoke reads
-- as if it worked. Every role is named. 0026 closed the default privileges for
-- functions created after it, so this is belt and braces rather than the only
-- layer — but both functions answer with one member's attendance and race
-- history, and a function like that reachable by anon leaks to anyone holding
-- the publishable key.
revoke all on function public.my_achievement_v1(int)           from public, anon, authenticated;
revoke all on function public.my_monthly_activity_v1(int, int) from public, anon, authenticated;

-- authenticated is the widest role Supabase has and it includes members still
-- waiting on approval; current_member_id() inside each function is what actually
-- holds the line, and it answers only for the caller's own row.
grant execute on function public.my_achievement_v1(int)           to authenticated;
grant execute on function public.my_monthly_activity_v1(int, int) to authenticated;
