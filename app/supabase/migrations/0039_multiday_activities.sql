-- 0039 — 다중일 일정. An activity that runs for more than one day.
--
-- His final91-multiday-calendar renders a race across a date range, and the
-- range comes from `activities.details.endDate`. This migration puts the same
-- fact in a column instead, and the reasoning is the whole point of the file.
--
-- ---------------------------------------------------------------------------
-- WHAT HIS APP ACTUALLY DOES
-- ---------------------------------------------------------------------------
-- endDate has SEVEN READS and ZERO WRITES in his client, counted across the
-- whole file:
--
--   1503  mapping a row      d.endDate || d.end_date || row.activity_date
--   3168  dateInActivityRange
--   3191  renderCalendar, expanding a race across its range
--   3234  the day panel's time label
--   3421  the race status card
--   3434  the race detail row
--   1457, 1490  the in-memory form object, which is never persisted
--
-- Nothing writes it, because his 일정 등록 screen has no end-date input at all —
-- a multi-day race can only be created from the Supabase dashboard. And his
-- registerSchedule rebuilds `details` from scratch on every save without
-- carrying endDate forward, so editing such a race in his app collapses it back
-- to one day. That is the same line and the same shape as the backfilled
-- attendance register CLAUDE.md already records, one key along.
--
-- ---------------------------------------------------------------------------
-- WHY A COLUMN RATHER THAN details.endDate
-- ---------------------------------------------------------------------------
-- 0033's header argues, correctly, that keeping his column names lets a future
-- cutover read his rows rather than a translation of them. That argument does
-- not reach this field. `board_posts` is a table whose rows carry data; a jsonb
-- key with zero writes is one whose rows do not. The only rows that can carry an
-- endDate are ones typed into his dashboard by hand, and if any exist a one-line
-- fallback at import time reads them. A cutover happens once; a schema is lived
-- in.
--
-- The decisive reason is narrower, and is about our code rather than his.
-- ActivityInput (schedule/api.ts) carries no `details` field — createActivity
-- and updateActivity never write that column at all. A details key would
-- therefore have survived an edit here *by accident*, because we happen not to
-- touch details, and the first person to add any details-writing to the edit
-- form would have had to remember to carry the end date forward. Forgetting is
-- silent. As a column it sits in ActivityInput, so the same omission is a
-- compile error — which is not hypothetical: adding this field broke the build
-- at ActivityEditPage's save call until the form was taught to send it.
--
-- Third, and smallest: the CHECK below is expressible on a column and merely
-- hoped for in jsonb. The calendar expands a range with a `while start <= end`
-- loop, and a backwards pair from any writer is an empty range or a runaway one.
--
-- ---------------------------------------------------------------------------
-- SHAPE
-- ---------------------------------------------------------------------------
-- NULL means a single-day activity, which is nearly every row. That matches how
-- his reader defaults (`d.endDate || row.activity_date`) and means this
-- migration changes no existing row's meaning.
--
-- Not restricted to kind='race'. His endDate lives only on races because his
-- form object for a race happens to carry it, but a multi-day 훈련 camp is an
-- ordinary thing for a swimming club and there is no reason in the data for the
-- restriction. The calendar expands whatever has a range.
--
-- No index. The calendar's month window filters on activity_date first, and this
-- club's activities number in the dozens — an index here would cost the write
-- path something and save the read path nothing measurable.
alter table public.activities
  add column if not exists end_date date;

-- Dropped first so a re-apply is idempotent, the same way the policies in 0021
-- and 0033 are written.
alter table public.activities
  drop constraint if exists activities_end_after_start;

-- Ordering AND finiteness. PostgreSQL's `date` type accepts 'infinity' and
-- '-infinity', which satisfy `end_date >= activity_date` perfectly well — and an
-- approved member can write their own 기타 activity straight over REST, so this
-- is reachable without staff. The client caps its expansion loop at 366 days so
-- nothing runs away, but every date comparison in the app is a STRING compare
-- against 'YYYY-MM-DD', and 'infinity' sorts after every real date: an activity
-- with that end date would be permanently "not finished", would never leave
-- 다가오는 일정, and would appear on no month of the calendar.
alter table public.activities
  add constraint activities_end_after_start
  check (
    (end_date is null or end_date >= activity_date)
    and isfinite(activity_date)
    and (end_date is null or isfinite(end_date))
  );

comment on column public.activities.end_date is
  '다중일 일정의 마지막 날. NULL이면 하루짜리 일정이다. activity_date보다 앞설 수 없다.';

-- No grant statement. activities carries table-level privileges
-- (authenticated=arwd), not column-level ones, so a new column is reachable
-- immediately — read off pg_class.relacl rather than assumed, because a
-- column-scoped grant would have left this readable and unwritable with no error
-- to say so.

-- ---------------------------------------------------------------------------
-- 4. The one server-side reader of "is this race over"
-- ---------------------------------------------------------------------------
-- race_my_history_v1 (0016) decides 종료 with `act.activity_date < today`, which
-- is the same defect the five client screens had: a three-day 대회 reads 종료 on
-- the morning of day two while the calendar still shows it running. Now that an
-- activity can span days, the last day is the one that decides.
--
-- The body below is 0016's, copied verbatim, with that single line changed —
-- reconstructing a function from a description is how 0024 silently dropped a
-- parameter and changed a conflict target.
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
           when coalesce(act.end_date, act.activity_date)
                  < (now() at time zone 'Asia/Seoul')::date then '종료'
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
  '내 대회 참가 이력. 회원은 세션에서 가져오며 인자를 받지 않는다. 여러 날에 걸친 대회는 마지막 날이 지나야 종료로 본다. 앱 도입 전 이력을 담을 테이블이 아직 없어 지금은 활동 신청 기반 내역만 돌려준다.';

-- `create or replace` keeps the existing ACL, and 0016 already granted this to
-- authenticated and revoked it from public and anon. Restated anyway, for the
-- reason 0029 and 0032 restate theirs: a fresh apply against a database that
-- somehow lacks 0016 would otherwise leave the RPC unreachable, since after 0026
-- an ungranted function is unreachable rather than public.
revoke all on function public.race_my_history_v1() from public, anon;
grant execute on function public.race_my_history_v1() to authenticated;
