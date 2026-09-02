/**
 * 회비 arithmetic — the derived numbers 0057 deliberately refuses to store, and
 * the two it deliberately refuses to compute at all.
 *
 * PURE, AND OUT HERE SO A TEST CAN REACH IT. Nothing in this file touches the
 * network, the clock (except where a `now` is passed in), or a React hook. The
 * screens import from here; the tests import from here; there is no third copy
 * of any of these rules living inside a component.
 *
 * THERE IS NO BALANCE HERE, AND THAT IS THE POINT.
 *
 * An earlier draft of this file computed 잔액 as `due - paid` and summed a
 * 총 납부 누계 across periods. Both are gone, and neither should come back
 * without the thing they need first.
 *
 * A balance needs a credit side. The club's credit side is the workbook's
 * `계좌거래내역` bank sheet, and `scripts/import/parse.ts` excludes it on
 * purpose — its `XLSX.read` allowlist admits three sheets and skips the bank and
 * 회비 sheets at parse time, because this repository is public and those hold
 * bank data about named members. So the deposits are not in the database and are
 * not coming.
 *
 * What `paid_amount` holds is what a staffer keyed in. Subtracting that from the
 * charge yields a number that is wrong in a KNOWABLE direction: every member who
 * really paid, but whose payment nobody has entered yet, reads as owing the full
 * amount. On a money screen that is not a rough edge, it is the app telling a
 * member they owe money they already handed over — and nobody catches a wrong
 * balance by eye, because there is nothing on the screen to check it against.
 *
 * So the rule this module enforces: SUM THE CHARGE SIDE, COUNT THE ROWS, AND
 * NEVER SUBTRACT THE TWO SIDES OR TOTAL THE MONEY RECEIVED. `소계`, `참여횟수`
 * and the monthly buckets are all charge-side or counts, which is exactly why
 * those three survive and the other two do not.
 */

/** 상반기 or 하반기. The database CHECK is `half in (1, 2)`; this is that type. */
export type Half = 1 | 2

/** A row of `my_dues_summary_v1`, narrowed to what the arithmetic needs. */
export type DuesAmounts = {
  due_amount: number
  paid_amount: number
}

/** A row of `my_activity_fees_v1`, narrowed the same way. */
export type ActivityFeeAmounts = {
  fee_amount: number
  paid: boolean
  paid_amount: number
}

// ---------------------------------------------------------------- formatting

/**
 * KRW as the club writes it: `50,000원`.
 *
 * Grouped by hand rather than through `toLocaleString('ko-KR')`, because that
 * depends on the ICU data the runtime happens to ship and this has to render the
 * same number in a member's browser, in CI, and in a test. A money format that
 * varies by environment is a money format nobody can assert on.
 */
