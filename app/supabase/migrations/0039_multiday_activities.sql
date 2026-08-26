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

alter table public.activities
  add constraint activities_end_after_start
  check (end_date is null or end_date >= activity_date);

comment on column public.activities.end_date is
  '다중일 일정의 마지막 날. NULL이면 하루짜리 일정이다. activity_date보다 앞설 수 없다.';

-- No grant statement. activities carries table-level privileges
-- (authenticated=arwd), not column-level ones, so a new column is reachable
-- immediately — read off pg_class.relacl rather than assumed, because a
-- column-scoped grant would have left this readable and unwritable with no error
-- to say so.
