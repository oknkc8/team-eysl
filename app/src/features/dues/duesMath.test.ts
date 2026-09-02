import { describe, expect, it } from 'vitest'
import {
  comparePeriodsDesc,
  formatKrw,
  halfOfMonth,
  hasRecordedPayment,
  nextPeriod,
  periodLabel,
  recordLabel,
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
 *
 * The block at the bottom is the unusual one: it asserts that certain figures
 * are ABSENT. A test that guards an omission is the only thing standing between
 * this module and somebody helpfully "finishing" the balance.
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

  it('carries the sign of a negative amount', () => {
    expect(formatKrw(-10000)).toBe('-10,000원')
  })
})

describe('periodLabel', () => {
  it('names the two halves', () => {
    expect(periodLabel(2026, 1)).toBe('2026년 상반기')
    expect(periodLabel(2026, 2)).toBe('2026년 하반기')
  })
})

describe('hasRecordedPayment', () => {
  it('asks whether anything was entered, not whether the charge was met', () => {
    // A PARTIAL entry counts as recorded. Comparing against due_amount instead
    // would make this false and would assert a shortfall the data cannot show.
    expect(hasRecordedPayment({ due_amount: 50000, paid_amount: 30000 })).toBe(true)
    expect(hasRecordedPayment({ due_amount: 50000, paid_amount: 50000 })).toBe(true)
    expect(hasRecordedPayment({ due_amount: 50000, paid_amount: 1 })).toBe(true)
  })

  it('is false only when nothing has been entered', () => {
    expect(hasRecordedPayment({ due_amount: 50000, paid_amount: 0 })).toBe(false)
  })
})

describe('recordLabel', () => {
  it('describes the record and never adjudicates a debt', () => {
    expect(recordLabel({ due_amount: 50000, paid_amount: 30000 })).toBe('납부 기록 있음')
    expect(recordLabel({ due_amount: 50000, paid_amount: 0 })).toBe('납부 기록 없음')
  })

  it('never says 미납 or 완납', () => {
    // The words this module must not put on screen. A partial payment is the
    // case somebody would most naturally label 미납, so it is the one to pin.
    const labels = [
      recordLabel({ due_amount: 50000, paid_amount: 0 }),
      recordLabel({ due_amount: 50000, paid_amount: 30000 }),
      recordLabel({ due_amount: 50000, paid_amount: 50000 }),
      recordLabel({ due_amount: 50000, paid_amount: 60000 }),
    ]
    for (const label of labels) {
      expect(label).not.toContain('미납')
      expect(label).not.toContain('완납')
    }
  })
})

describe('summariseDues', () => {
  // 2026 상반기 fully entered, 2026 하반기 partly, 2025 하반기 not at all.
  // Every number is distinct so a swapped field cannot pass.
  const rows = [
    { due_amount: 50000, paid_amount: 50000 },
    { due_amount: 50000, paid_amount: 30000 },
    { due_amount: 40000, paid_amount: 0 },
  ]

  it('totals the charge side', () => {
    // 소계. Every charge is in this database, so this one is honest.
    expect(summariseDues(rows).due).toBe(140000)
  })

  it('counts rows with an entry, treating a PARTIAL entry as recorded', () => {
    const totals = summariseDues(rows)
    expect(totals.recordedCount).toBe(2)
    expect(totals.unrecordedCount).toBe(1)
  })

  it('does NOT expose a paid total or a balance', () => {
    // The guard on the omission. If somebody re-adds either field, this fails
    // and they have to come and read the header before proceeding.
    const totals = summariseDues(rows) as Record<string, unknown>
    expect(totals).not.toHaveProperty('paid')
    expect(totals).not.toHaveProperty('balance')
    expect(Object.keys(totals).sort()).toEqual(['due', 'recordedCount', 'unrecordedCount'])
  })

  it('returns zeroes rather than NaN for no rows', () => {
    expect(summariseDues([])).toEqual({ due: 0, recordedCount: 0, unrecordedCount: 0 })
  })
})

describe('summariseActivityFees', () => {
  const rows = [
    { fee_amount: 15000, paid: true, paid_amount: 15000 },
    { fee_amount: 20000, paid: false, paid_amount: 0 },
    // Entered before the session's fee was corrected downward: 18,000 recorded
    // against a session that now says 14,000. Kept as a row because it is what
    // makes `chargeTotal` and any would-be 수납 합계 different numbers.
    { fee_amount: 14000, paid: true, paid_amount: 18000 },
  ]

  it('counts sessions with an entry as 참여횟수', () => {
    const totals = summariseActivityFees(rows)
    expect(totals.paidCount).toBe(2)
    expect(totals.unpaidCount).toBe(1)
    expect(totals.sessionCount).toBe(3)
  })

  it('totals what the sessions cost, over every row', () => {
    // 15000 + 20000 + 14000. Counting only settled rows would give 29000.
    expect(summariseActivityFees(rows).chargeTotal).toBe(49000)
  })

  it('does NOT expose a collected or outstanding figure', () => {
    const totals = summariseActivityFees(rows) as Record<string, unknown>
    expect(totals).not.toHaveProperty('collected')
    expect(totals).not.toHaveProperty('outstanding')
    expect(Object.keys(totals).sort()).toEqual([
      'chargeTotal',
      'paidCount',
      'sessionCount',
      'unpaidCount',
    ])
  })

  it('returns zeroes rather than NaN for no rows', () => {
    expect(summariseActivityFees([])).toEqual({
      sessionCount: 0,
      paidCount: 0,
      unpaidCount: 0,
      chargeTotal: 0,
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
