import { describe, it, expect } from 'vitest'
import { seoulTodayKey, seoulYearMonth } from './seoulDate'

/*
 * Every instant below is chosen so the device and Seoul disagree about the date.
 * That disagreement is the entire defect: a member on the US west coast opening
 * the app late on 31 August is looking at a club that is already on 1 September.
 */
describe('seoulTodayKey', () => {
  it('is already tomorrow in Seoul when UTC is still on the previous evening', () => {
    // 15:00Z on 31 August is 00:00 on 1 September in Seoul (UTC+9).
    expect(seoulTodayKey(new Date('2026-08-31T15:00:00Z'))).toBe('2026-09-01')
  })

  it('crosses the year boundary the same way', () => {
    expect(seoulTodayKey(new Date('2025-12-31T15:30:00Z'))).toBe('2026-01-01')
  })

  it('agrees with UTC in the middle of a Seoul day', () => {
    expect(seoulTodayKey(new Date('2026-03-15T03:00:00Z'))).toBe('2026-03-15')
  })

  it('has not rolled over just before Seoul midnight', () => {
    expect(seoulTodayKey(new Date('2026-08-31T14:59:00Z'))).toBe('2026-08-31')
  })
})

describe('seoulYearMonth', () => {
  it('opens on the month Seoul is in, not the device', () => {
    expect(seoulYearMonth(new Date('2026-08-31T15:00:00Z'))).toEqual({ year: 2026, month: 9 })
  })

  it('carries the year', () => {
    expect(seoulYearMonth(new Date('2025-12-31T15:30:00Z'))).toEqual({ year: 2026, month: 1 })
  })
})
