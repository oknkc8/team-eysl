import { describe, expect, it } from 'vitest'
import {
  balanceLabel,
  balanceOf,
  comparePeriodsDesc,
  formatKrw,
  halfOfMonth,
  isSettled,
  nextPeriod,
  periodLabel,
  summariseActivityFees,
  summariseDues,
  type PeriodKey,
} from './duesMath'

/**
 * Every assertion here is written so that BREAKING THE RULE BREAKS THE TEST.
 *
 * That sounds like what all tests do and it is not. `expect(total).toBeDefined()`
 * passes over a wrong total; `expect(rows.length).toBe(3)` passes when every
 * amount in those three rows is garbage. This project has the scar: an e2e suite
 * asserted `expect(h1).toBeVisible()` on three screens and could not have failed
 * on the emptiness it was there to guard against.
 *
 * So each block below fixes an exact number, and the numbers are chosen so that
 * the obvious wrong implementation produces a DIFFERENT one — asymmetric inputs
 * rather than `1 + 1`, which survives being turned into multiplication.
 */

describe('formatKrw', () => {
  it('groups thousands and keeps the 원 suffix', () => {
    expect(formatKrw(50000)).toBe('50,000원')
    expect(formatKrw(1234567)).toBe('1,234,567원')
  })

  it('does not put a comma in front of a three-digit amount', () => {
    // The `\B` in the grouping regex is the whole reason this passes. Without it
    // the result is ',100원'.
    expect(formatKrw(100)).toBe('100원')
    expect(formatKrw(0)).toBe('0원')
  })

  it('carries the sign of an overpayment', () => {
    expect(formatKrw(-10000)).toBe('-10,000원')
  })
})

describe('periodLabel', () => {
  it('names the two halves', () => {
    expect(periodLabel(2026, 1)).toBe('2026년 상반기')
    expect(periodLabel(2026, 2)).toBe('2026년 하반기')
  })
})

describe('balanceOf', () => {
  it('is due minus paid, in that order', () => {
    // Asymmetric on purpose: 50000 - 30000 is 20000, and the reversed subtraction
    // gives -20000. A symmetric pair would let `paid - due` pass.
    expect(balanceOf(50000, 30000)).toBe(20000)
  })

  it('goes negative when the member overpaid, rather than clamping', () => {
    expect(balanceOf(50000, 60000)).toBe(-10000)
  })

  it('is zero when settled exactly', () => {
    expect(balanceOf(50000, 50000)).toBe(0)
  })
})

describe('isSettled', () => {
  it('treats an overpayment as settled and a partial payment as not', () => {
    expect(isSettled(0)).toBe(true)
    expect(isSettled(-10000)).toBe(true)
    // 1원 outstanding is still outstanding. `>= 0` instead of `> 0` upstream
    // would make this true.
    expect(isSettled(1)).toBe(false)
    expect(isSettled(20000)).toBe(false)
  })
})

describe('balanceLabel', () => {
  it('says something different for each of the three states', () => {
    expect(balanceLabel(0)).toBe('완납')
    expect(balanceLabel(20000)).toBe('미납 20,000원')
    // The minus is absorbed into the word 초과, so the number reads positive.
    expect(balanceLabel(-10000)).toBe('초과 납부 10,000원')
  })

  it('gives the three states three distinct strings', () => {
    const labels = new Set([balanceLabel(0), balanceLabel(20000), balanceLabel(-10000)])
    expect(labels.size).toBe(3)
  })
})

describe('summariseDues', () => {
  // 2026 상반기 paid in full, 2026 하반기 paid partly, 2025 하반기 not paid.
  // Every number below is distinct so a swapped field cannot pass.
  const rows = [
    { due_amount: 50000, paid_amount: 50000 },
    { due_amount: 50000, paid_amount: 30000 },
    { due_amount: 40000, paid_amount: 0 },
  ]

  it('totals the three columns', () => {
    const totals = summariseDues(rows)
    expect(totals.due).toBe(140000)
    expect(totals.paid).toBe(80000)
    expect(totals.balance).toBe(60000)
  })

  it('counts a PARTIAL payment as unpaid', () => {
    const totals = summariseDues(rows)
    // Two periods still owe: the partial one and the untouched one.
    expect(totals.unpaidCount).toBe(2)
    expect(totals.settledCount).toBe(1)
  })

  it('does not count an overpaid period as unpaid', () => {
    const totals = summariseDues([{ due_amount: 50000, paid_amount: 60000 }])
    expect(totals.unpaidCount).toBe(0)
    expect(totals.settledCount).toBe(1)
    expect(totals.balance).toBe(-10000)
  })

  it('returns zeroes rather than NaN for no rows', () => {
    // An empty club is a real state — a period created before anybody pays. The
    // screen must be able to print these.
    expect(summariseDues([])).toEqual({
      due: 0,
      paid: 0,
      balance: 0,
      unpaidCount: 0,
      settledCount: 0,
    })
  })

  it('ignores a balance the server sent that disagrees with its own operands', () => {
    // The belt-and-braces rule from the module header. This payload could only
    // come from a stale RPC or a rewritten body, and the total must follow the
    // operands rather than the bogus column.
    const bogus = [
      { due_amount: 50000, paid_amount: 30000, balance: 999999 },
    ] as unknown as { due_amount: number; paid_amount: number }[]
    expect(summariseDues(bogus).balance).toBe(20000)
  })
})

