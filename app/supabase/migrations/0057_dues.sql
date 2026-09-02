-- 0057 — 회비. Two kinds of money the club actually collects, and the derived
-- arithmetic that the president's spreadsheet shows in columns but that nothing
-- here stores.
--
-- ============================================================================
-- WHAT THE SOURCE OF TRUTH ACTUALLY SAYS
-- ============================================================================
--
-- The sheet named `월간 회비(2026년)` is not monthly dues. It is a per-session
-- settlement grid: row 1 carries the amount for that session, row 3 the pool it
-- was held at, and rows 4 onward are 40 members whose cells record whether that
-- member settled that session. 22 sessions, 2026-01-04 .. 2026-09-19, at
-- 10,000 / 14,000 / 15,000 / 18,000 / 20,000 원. `회비(2025년)` is the same
-- shape with 12 sessions and 24 members.
--
-- Read across the header row and there are TWO kinds of money in it, and
-- NEITHER of them is 지각비:
--
--   반기 회비        50,000 원 per member per half-year. 2026 carries both a
--                    `26년 상반기` and a `26년 하반기` column, so it recurs per
--                    half rather than being a one-off joining fee.
--
--   세션 참가비      belongs to the SESSION, not to the member. Every member who
--                    settled that session settled the same number, which is why
--                    the amount sits in row 1 above the whole column instead of
--                    in each cell.
--
-- 지각비 is a third thing, on a different axis entirely — per attendance row,
-- held to status = 'late' by `late_fee_requires_late`. Nothing here touches it.
--
-- One thing to know before building on it: `attendance.late_fee_paid` is written
-- and read, but `attendance.late_fee_amount` (declared 0001:108) IS NOT. Scanned
-- 2026-09-03, it appears in exactly three files — its own declaration, the
-- generated `src/types/database.ts`, and this comment. No migration writes it, no
-- RPC returns it, nothing under `src` names it. So the column exists and has
-- never held a value, and a screen that wants 지각비 AMOUNTS cannot get them from
-- there yet. Recorded here because "the column is declared" reads as "the data is
-- there" to anyone who greps for it. Not this migration's job to fix.
--
-- ============================================================================
-- WHAT IS DERIVED, AND THEREFORE NOT STORED
-- ============================================================================
--
-- Of the sheet's five computed columns, THREE are recomputed by the functions
-- below and none of the three is stored: `소계`, `참여횟수`, and the
-- `1월`..`9월` monthly buckets. All three derive from the CHARGE side alone —
-- what a session cost, and how many a member settled — which is entirely
-- contained in this schema.
--
-- Not storing them is not tidiness. A stored `소계` is a second source of truth
-- for a number the rows already determine, and the moment one row is corrected
-- it becomes a number that is wrong and that nothing recomputes — the defect
-- `activities.details.participants` has carried since the legacy app
-- (index.html:3590 writes it, :1206 reads it, :1312 overwrites it, and the table
-- was the real answer all along).
--
-- ============================================================================
-- WHY `잔액` AND `총 납부 누계` ARE ABSENT — DO NOT "FINISH" THIS
-- ============================================================================
--
-- The other two columns are NOT computed here, and the next person to read this
-- file will be tempted to add them, because they look like one subtraction away.
-- They are not. THEY ARE THE HALF OF A LEDGER THIS DATABASE DOES NOT HOLD.
--
-- `잔액` is a balance, and a balance needs a credit side. In the workbook the
-- credit side is `계좌거래내역` — the club's bank transaction sheet — and
-- `scripts/import/parse.ts` excludes it ON PURPOSE. Its header names the rule:
-- XLSX.read is given an explicit `sheets` allowlist of three, so the bank sheet
-- and all three 회비 sheets are skipped at parse time rather than parsed and
-- politely ignored, because this repository is public and that is bank data
-- about named members.
--
-- So the deposits never reach this database, and they are not going to. What
-- `dues_payments` holds is what a staffer typed on a screen, which is a useful
-- record and is NOT the club's receipts. Subtracting it from the charge would
-- produce a number that is confidently wrong in a knowable direction: every
-- member who really paid, but whose payment nobody has keyed in yet, reads as
-- owing the full amount.
--
-- A money figure quietly missing one side is worse than an absent one. An empty
-- column is visibly unanswered; a wrong balance is a sentence in the app's own
-- voice telling a member they owe money they already paid, and NOBODY SPOTS A
-- WRONG BALANCE BY EYE — there is nothing to compare it against.
--
-- Hence: no `balance` column in any return type below, and no cumulative
-- "총 납부 누계" total anywhere. The per-row `paid_amount` IS returned, because
-- it is a stored fact about what somebody recorded; it is the SUMS and the
-- SUBTRACTIONS across rows that are refused, since those are what read as the
-- club's books.
--
-- Adding either one needs a deposits model first, and a deposits model needs a
-- decision about bank data in a public repository that is the president's to
-- make and not ours.
--
-- ============================================================================
-- WHY THE SESSION FEE IS A TABLE AND NOT A COLUMN ON `activities`
-- ============================================================================
--
-- `alter table activities add column fee int` is shorter, and the decisive
-- objection is not tidiness. IT WOULD MAKE THE FEE MEMBER-WRITABLE.
--
-- `activities` is not a staff-only table. 0015 opened it:
--
--   activities_member_event_insert   with check (kind = 'event'
--                                                and created_by = current_member_id())
--   activities_member_event_update    using (kind = 'event' and created_by = ...)
--                                with check (kind = 'event' and created_by = ...)
--
-- and 0015's own closing note records that `authenticated` already holds
-- INSERT/UPDATE/DELETE on the table — RLS is the only thing deciding which rows.
--
-- A POLICY AUTHORISES A ROW, NOT A COLUMN. An approved member may already UPDATE
-- their own 기타, and a `fee_amount` column would sit inside that permitted
-- UPDATE with nothing in either policy able to exclude it: `using` and
-- `with check` take row predicates, and neither can say "every column but this
-- one". The only mechanism that separates columns is `grant update(col, …)`, a
-- per-column allowlist that has to be restated every time anybody adds a column
-- — so it is correct exactly until the next migration forgets it, and its
-- failure is silent.
--
-- A separate table moves the fee behind its own policies, where the question
-- "who may write this" is asked about the fee itself rather than inherited from
-- whoever may edit the activity it hangs on.
--
-- Two lesser reasons, which is all they are. It would put money on every 대회
-- and 기타 where the club charges nothing, leaving a column null on most of its
-- rows. And it cannot express the distinction the sheet makes. 2026-05-31 is a
-- training the club ran and charged nothing for. With a nullable column, "we
-- charged nothing" and "nobody has filled this in yet" are the same NULL. With a
-- 1:1 extension table they are different facts and stay different:
--
--   no row in activity_fees          this session has no fee set
--   a row with amount = 0            this session was free, and somebody said so
--   a row with amount = 15000        this session cost 15,000
--
-- The table is deliberately NOT restricted to kind = 'training'. Every session
-- in both sheets is a training, so a check constraint would be true today — but
-- it would be a schema opinion the data does not support, and the club charging
-- an entry fee for a 대회 is an ordinary thing that would then need a migration
-- rather than a row.
--
-- ============================================================================
-- WHY 반기 회비 IS A PERIOD TABLE AND NOT A PAIR OF COLUMNS
-- ============================================================================
--
-- 2026 has 상반기 and 하반기. 2027 will have two more, and 2025 had only 하반기.
-- Modelled as columns, each new half is DDL; modelled as rows, adding 2027 상반기
-- is one INSERT that a staffer performs from a screen.
--
-- The amount lives on the PERIOD, so raising the half-year fee from 50,000 to
-- 60,000 in 2027 does not rewrite what 2026 charged.
--
-- ============================================================================
-- WHY THE TABLES CARRY NO POLICIES
-- ============================================================================
--
-- All four are RLS-on with zero policies, which denies every normal caller
-- outright, and every door is a SECURITY DEFINER function. This is the shape
-- `attendance` has carried since 0001 (`0001_foundation_and_attendance.sql:169`,
-- and there is still no `create policy ... on attendance` in this directory) and
-- that 0053 copies for `notice_reads`.
--
-- The reason is the same reason as 0053's, and money sharpens it. A member may
-- see their own dues and must not see anybody else's. A SELECT policy of
-- `member_id = current_member_id() or is_staff()` would express that — and would
-- then be the SECOND place the rule lives, with PostgREST able to reach the table
-- directly and the functions below being one of two doors onto the same question.
-- Writes are worse: the member_id on a payment row must come from staff naming
-- it, never from the client naming itself, and a WITH CHECK cannot supply a value
-- it can only compare against.
--
-- The grant is revoked as well as the policies being absent. RLS already refuses;
-- the standing grant is the half that has to stay wrong for a future
-- `create policy` to become a leak. That is 0014's argument, unchanged.
--
-- ============================================================================
-- REFUSE, DO NOT RETURN EMPTY
-- ============================================================================
--
-- Every staff-only read below RAISES 42501 rather than filtering itself to zero
-- rows the way `attendance_for_activity_v1` does with `where public.is_staff()`.
--
-- On a money screen the difference is the whole thing. "Nobody owes anything"
-- and "you may not ask" are different facts, and an empty result presents the
-- second as the first — a member who reached the roster function would be shown,
-- truthfully-looking, a club where no one has paid, and the privacy boundary
-- would leave no trace of having refused. 42501 says what happened.
--
-- ============================================================================
-- THE DELETE PATHS ARE LOAD-BEARING — DO NOT TRIM THEM
-- ============================================================================
--
-- Three functions below exist only to remove a row: `clear_activity_fee_v1`,
-- `clear_dues_payment_v1`, and the `p_paid = false` branch of
-- `set_activity_fee_payment_v1`. They look like conveniences and they are not.
--
-- This schema spends its central design on a three-way distinction — no row / a
-- row saying 0 / a row saying N. If every write is an upsert, that distinction
-- becomes WRITE-ONLY: a staffer who types 0 into the wrong session has recorded
-- "this session was free" and has no way back to "nobody has decided yet".
-- The zero is now indistinguishable from a deliberate free session, forever, and
-- the whole reason `activity_fees` is a table instead of a column evaporates.
--
-- A distinction you can enter and cannot leave is not a distinction; it is a
-- trap. Whatever else gets deferred, these do not.
--
-- ============================================================================
-- TWO LIMITS THAT ARE CHOICES, NOT OVERSIGHTS
-- ============================================================================
--
-- INSTALMENTS ARE NOT MODELLED. `dues_payments` is keyed (period_id, member_id),
-- so a member has at most one 반기 회비 payment row per half. A partial payment
-- is expressible — the row's amount is simply less than the period's — but a
-- member who pays 30,000
-- in March and 20,000 in May ends with one row and the later date. The sheet has
-- one cell per member per half and records exactly that much, so this matches the
-- source; a real instalment ledger means dropping this primary key for a
-- surrogate id and summing, which is a change to make when somebody asks for it
-- rather than in advance.
--
-- A PER-MEMBER SESSION AMOUNT IS NOT MODELLED. `set_activity_fee_payment_v1`
-- takes a boolean and copies the session's own amount onto the row. Every cell in
-- both sheets is either the session's amount or blank, so a member who paid a
-- different number for the same session is a case the source of truth does not
-- contain.
--
-- The amount IS stored on the payment row rather than being read back through the
-- join, and that is the opposite call for a reason. It records what was actually
-- collected. If a staffer later corrects a session's fee from 15,000 to 14,000,
-- the money already taken does not retroactively become a different number, and
-- the ledger still reconciles against what went into the account.

