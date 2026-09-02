/**
 * 회비 arithmetic — the derived numbers 0057 deliberately refuses to store.
 *
 * PURE, AND OUT HERE SO A TEST CAN REACH IT. Nothing in this file touches the
 * network, the clock (except where a `now` is passed in), or a React hook. The
 * screens import from here; the tests import from here; there is no third copy
 * of any of these rules living inside a component.
 *
 * WHY THE TOTALS ARE RECOMPUTED RATHER THAN SUMMED FROM `balance`.
 * `my_dues_summary_v1` and `dues_period_roster_v1` both return a `balance`
 * column, and it is correct — the SQL computes it as `due - paid` in the same
 * expression that reads the two. `summariseDues` below ignores that column and
 * recomputes from `due_amount` and `paid_amount` anyway.
 *
 * That is the same belt-and-braces call `toPoll` makes about anonymity in
 * `notices/pollApi.ts`: the database is where the rule actually lives, and this
 * is the cheap second enforcement that stops a wrong payload becoming a wrong
 * number on a money screen. A stale deployed RPC, a hand-rolled response in a
 * test, a proxy that rewrote the body — any of them could send a `balance` that
 * disagrees with the two operands beside it, and a total built by summing that
 * column would quietly inherit the disagreement.
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
 *
 * Negative is a real input, not a defensive branch — see `balanceLabel`.
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

// ------------------------------------------------------------------ balances

/**
 * The rule, in one line, mirroring 0057's `d.amount - coalesce(p.amount, 0)`.
 *
 * NOT clamped at zero. A member who pays both halves in one transfer overpays the
 * first, and the negative that comes back is the club owing them credit — a real
 * fact that `Math.max(0, …)` would silently destroy. `balanceLabel` is what turns
 * it into a sentence.
 */
export function balanceOf(due: number, paid: number): number {
  return due - paid
}

/** Settled means nothing is owed, which includes having overpaid. */
export function isSettled(balance: number): boolean {
  return balance <= 0
}

/**
 * The three states a balance can be in, as Korean a screen can print.
 *
 * Three, not two. `완납` and `초과 납부` are both "nothing owed" and they are not
 * the same thing to tell somebody — one says you are square, the other says the
 * club is holding your money. Collapsing them is the same error as printing
 * "등록된 공지가 없습니다" over a failed fetch.
 */
export function balanceLabel(balance: number): string {
  if (balance === 0) return '완납'
  if (balance < 0) return `초과 납부 ${formatKrw(-balance)}`
  return `미납 ${formatKrw(balance)}`
}

// -------------------------------------------------------------------- totals

export type DuesTotals = {
  due: number
  paid: number
  balance: number
  /** Periods still owing something. A PARTIAL payment counts here. */
  unpaidCount: number
  /** Periods with nothing owed — fully paid or overpaid. */
  settledCount: number
}

/**
 * Roll a member's periods (or a period's members) into one set of totals.
 *
 * `balance` is the sum of the per-row balances rather than `due - paid` computed
 * once at the end. The two agree for these inputs, and summing per-row is the one
 * that keeps agreeing if a row is ever filtered out upstream.
 *
 * Note `unpaidCount` uses `> 0`, so a member who has paid 30,000 of 50,000 is
 * counted as unpaid. That is what a 미납자 list is for: they still owe.
 */
export function summariseDues(rows: readonly DuesAmounts[]): DuesTotals {
  let due = 0
  let paid = 0
  let balance = 0
  let unpaidCount = 0

  for (const row of rows) {
    const rowBalance = balanceOf(row.due_amount, row.paid_amount)
    due += row.due_amount
    paid += row.paid_amount
    balance += rowBalance
    if (rowBalance > 0) unpaidCount += 1
  }

  return { due, paid, balance, unpaidCount, settledCount: rows.length - unpaidCount }
}

export type ActivityFeeTotals = {
  sessionCount: number
  /** 참여횟수 — sessions this member actually settled. */
  paidCount: number
  unpaidCount: number
  /** 총 납부 누계 — what was actually collected. */
  collected: number
  /** What is still owed, counting ONLY the sessions that were not settled. */
  outstanding: number
}

/**
 * The session-fee half of the same arithmetic.
 *
 * `outstanding` sums `fee_amount` over UNPAID rows only. Summing it over every
 * row and subtracting `collected` would give the same answer whenever a payment
 * equals the session's fee — which is every row today, because
 * `set_activity_fee_payment_v1` copies the amount from the session. It stops
 * being the same answer the moment a session's fee is corrected after somebody
 * paid, which 0057 explicitly allows: the row keeps what was collected while the
 * session moves on. So the two formulations are not interchangeable, and this is
 * the one that means "what is still owed".
 */
export function summariseActivityFees(
  rows: readonly ActivityFeeAmounts[],
): ActivityFeeTotals {
  let paidCount = 0
  let collected = 0
  let outstanding = 0

  for (const row of rows) {
    if (row.paid) {
      paidCount += 1
      collected += row.paid_amount
    } else {
      outstanding += row.fee_amount
    }
  }

  return {
    sessionCount: rows.length,
    paidCount,
    unpaidCount: rows.length - paidCount,
    collected,
    outstanding,
  }
}

// -------------------------------------------------------- picking a new period

/** Which half a calendar month falls in. January is 1 here, not 0. */
export function halfOfMonth(month: number): Half {
  // <= 6, so June is 상반기 and July is 하반기. The club's sheet splits there:
  // `26년 상반기` covers the January–June sessions.
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
 * `그 반기는 이미 등록되어 있습니다` — a refusal the member did nothing to earn.
 *
 * `today` is a parameter rather than a `new Date()` inside, so a test can put the
 * clock in either half without faking timers. Same reason `isPollClosed` takes
 * one.
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
