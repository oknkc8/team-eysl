import { describe, it, expect } from 'vitest'
import { shiftDays, sortUpcomingFirst, todayKey } from './order'

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