-- ---------------------------------------------------------------------------
-- 반기 회비 — the periods
-- ---------------------------------------------------------------------------
create table if not exists public.dues_periods (
  id         uuid primary key default gen_random_uuid(),
  year       int not null check (year between 2000 and 2100),
  half       int not null check (half in (1, 2)),
  -- KRW, integer 원. No floats anywhere in this migration: 원 has no subunit and
  -- a float would introduce a rounding question the currency does not have.
  amount     int not null check (amount >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One period per half. This is what makes `2026 상반기` a thing that exists
  -- once rather than a label two rows can both claim.
  unique (year, half)
);
comment on table public.dues_periods is
  '반기 회비 기간. (년도, 상/하반기) 한 쌍당 한 행이며 amount 는 그 반기의 1인당 회비다. 접근은 전부 SECURITY DEFINER 함수를 거친다.';

alter table public.dues_periods enable row level security;
revoke all on public.dues_periods from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 반기 회비 — who paid
-- ---------------------------------------------------------------------------
create table if not exists public.dues_payments (
  period_id   uuid not null references public.dues_periods(id) on delete cascade,
  member_id   uuid not null references public.members(id) on delete cascade,
  amount      int not null check (amount >= 0),
  -- Nullable: the club records that somebody paid long before anybody digs out
  -- which day the transfer landed, and a NOT NULL here would force a staffer to
  -- invent a date to record a fact they are sure of.
  paid_on     date,
  note        text,
  -- Who recorded it. ON DELETE SET NULL rather than cascade: a staffer leaving
  -- the club must not take the payment records they entered with them. NO ACTION
  -- would be worse still — it would wedge every teardown and every member
  -- deletion behind rows nobody can classify (0052's marked_by lesson).
  recorded_by uuid references public.members(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (period_id, member_id)
);
comment on table public.dues_payments is
  '반기 회비 납부 기록. (기간, 회원) 한 쌍당 한 행이며 amount 는 운영진이 입력한 금액이다. 잔액은 저장하지도 계산하지도 않는다. 입금 내역이 이 데이터베이스에 없기 때문이며 자세한 이유는 0057 헤더에 있다.';

-- The primary key leads with period_id, so the roster read and the cascade from
-- dues_periods are both covered. member_id is not, and its own FK cascades too —
-- deleting a member would seq-scan this table without it. Same reason 0001
-- carries attendance_member_idx beside the same shape.
create index if not exists dues_payments_member_idx
  on public.dues_payments (member_id);

alter table public.dues_payments enable row level security;
revoke all on public.dues_payments from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 세션 참가비 — what a session costs
-- ---------------------------------------------------------------------------
-- activity_id is the primary key, which is what makes this 1:1 rather than a
-- fee history. A session has one price; correcting it is an UPDATE, and the
-- payments already taken keep the number that was actually collected.
create table if not exists public.activity_fees (
  activity_id uuid primary key references public.activities(id) on delete cascade,
  amount      int not null check (amount >= 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  set_by      uuid references public.members(id) on delete set null
);
comment on table public.activity_fees is
  '세션(활동)별 참가비. 행이 없으면 참가비를 정하지 않은 활동이고, amount = 0 은 무료로 정한 활동이다. 이 둘은 다른 사실이다.';

alter table public.activity_fees enable row level security;
revoke all on public.activity_fees from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 세션 참가비 — who paid
-- ---------------------------------------------------------------------------
-- The FK is to activity_fees, not to activities, and that is load-bearing: a
-- payment of a fee that was never set is not a fact this table should be able to
-- hold. Clearing a session's fee therefore cascades its payments away, which is
-- the honest outcome — the money was collected against a price that no longer
-- exists.
create table if not exists public.activity_fee_payments (
  activity_id uuid not null references public.activity_fees(activity_id) on delete cascade,
  member_id   uuid not null references public.members(id) on delete cascade,
  -- Copied from the session's amount at the moment it was recorded. See the
  -- header: this is what was collected, not what the session currently costs.
  amount      int not null check (amount >= 0),
  paid_on     date,
  recorded_by uuid references public.members(id) on delete set null,
  created_at  timestamptz not null default now(),
  primary key (activity_id, member_id)
);
comment on table public.activity_fee_payments is
  '세션 참가비 납부 기록. 행이 있으면 그 회원이 그 세션 참가비를 냈다는 뜻이고, amount 는 낼 당시의 세션 금액이다.';

create index if not exists activity_fee_payments_member_idx
  on public.activity_fee_payments (member_id);

alter table public.activity_fee_payments enable row level security;
revoke all on public.activity_fee_payments from public, anon, authenticated;

-- ===========================================================================
-- READS
-- ===========================================================================

-- ------------------------------------------------------------ the periods
-- Readable by any approved member: a member has to be able to see that 2026
-- 상반기 costs 50,000 in order to make sense of their own row. It carries no
-- per-member data at all, so there is nothing here to gate on beyond membership.
create or replace function public.list_dues_periods_v1()
returns table (
  period_id uuid,
  year      int,
  half      int,
  amount    int
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if public.current_member_id() is null then
    raise exception 'not an approved member' using errcode = '42501';
  end if;

  -- Every reference is alias-qualified because `returns table` declares
  -- year/half/amount as plpgsql variables; an unqualified column of the same
  -- name would be ambiguous, and `amount` would silently resolve to the
  -- variable rather than the column.
  return query
    select d.id, d.year, d.half, d.amount
      from public.dues_periods d
     -- Newest half first: the period a member is currently being asked to pay
     -- is the one they opened the screen for.
     order by d.year desc, d.half desc;
end $$;

comment on function public.list_dues_periods_v1() is
  '반기 회비 기간 목록. 승인된 회원이면 누구나 볼 수 있으며 개인 납부 정보는 들어 있지 않다.';

-- ------------------------------------------------------- my 반기 회비 state
-- Takes no member id. The caller is derived from the session, so there is no URL
-- and no argument that reaches somebody else's dues — the same shape
-- attendance_my_history_v1 and my_monthly_activity_v1 already have.
create or replace function public.my_dues_summary_v1()
returns table (
  period_id   uuid,
  year        int,
  half        int,
  due_amount  int,
  paid_amount int,
  paid_on     date
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_member uuid;
begin
  v_member := public.current_member_id();
  if v_member is null then
    raise exception 'not an approved member' using errcode = '42501';
  end if;

  -- LEFT JOIN, so a period with no payment recorded comes back with a zero
  -- rather than vanishing. An inner join would show a member with nothing keyed
  -- in an empty screen, which reads as "there is nothing to settle".
  --
  -- No `balance` column. See the header: the credit side is the bank sheet and
  -- it is not in this database, so `due - paid` here would tell a member who has
  -- paid that they owe the lot.
  return query
    select d.id,
           d.year,
           d.half,
           d.amount,
           coalesce(p.amount, 0),
           p.paid_on
      from public.dues_periods d
      left join public.dues_payments p
        on p.period_id = d.id
       and p.member_id = v_member
     order by d.year desc, d.half desc;
end $$;

comment on function public.my_dues_summary_v1() is
  '호출한 회원의 반기 회비 현황. 기간별 청구액과 기록된 납부액을 돌려준다. 잔액은 넣지 않는다. 입금 내역이 이 데이터베이스에 없어서 뺄셈을 하면 이미 낸 회원에게 미납이라고 말하게 된다.';

-- ---------------------------------------------------- my 세션 참가비 state
create or replace function public.my_activity_fees_v1(
  p_from date default null,
  p_to   date default null
)
returns table (
  activity_id   uuid,
  activity_date date,
  title         text,
  place         text,
  fee_amount    int,
  paid          boolean,
  paid_amount   int
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_member uuid;
begin
  v_member := public.current_member_id();
  if v_member is null then
    raise exception 'not an approved member' using errcode = '42501';
  end if;

  -- Driven from activity_fees rather than from activities: a session with no fee
  -- row is not a session anybody is being asked to pay for, so it has no place on
  -- a 회비 screen. That is the "no row means not applicable" rule from the header
  -- being used rather than merely declared.
  return query
    select a.id,
           a.activity_date,
           a.title,
           a.place,
           f.amount,
           p.member_id is not null,
           coalesce(p.amount, 0)
      from public.activity_fees f
      join public.activities a on a.id = f.activity_id
      left join public.activity_fee_payments p
        on p.activity_id = f.activity_id
       and p.member_id = v_member
     -- Both bounds default to null, so omitting them asks for everything. The
     -- `or ... is null` form rather than a dynamic where: one plan, no string
     -- building, and the planner drops the branch when the parameter is a
     -- constant null.
     where (p_from is null or a.activity_date >= p_from)
       and (p_to   is null or a.activity_date <= p_to)
     order by a.activity_date desc, a.title;
end $$;

comment on function public.my_activity_fees_v1(date, date) is
  '호출한 회원의 세션 참가비 현황. 참가비가 정해진 활동만 나오며 납부 여부와 낼 당시 금액을 함께 돌려준다.';

-- ------------------------------------------------- 반기 회비 roster (staff)
create or replace function public.dues_period_roster_v1(p_period_id uuid)
returns table (
  member_id   uuid,
  nickname    text,
  short_name  text,
  avatar_path text,
  due_amount  int,
  paid_amount int,
  paid_on     date,
  note        text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_amount int;
begin
  -- The whole gate. The tables have no policy to fall back on, and a member must
  -- not learn what anybody else has or has not paid.
  if not public.is_staff() then
    raise exception 'only staff may read the dues roster' using errcode = '42501';
  end if;

  -- Read the period's amount once. It also settles whether the period exists:
  -- an unknown id would otherwise come back as an empty roster, which reads as
  -- "no members" rather than "no such period".
  select d.amount into v_amount
    from public.dues_periods d
   where d.id = p_period_id;

  if v_amount is null then
    raise exception 'no such dues period' using errcode = '23503';
  end if;

  -- member_public_v, not members: the public projection is what a roster screen
  -- needs and it is what every other such read in this schema returns. The view
  -- is DEFINER-mode and calls current_member_id() itself, which still resolves
  -- inside this function — SECURITY DEFINER changes whose privileges the body
  -- runs with, not auth.uid(). is_staff() has already passed, so the caller is an
  -- approved member and the view's own gate cannot refuse them.
  --
  -- The view carries `where status = 'approved'` (0019), so a member who paid and
  -- was afterwards blocked DISAPPEARS from this roster while their payment row
  -- stays. The money is not lost; the payer stops being nameable. Same behaviour
  -- 0053 records for notice readers, written down here for the same reason — a
  -- total that silently drops is exactly the shape this project keeps mistaking
  -- for a defect.
  return query
    select v.id,
           v.nickname,
           v.short_name,
           v.avatar_path,
           v_amount,
           coalesce(p.amount, 0),
           p.paid_on,
           p.note
      from public.member_public_v v
      left join public.dues_payments p
        on p.period_id = p_period_id
       and p.member_id = v.id
     -- Unpaid first, so the list opens on the people the screen exists for, then
     -- by nickname so the order is total and does not reshuffle between refreshes.
     order by (p.member_id is not null), v.nickname;
end $$;

comment on function public.dues_period_roster_v1(uuid) is
  '한 반기의 전체 회원 납부 현황. 운영진만 호출할 수 있고, 회원은 다른 사람의 회비 정보를 볼 수 없다.';

-- ---------------------------------------------- 세션 참가비 roster (staff)
create or replace function public.activity_fee_roster_v1(p_activity_id uuid)
returns table (
  member_id   uuid,
  nickname    text,
  short_name  text,
  avatar_path text,
  fee_amount  int,
  paid        boolean,
  paid_amount int,
  paid_on     date
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_amount int;
begin
  if not public.is_staff() then
    raise exception 'only staff may read the activity fee roster' using errcode = '42501';
  end if;

  select f.amount into v_amount
    from public.activity_fees f
   where f.activity_id = p_activity_id;

  -- "No fee has been set for this session" is a different answer from "nobody has
  -- paid", and the screen has to be able to tell them apart: the first needs a
  -- 참가비 설정 form, the second needs the roster. An empty result would present
  -- the first as the second.
  if v_amount is null then
    raise exception 'no fee is set for this activity' using errcode = '23503';
  end if;

  return query
    select v.id,
           v.nickname,
           v.short_name,
           v.avatar_path,
           v_amount,
           p.member_id is not null,
           coalesce(p.amount, 0),
           p.paid_on
      from public.member_public_v v
      left join public.activity_fee_payments p
        on p.activity_id = p_activity_id
       and p.member_id = v.id
     order by (p.member_id is not null), v.nickname;
end $$;

comment on function public.activity_fee_roster_v1(uuid) is
  '한 세션의 전체 회원 참가비 납부 현황. 운영진만 호출할 수 있다. 참가비가 정해지지 않은 활동이면 거절한다.';

-- ------------------------------------------- sessions with a fee (staff)
create or replace function public.list_activity_fees_v1(
  p_from date default null,
  p_to   date default null
)
returns table (
  activity_id      uuid,
  activity_date    date,
  title            text,
  place            text,
  fee_amount       int,
  paid_count       int
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_staff() then
    raise exception 'only staff may list activity fees' using errcode = '42501';
  end if;

  return query
    select a.id,
           a.activity_date,
           a.title,
           a.place,
           f.amount,
           -- 참여횟수 per session — a COUNT of settled members, computed rather
           -- than stored. It is a count of rows, not a sum of money, which is
           -- why it survives the rule in the header while a 수납 합계 does not:
           -- how many people were keyed in is fully known here, how much the
           -- club received is not.
           --
           -- count(*) returns bigint and the declared column is int, so the cast
           -- is explicit rather than implicit — an implicit narrowing cast in a
           -- money-adjacent function is not a thing to leave for the next reader
           -- to have to reason about.
           (select count(*)::int
              from public.activity_fee_payments q
             where q.activity_id = f.activity_id)
      from public.activity_fees f
      join public.activities a on a.id = f.activity_id
     where (p_from is null or a.activity_date >= p_from)
       and (p_to   is null or a.activity_date <= p_to)
     order by a.activity_date desc, a.title;
end $$;

comment on function public.list_activity_fees_v1(date, date) is
  '참가비가 정해진 세션 목록과 세션별 납부 인원. 운영진만 호출할 수 있다. 수납 합계는 넣지 않는다. 사람 수는 다 알 수 있지만 실제로 들어온 돈은 이 데이터베이스가 알지 못한다.';

-- ===========================================================================
-- WRITES — all staff-only
-- ===========================================================================

-- ------------------------------------------------------- save a period
-- p_period_id null means create, non-null means update. This is the same
-- create-or-update shape save_notice_v1 uses, and it is why the client type for
-- this parameter has to stay `string | null` — see CLAUDE.md on what
-- `npm run db:types` does to a nullable plpgsql parameter.
create or replace function public.save_dues_period_v1(
  p_period_id uuid,
  p_year      int,
  p_half      int,
  p_amount    int
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not public.is_staff() then
    raise exception 'only staff may manage dues periods' using errcode = '42501';
  end if;

  -- The CHECK constraints would refuse these anyway. Raising here only replaces
  -- 23514's raw constraint name with a sentence a screen can print; it is not a
  -- second gate, and the constraints remain the enforcement.
  if p_half not in (1, 2) then
    raise exception 'half must be 1 or 2' using errcode = '22023';
  end if;
  if p_amount is null or p_amount < 0 then
    raise exception 'amount must be zero or more' using errcode = '22023';
  end if;

  if p_period_id is null then
    insert into public.dues_periods (year, half, amount)
    values (p_year, p_half, p_amount)
    returning id into v_id;
  else
    update public.dues_periods
       set year = p_year,
           half = p_half,
           amount = p_amount,
           updated_at = now()
     where id = p_period_id
    returning id into v_id;

    if v_id is null then
      raise exception 'no such dues period' using errcode = '23503';
    end if;
  end if;

  return v_id;
-- The unique (year, half) index is what actually prevents a duplicate half, and
-- it does so under concurrency where a pre-check could not. This only turns
-- 23505's index name into a sentence.
exception when unique_violation then
  raise exception '그 반기는 이미 등록되어 있습니다' using errcode = '23505';
end $$;

comment on function public.save_dues_period_v1(uuid, int, int, int) is
  '반기 회비 기간을 만들거나 수정한다. p_period_id 가 null 이면 생성이다. 운영진만 호출할 수 있다.';

-- ----------------------------------------------------- delete a period
create or replace function public.delete_dues_period_v1(p_period_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_staff() then
    raise exception 'only staff may manage dues periods' using errcode = '42501';
  end if;

  -- This CASCADES every payment recorded against the period. That is the correct
  -- outcome — a payment against a half-year that does not exist is not a fact
  -- worth keeping — but it is destructive and irreversible from inside the app,
  -- so the screen has to confirm it and say how many rows go with it.
  delete from public.dues_periods where id = p_period_id;

  if not found then
    raise exception 'no such dues period' using errcode = '23503';
  end if;
end $$;

comment on function public.delete_dues_period_v1(uuid) is
  '반기 회비 기간을 삭제한다. 그 기간의 납부 기록도 함께 사라진다. 운영진만 호출할 수 있다.';

-- --------------------------------------------- record a 반기 회비 payment
create or replace function public.set_dues_payment_v1(
  p_period_id uuid,
  p_member_id uuid,
  p_amount    int,
  p_paid_on   date default null,
  p_note      text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_staff() then
    raise exception 'only staff may record dues payments' using errcode = '42501';
  end if;

  if p_amount is null or p_amount < 0 then
    raise exception 'amount must be zero or more' using errcode = '22023';
  end if;

  -- Deliberately NOT capped at the period's amount. Overpayment happens — a
  -- member pays both halves in one transfer, or rounds up — and a cap would
  -- refuse to record money the club has actually received. What the screen does
  -- with a paid_amount larger than the due_amount is the screen's business; this
  -- function's job is not to lose the figure a staffer was given.

  insert into public.dues_payments
    (period_id, member_id, amount, paid_on, note, recorded_by)
  values
    (p_period_id, p_member_id, p_amount, p_paid_on, p_note, public.current_member_id())
  -- Correcting a payment is the ordinary case, not an exception: a staffer
  -- mistypes 5,000 for 50,000 and fixes it. `do update` rather than
  -- `do nothing`, which is the opposite of 0053's rule and for the opposite
  -- reason — a read receipt answers "has this happened", a payment answers
  -- "how much", and the second is a value that gets corrected.
  on conflict (period_id, member_id) do update
     set amount      = excluded.amount,
         paid_on     = excluded.paid_on,
         note        = excluded.note,
         recorded_by = excluded.recorded_by,
         updated_at  = now();
end $$;

comment on function public.set_dues_payment_v1(uuid, uuid, int, date, text) is
  '한 회원의 반기 회비 납부액을 기록하거나 수정한다. 기간 금액보다 적어도 많아도 그대로 받는다. 운영진만 호출할 수 있다.';

-- ---------------------------------------------- clear a 반기 회비 payment
create or replace function public.clear_dues_payment_v1(
  p_period_id uuid,
  p_member_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_staff() then
    raise exception 'only staff may record dues payments' using errcode = '42501';
  end if;

  -- No `if not found then raise`. Clearing a payment that is already absent is
  -- the state the caller asked for, and a staffer double-tapping 취소 on a row
  -- they already cleared should not meet an error describing a row that is
  -- correctly gone. This is not the "a write that succeeds without writing"
  -- trap from CLAUDE.md — there, zero rows meant the intended thing had not
  -- happened; here zero rows and one row are the same end state.
  delete from public.dues_payments
   where period_id = p_period_id
     and member_id = p_member_id;
end $$;

comment on function public.clear_dues_payment_v1(uuid, uuid) is
  '한 회원의 반기 회비 납부 기록을 지운다. 이미 없으면 아무것도 하지 않는다. 운영진만 호출할 수 있다.';

-- --------------------------------------------------- set a session fee
create or replace function public.set_activity_fee_v1(
  p_activity_id uuid,
  p_amount      int
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_staff() then
    raise exception 'only staff may set activity fees' using errcode = '42501';
  end if;

  if p_amount is null or p_amount < 0 then
    raise exception 'amount must be zero or more' using errcode = '22023';
  end if;

  -- The FK would refuse a bad id anyway; this only replaces 23503's raw text with
  -- a sentence, matching mark_notice_read_v1's shape (0053). It is not a guard —
  -- an activity deleted between here and the insert still raises 23503.
  if not exists (select 1 from public.activities where id = p_activity_id) then
    raise exception 'no such activity' using errcode = '23503';
  end if;

  insert into public.activity_fees (activity_id, amount, set_by)
  values (p_activity_id, p_amount, public.current_member_id())
  on conflict (activity_id) do update
     set amount     = excluded.amount,
         set_by     = excluded.set_by,
         updated_at = now();

  -- Payments already recorded keep the amount they were recorded with. See the
  -- header: what was collected does not change because the price did.
end $$;

comment on function public.set_activity_fee_v1(uuid, int) is
  '세션 참가비를 정하거나 고친다. 0 도 유효한 값이며 무료로 정했다는 뜻이다. 이미 기록된 납부액은 바뀌지 않는다. 운영진만 호출할 수 있다.';

-- ------------------------------------------------- clear a session fee
create or replace function public.clear_activity_fee_v1(p_activity_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_staff() then
    raise exception 'only staff may set activity fees' using errcode = '42501';
  end if;

  -- CASCADES the session's payment rows, because activity_fee_payments' FK points
  -- here rather than at activities. Clearing the fee is therefore not the same as
  -- setting it to 0: 0 keeps the roster and says the session was free, while
  -- clearing says the session has no fee and takes the collection record with it.
  -- The screen must say which one the button does.
  delete from public.activity_fees where activity_id = p_activity_id;

  if not found then
    raise exception 'no fee is set for this activity' using errcode = '23503';
  end if;
end $$;

comment on function public.clear_activity_fee_v1(uuid) is
  '세션 참가비 설정을 지운다. 그 세션의 납부 기록도 함께 사라지므로 0 원으로 정하는 것과 다르다. 운영진만 호출할 수 있다.';

-- ------------------------------------ record or clear a session payment
-- A toggle rather than an amount, because the sheet is a toggle: every filled
-- cell holds the session's own number. The amount is copied from the session
-- INSIDE this function, so a client cannot name it and the two can never drift.
create or replace function public.set_activity_fee_payment_v1(
  p_activity_id uuid,
  p_member_id   uuid,
  p_paid        boolean,
  p_paid_on     date default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount int;
begin
  if not public.is_staff() then
    raise exception 'only staff may record activity fee payments' using errcode = '42501';
  end if;

  if p_paid is null then
    raise exception 'paid must be true or false' using errcode = '22023';
  end if;

  if not p_paid then
    -- Same reasoning as clear_dues_payment_v1: absent is the state asked for.
    delete from public.activity_fee_payments
     where activity_id = p_activity_id
       and member_id = p_member_id;
    return;
  end if;

  select f.amount into v_amount
    from public.activity_fees f
   where f.activity_id = p_activity_id;

  -- Recording payment of a fee that was never set would put a row in the ledger
  -- with no price behind it. The FK refuses it too; this says why.
  if v_amount is null then
    raise exception 'no fee is set for this activity' using errcode = '23503';
  end if;

  insert into public.activity_fee_payments
    (activity_id, member_id, amount, paid_on, recorded_by)
  values
    (p_activity_id, p_member_id, v_amount, p_paid_on, public.current_member_id())
  -- Re-marking somebody paid re-copies the CURRENT session amount. That is the
  -- one path by which a corrected price reaches an existing row, and it is
  -- explicit: a staffer had to touch that member's cell again.
  on conflict (activity_id, member_id) do update
     set amount      = excluded.amount,
         paid_on     = excluded.paid_on,
         recorded_by = excluded.recorded_by;
end $$;

comment on function public.set_activity_fee_payment_v1(uuid, uuid, boolean, date) is
  '한 회원의 세션 참가비 납부 여부를 기록한다. 금액은 세션에 정해진 값을 서버가 복사하며 클라이언트가 정할 수 없다. 운영진만 호출할 수 있다.';

-- ===========================================================================
-- EXECUTE RIGHTS
-- ===========================================================================
--
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default, and 0014's
-- `alter default privileges ... revoke all on functions from anon` does not reach
-- that built-in grant. So both roles are named explicitly, and authenticated with
-- them — the revoke/grant pair leaves exactly EXECUTE and nothing inherited,
-- which is the footer shape 0050 and 0053 use.
--
-- 0014 left anon holding EXECUTE once already by revoking from public alone, and
-- 0043 went wrong in the other direction by revoking from authenticated with no
-- matching grant. Both halves of every pair below are therefore written out.
--
-- Every function is granted to `authenticated` and gated INSIDE the body. That is
-- the division attendance_for_activity_v1 uses: the grant says who may call, the
-- body says who may be answered. A staff-only grant is not available here anyway
-- — `staff` is not a database role, it is a column on members.

revoke all on function public.list_dues_periods_v1()   from public, anon, authenticated;
grant execute on function public.list_dues_periods_v1() to authenticated;

revoke all on function public.my_dues_summary_v1()   from public, anon, authenticated;
grant execute on function public.my_dues_summary_v1() to authenticated;

revoke all on function public.my_activity_fees_v1(date, date)   from public, anon, authenticated;
grant execute on function public.my_activity_fees_v1(date, date) to authenticated;

revoke all on function public.dues_period_roster_v1(uuid)   from public, anon, authenticated;
grant execute on function public.dues_period_roster_v1(uuid) to authenticated;

revoke all on function public.activity_fee_roster_v1(uuid)   from public, anon, authenticated;
grant execute on function public.activity_fee_roster_v1(uuid) to authenticated;

revoke all on function public.list_activity_fees_v1(date, date)   from public, anon, authenticated;
grant execute on function public.list_activity_fees_v1(date, date) to authenticated;

revoke all on function public.save_dues_period_v1(uuid, int, int, int)   from public, anon, authenticated;
grant execute on function public.save_dues_period_v1(uuid, int, int, int) to authenticated;

revoke all on function public.delete_dues_period_v1(uuid)   from public, anon, authenticated;
grant execute on function public.delete_dues_period_v1(uuid) to authenticated;

revoke all on function public.set_dues_payment_v1(uuid, uuid, int, date, text)   from public, anon, authenticated;
grant execute on function public.set_dues_payment_v1(uuid, uuid, int, date, text) to authenticated;

revoke all on function public.clear_dues_payment_v1(uuid, uuid)   from public, anon, authenticated;
grant execute on function public.clear_dues_payment_v1(uuid, uuid) to authenticated;

revoke all on function public.set_activity_fee_v1(uuid, int)   from public, anon, authenticated;
grant execute on function public.set_activity_fee_v1(uuid, int) to authenticated;

revoke all on function public.clear_activity_fee_v1(uuid)   from public, anon, authenticated;
grant execute on function public.clear_activity_fee_v1(uuid) to authenticated;

revoke all on function public.set_activity_fee_payment_v1(uuid, uuid, boolean, date)   from public, anon, authenticated;
grant execute on function public.set_activity_fee_payment_v1(uuid, uuid, boolean, date) to authenticated;
