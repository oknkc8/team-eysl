import { describe, it, expect } from 'vitest'
import {
  formatDateLabel,
  formatTimeRange,
  shiftDays,
  sortUpcomingFirst,
  todayKey,
} from './order'

const row = (activity_date: string, start_time: string | null = null) => ({
  activity_date,
  start_time,
})

describe('todayKey', () => {
  it('reads the local calendar day, not the UTC one', () => {
    // 09:00 local on the 25th is the 25th wherever this runs; a UTC-based
    // implementation would answer '2026-08-24' east of Greenwich.
    expect(todayKey(new Date(2026, 7, 25, 9, 0, 0))).toBe('2026-08-25')
  })

  it('pads single-digit months and days', () => {
    expect(todayKey(new Date(2026, 0, 5))).toBe('2026-01-05')
  })
})

describe('shiftDays', () => {
  it('rolls back across a month boundary', () => {
    expect(shiftDays('2026-01-05', -30)).toBe('2025-12-06')
  })

  it('rolls forward across a year boundary', () => {
    expect(shiftDays('2026-12-27', 10)).toBe('2027-01-06')
  })

  it('returns the input unchanged when it is not a date key', () => {
    expect(shiftDays('not-a-date', -30)).toBe('not-a-date')
  })
})

describe('formatDateLabel', () => {
  it('names the weekday of the local date, not of the UTC instant', () => {
    // 2026-09-02 is a Wednesday. Parsing the key as UTC would name Tuesday for
    // any reader west of Greenwich.
    expect(formatDateLabel('2026-09-02')).toBe('2026.09.02 (수)')
  })

  it('pads a single-digit month and day', () => {
    expect(formatDateLabel('2026-01-05')).toBe('2026.01.05 (월)')
  })

  it('passes an unrecognisable key straight through', () => {
    expect(formatDateLabel('nope')).toBe('nope')
  })
})

describe('formatTimeRange', () => {
  it('drops the seconds and joins both ends', () => {
    expect(formatTimeRange('19:30:00', '21:00:00')).toBe('19:30–21:00')
  })

  it('shows only the start when there is no end', () => {
    expect(formatTimeRange('06:00:00', null)).toBe('06:00')
  })

  it('shows nothing at all when there is no start', () => {
    expect(formatTimeRange(null, '21:00:00')).toBe('')
  })
})

describe('sortUpcomingFirst', () => {
  const TODAY = '2026-08-25'

  it('puts upcoming dates first in ascending order', () => {
    const sorted = sortUpcomingFirst(
      [row('2026-09-10'), row('2026-08-28'), row('2026-09-01')],
      TODAY,
    )
    expect(sorted.map((r) => r.activity_date)).toEqual(['2026-08-28', '2026-09-01', '2026-09-10'])
  })

  it('keeps today in the upcoming half', () => {
    const sorted = sortUpcomingFirst([row('2026-08-24'), row(TODAY)], TODAY)
    expect(sorted.map((r) => r.activity_date)).toEqual([TODAY, '2026-08-24'])
  })

  it('lists past dates after upcoming ones, most recent first', () => {
    const sorted = sortUpcomingFirst(
      [row('2026-08-01'), row('2026-08-30'), row('2026-08-20')],
      TODAY,
    )
    expect(sorted.map((r) => r.activity_date)).toEqual(['2026-08-30', '2026-08-20', '2026-08-01'])
  })

  it('breaks a same-day tie by start time, treating a missing one as earliest', () => {
    const sorted = sortUpcomingFirst(
      [row('2026-08-28', '19:30:00'), row('2026-08-28', null), row('2026-08-28', '06:00:00')],
      TODAY,
    )
    expect(sorted.map((r) => r.start_time)).toEqual([null, '06:00:00', '19:30:00'])
  })

  it('does not mutate the input', () => {
    const rows = [row('2026-09-10'), row('2026-08-28')]
    sortUpcomingFirst(rows, TODAY)
    expect(rows.map((r) => r.activity_date)).toEqual(['2026-09-10', '2026-08-28'])
  })
})