export function formatKrw(amount: number): string {
  const sign = amount < 0 ? '-' : ''
  const digits = Math.abs(Math.trunc(amount))
    .toString()
    // Insert a comma at every position that has a multiple of three digits after
    // it. `\B` keeps it off the front, so `100` does not become `,100`.
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}${digits}원`
}

/** `2026년 상반기`. The only place the two halves get their Korean names. */
export function periodLabel(year: number, half: Half): string {
  return `${year}년 ${half === 1 ? '상반기' : '하반기'}`
}

// ------------------------------------------------------- recorded, not settled

/**
 * Whether a payment has been ENTERED for this row. Not whether the member paid.
 *
 * The distinction is the whole of the module header. This function looks at the
 * database and answers a question about the database — has somebody keyed
 * anything in — and deliberately does not answer the question a member actually
 * cares about, which is whether the club considers them square. That second
 * question needs the bank sheet and cannot be answered here at all.
 *
 * Hence `> 0` rather than any comparison against `due_amount`: a partial entry is
 * still an entry, and calling it 미납 would assert a shortfall this data cannot
 * establish.
 */
export function hasRecordedPayment(row: DuesAmounts): boolean {
  return row.paid_amount > 0
}

/**
 * What a row may be labelled, in Korean, without overclaiming.
 *
 * 「납부 기록 있음」/「납부 기록 없음」 rather than 「완납」/「미납」. The first pair
 * describes the record, which is what we have; the second pair adjudicates a
 * debt, which is what we do not. A member who paid in cash last month and whose
 * entry is still in somebody's notebook must not be shown the word 미납 by an app
 * that has never seen the club's account.
 */
export function recordLabel(row: DuesAmounts): string {
  return hasRecordedPayment(row) ? '납부 기록 있음' : '납부 기록 없음'
}

// -------------------------------------------------------------------- totals

export type DuesTotals = {
  /** 소계 — the charge side, which IS fully known here. */
  due: number
  /** How many rows have a payment entered. A count, not a sum of money. */
  recordedCount: number
  unrecordedCount: number
}

/**
 * Roll a member's periods (or a period's members) into the totals that can be
 * stated honestly.
 *
 * `due` is summed because every charge is in this database. There is no `paid`
 * total and no `balance`: see the header. The counts are counts of ROWS — how
 * many entries exist — which is a fact about our own table rather than a claim
 * about the club's money.
 */
export function summariseDues(rows: readonly DuesAmounts[]): DuesTotals {
  let due = 0
  let recordedCount = 0

  for (const row of rows) {
    due += row.due_amount
    if (hasRecordedPayment(row)) recordedCount += 1
  }

  return { due, recordedCount, unrecordedCount: rows.length - recordedCount }
}

export type ActivityFeeTotals = {
  sessionCount: number
  /** 참여횟수 — sessions with a payment entered. A count of rows. */
  paidCount: number
  unpaidCount: number
  /** 소계 — what the sessions in this list cost in total. Charge side. */
  chargeTotal: number
}

/**
 * The session-fee half, under the same rule.
 *
 * 참여횟수 survives as a COUNT because it asks how many entries exist, which this
 * database knows exactly. A 수납 합계 does not survive, for the reason in the
 * header — it would read as the money the club took in, and the club's receipts
 * are on a sheet we deliberately never import.
 *
 * `chargeTotal` sums `fee_amount` over every session, settled or not: it is what
 * these sessions cost, which is a charge-side fact and complete.
 */
export function summariseActivityFees(
  rows: readonly ActivityFeeAmounts[],
): ActivityFeeTotals {
  let paidCount = 0
  let chargeTotal = 0

  for (const row of rows) {
    chargeTotal += row.fee_amount
    if (row.paid) paidCount += 1
  }

  return {
    sessionCount: rows.length,
    paidCount,
    unpaidCount: rows.length - paidCount,
    chargeTotal,
  }
}

// -------------------------------------------------------- picking a new period

/** Which half a calendar month falls in. January is 1 here, not 0. */
export function halfOfMonth(month: number): Half {
  // <= 6, so June is 상반기 and July is 하반기. The club's sheet splits there:
  // `26년 상반기` covers the January–June sessions.
  //
  // THE SAME BOUNDARY IS DEFINED A SECOND TIME, IN SQL, AND THE TWO AGREE BY
  // COINCIDENCE RATHER THAN BY CONSTRUCTION. `team_event_rankings_v1`
  // (0016:127-131) fixes H1 as 1월1일–6월30일 and H2 as 7월1일–12월31일 for the
  // ranking buckets. This line was written from the spreadsheet's own labels
  // without reading that migration, and it happens to match.
  //
  // Left as two definitions rather than one because they answer different
  // questions and the stakes are lopsided: 0016's boundary buckets ranking
  // data, while this one only pre-fills a form field a staffer can overwrite.
  // A divergence here is a mildly wrong default; a divergence there is wrong
  // numbers on a leaderboard. Importing SQL's answer into TypeScript would mean
  // a round trip for a default value.
  //
  // What that costs is that nothing connects them, so a change to one will not
  // show up as a diff on the other. If 0016's dates ever move, move this too.
  return month <= 6 ? 1 : 2
}

export type PeriodKey = { year: number; half: Half }

/** Newest first, the order `list_dues_periods_v1` returns. */
export function comparePeriodsDesc(a: PeriodKey, b: PeriodKey): number {
  if (a.year !== b.year) return b.year - a.year
  return b.half - a.half
}

/**
 * What the 새 기간 form should be pre-filled with.
 *
 * With no periods yet, today decides — a club setting this up in March is
 * setting up 상반기. With periods already there, it is the one after the newest,
 * AND IT ROLLS OVER: the successor of 2026 하반기 is 2027 상반기, not 2027 하반기
 * and not 2026 하반기 again. Getting that wrong produces a form that proposes a
 * period which already exists, and `save_dues_period_v1` answers it with
 * `그 반기는 이미 등록되어 있습니다` — a refusal the staffer did nothing to earn.
 *
 * `today` is a parameter rather than a `new Date()` inside, so a test can put the
 * clock in either half without faking timers.
 */
export function nextPeriod(
  periods: readonly PeriodKey[],
  today: Date = new Date(),
): PeriodKey {
  // Do not assume the caller sorted. A copy, because sorting the caller's array
  // in place would reorder the list a screen is currently rendering.
  const newest = [...periods].sort(comparePeriodsDesc)[0]

  // `newest` is undefined exactly when the array was empty, so this is the
  // no-periods-yet branch. Written as a check on the element rather than on
  // `periods.length`, because under `noUncheckedIndexedAccess` those are the
  // same question and the compiler only credits this one.
  if (!newest) {
    return {
      year: today.getFullYear(),
      // getMonth() is 0-based; halfOfMonth counts January as 1.
      half: halfOfMonth(today.getMonth() + 1),
    }
  }

  return newest.half === 1
    ? { year: newest.year, half: 2 }
    : { year: newest.year + 1, half: 1 }
}