describe('summariseActivityFees', () => {
  const rows = [
    { fee_amount: 15000, paid: true, paid_amount: 15000 },
    { fee_amount: 20000, paid: false, paid_amount: 0 },
    // Paid before the session's fee was corrected downward: collected 18,000
    // against a session that now says 14,000. This row is why `outstanding`
    // cannot be computed as (sum of all fees) - collected.
    { fee_amount: 14000, paid: true, paid_amount: 18000 },
  ]

  it('counts settled sessions as 참여횟수', () => {
    expect(summariseActivityFees(rows).paidCount).toBe(2)
    expect(summariseActivityFees(rows).unpaidCount).toBe(1)
    expect(summariseActivityFees(rows).sessionCount).toBe(3)
  })

  it('collects what was actually taken, not what the sessions now cost', () => {
    // 15000 + 18000. Reading fee_amount instead of paid_amount gives 29000.
    expect(summariseActivityFees(rows).collected).toBe(33000)
  })

  it('counts only unpaid sessions as outstanding', () => {
    const totals = summariseActivityFees(rows)
    // Just the 20,000 session. The whole-set formulation — every fee (49,000)
    // minus collected (33,000) — gives 16,000, so this assertion is what pins
    // the correct one.
    expect(totals.outstanding).toBe(20000)
    expect(totals.outstanding).not.toBe(49000 - totals.collected)
  })

  it('returns zeroes rather than NaN for no rows', () => {
    expect(summariseActivityFees([])).toEqual({
      sessionCount: 0,
      paidCount: 0,
      unpaidCount: 0,
      collected: 0,
      outstanding: 0,
    })
  })
})

describe('halfOfMonth', () => {
  it('splits at the end of June', () => {
    expect(halfOfMonth(1)).toBe(1)
    // The boundary in both directions. `< 6` upstream breaks the first of these,
    // `<= 7` the second.
    expect(halfOfMonth(6)).toBe(1)
    expect(halfOfMonth(7)).toBe(2)
    expect(halfOfMonth(12)).toBe(2)
  })
})

describe('comparePeriodsDesc', () => {
  it('puts the newest half first', () => {
    const periods: PeriodKey[] = [
      { year: 2025, half: 2 },
      { year: 2026, half: 2 },
      { year: 2026, half: 1 },
    ]
    expect([...periods].sort(comparePeriodsDesc)).toEqual([
      { year: 2026, half: 2 },
      { year: 2026, half: 1 },
      { year: 2025, half: 2 },
    ])
  })
})

describe('nextPeriod', () => {
  it('uses today when the club has no periods yet', () => {
    // March 2026 -> 상반기. Month is 0-based in the Date constructor.
    expect(nextPeriod([], new Date(2026, 2, 15))).toEqual({ year: 2026, half: 1 })
    // September 2026 -> 하반기.
    expect(nextPeriod([], new Date(2026, 8, 15))).toEqual({ year: 2026, half: 2 })
  })

  it('follows 상반기 with 하반기 in the same year', () => {
    expect(nextPeriod([{ year: 2026, half: 1 }])).toEqual({ year: 2026, half: 2 })
  })

  it('ROLLS OVER: after 하반기 comes the next year, not the same one', () => {
    // The mistake this exists to catch. Without the rollover the answer is
    // 2026 하반기 again — a period that already exists, which the database then
    // refuses with 그 반기는 이미 등록되어 있습니다.
    expect(nextPeriod([{ year: 2026, half: 2 }])).toEqual({ year: 2027, half: 1 })
  })

  it('finds the newest period without being handed a sorted list', () => {
    const periods: PeriodKey[] = [
      { year: 2025, half: 2 },
      { year: 2026, half: 2 },
      { year: 2026, half: 1 },
    ]
    expect(nextPeriod(periods)).toEqual({ year: 2027, half: 1 })
  })

  it('does not reorder the array it was given', () => {
    // The screen is rendering this list. Sorting it in place would reshuffle the
    // rows under the reader as a side effect of opening a form.
    const periods: PeriodKey[] = [
      { year: 2025, half: 2 },
      { year: 2026, half: 2 },
    ]
    nextPeriod(periods)
    expect(periods).toEqual([
      { year: 2025, half: 2 },
      { year: 2026, half: 2 },
    ])
  })

  it('ignores the clock once any period exists', () => {
    // Two very different "today"s, one answer: the successor is decided by the
    // data, not by when somebody opened the form.
    const periods: PeriodKey[] = [{ year: 2026, half: 1 }]
    expect(nextPeriod(periods, new Date(2030, 0, 1))).toEqual({ year: 2026, half: 2 })
    expect(nextPeriod(periods, new Date(2020, 11, 31))).toEqual({ year: 2026, half: 2 })
  })
})
