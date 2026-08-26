import { describe, it, expect } from 'vitest'
import {
  MAX_SPAN_DAYS,
  coversDate,
  datesInRange,
  formatDateRange,
  isMultiDay,
  lastDayOfMonth,
  monthGrid,
  monthPrefix,
  stepMonth,
} from './calendar'
import { formatDateLabel } from './order'

describe('monthGrid', () => {
  // 2026-03-01 is a Sunday, so the grid starts flush with no leading blanks —
  // the one case where an off-by-one in the blank count is invisible.
  it('starts flush when the 1st is a Sunday', () => {
    const cells = monthGrid(2026, 3)
    expect(cells[0]).toEqual({ key: '2026-03-01', day: 1 })
    expect(cells).toHaveLength(31)
  })

  // 2026-04-01 is a Wednesday: three blanks before it.
  it('pads the first week with blanks', () => {
    const cells = monthGrid(2026, 4)
    expect(cells.slice(0, 3)).toEqual([null, null, null])
    expect(cells[3]).toEqual({ key: '2026-04-01', day: 1 })
    expect(cells).toHaveLength(3 + 30)
  })

  it('gets February right in a leap year and out of one', () => {
    expect(monthGrid(2024, 2).filter(Boolean)).toHaveLength(29)
    expect(monthGrid(2026, 2).filter(Boolean)).toHaveLength(28)
  })

  it('zero-pads the keys so they sort and compare as strings', () => {
    const cells = monthGrid(2026, 3).filter(Boolean)
    expect(cells[0]).toMatchObject({ key: '2026-03-01' })
    expect(cells[8]).toMatchObject({ key: '2026-03-09' })
    expect(monthPrefix(2026, 3)).toBe('2026-03')
  })
})

describe('lastDayOfMonth', () => {
  it('knows how long each month is', () => {
    expect(lastDayOfMonth(2026, 3)).toBe('2026-03-31')
    expect(lastDayOfMonth(2026, 4)).toBe('2026-04-30')
  })

  // The month-window query uses this as its upper bound, so February in a leap
  // year is the case that would silently drop the 29th off the calendar.
  it('gets February right either way', () => {
    expect(lastDayOfMonth(2024, 2)).toBe('2024-02-29')
    expect(lastDayOfMonth(2026, 2)).toBe('2026-02-28')
  })
})

describe('datesInRange', () => {
  it('is one day when there is no end', () => {
    expect(datesInRange('2026-03-02', null)).toEqual(['2026-03-02'])
    expect(datesInRange('2026-03-02', undefined)).toEqual(['2026-03-02'])
    expect(datesInRange('2026-03-02', '')).toEqual(['2026-03-02'])
  })

  it('is one day when the end equals the start', () => {
    expect(datesInRange('2026-03-02', '2026-03-02')).toEqual(['2026-03-02'])
  })

  it('covers both ends inclusively', () => {
    expect(datesInRange('2026-03-02', '2026-03-04')).toEqual([
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
    ])
  })

  // The arithmetic string comparison alone cannot do: the range has to walk into
  // the next month, and '2026-03-31' < '2026-04-01' only because the keys are
  // zero-padded.
  it('walks across a month boundary', () => {
    expect(datesInRange('2026-03-30', '2026-04-02')).toEqual([
      '2026-03-30',
      '2026-03-31',
      '2026-04-01',
      '2026-04-02',
    ])
  })

  it('walks across a year boundary', () => {
    expect(datesInRange('2026-12-31', '2027-01-02')).toEqual([
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ])
  })

  it('walks across 29 February in a leap year', () => {
    expect(datesInRange('2024-02-28', '2024-03-01')).toEqual([
      '2024-02-28',
      '2024-02-29',
      '2024-03-01',
    ])
  })

  // A backwards range is malformed rather than empty. Returning [] would take
  // the activity off the calendar altogether, which hides a row that exists —
  // worse than showing it on its start date.
  it('reads a backwards range as a single day', () => {
    expect(datesInRange('2026-03-04', '2026-03-02')).toEqual(['2026-03-04'])
  })

  // The render loop must terminate whatever is in the column. A frozen tab is a
  // worse failure than a truncated range, and the CHECK already refuses the only
  // shape that could loop forever.
  it('stops at the span cap rather than building an unbounded array', () => {
    const keys = datesInRange('2026-01-01', '2099-01-01')
    expect(keys).toHaveLength(MAX_SPAN_DAYS)
    expect(keys[0]).toBe('2026-01-01')
  })

  it('returns nothing for a missing start', () => {
    expect(datesInRange('', '2026-03-04')).toEqual([])
  })
})

describe('coversDate', () => {
  const race = { activity_date: '2026-03-02', end_date: '2026-03-04' }

  it('covers every day of the range and neither day outside it', () => {
    expect(coversDate(race, '2026-03-01')).toBe(false)
    expect(coversDate(race, '2026-03-02')).toBe(true)
    expect(coversDate(race, '2026-03-03')).toBe(true)
    expect(coversDate(race, '2026-03-04')).toBe(true)
    expect(coversDate(race, '2026-03-05')).toBe(false)
  })

  it('covers only its own day without an end', () => {
    const training = { activity_date: '2026-03-02', end_date: null }
    expect(coversDate(training, '2026-03-02')).toBe(true)
    expect(coversDate(training, '2026-03-03')).toBe(false)
  })

  // Same reasoning as datesInRange: a backwards end collapses to the start
  // rather than making the row uncoverable on any day.
  it('ignores an end that precedes the start', () => {
    const broken = { activity_date: '2026-03-04', end_date: '2026-03-02' }
    expect(coversDate(broken, '2026-03-04')).toBe(true)
    expect(coversDate(broken, '2026-03-03')).toBe(false)
  })
})

describe('isMultiDay', () => {
  it('is true only when the end is genuinely later', () => {
    expect(isMultiDay({ activity_date: '2026-03-02', end_date: '2026-03-04' })).toBe(true)
    expect(isMultiDay({ activity_date: '2026-03-02', end_date: '2026-03-02' })).toBe(false)
    expect(isMultiDay({ activity_date: '2026-03-02', end_date: null })).toBe(false)
  })
})

describe('formatDateRange', () => {
  it('shows one date when there is no range', () => {
    expect(formatDateRange('2026-03-02', null, formatDateLabel)).toBe('2026.03.02 (월)')
  })

  it('shows both ends when there is', () => {
    expect(formatDateRange('2026-03-02', '2026-03-04', formatDateLabel)).toBe(
      '2026.03.02 (월) ~ 2026.03.04 (수)',
    )
  })

  it('does not print a range for an end that equals the start', () => {
    expect(formatDateRange('2026-03-02', '2026-03-02', formatDateLabel)).toBe('2026.03.02 (월)')
  })
})

describe('stepMonth', () => {
  it('steps within a year', () => {
    expect(stepMonth(2026, 3, 1)).toEqual({ year: 2026, month: 4 })
    expect(stepMonth(2026, 3, -1)).toEqual({ year: 2026, month: 2 })
  })

  it('carries across the year boundary both ways', () => {
    expect(stepMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 })
    expect(stepMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 })
  })

  // The edge his Date-mutating version has and this one does not: stepping a
  // month from the 31st has no day-of-month to overflow here.
  it('is unaffected by the day of the month', () => {
    expect(stepMonth(2026, 1, 1)).toEqual({ year: 2026, month: 2 })
  })
})
