import { describe, it, expect } from 'vitest'
import { formatCountdown, msUntil } from './countdown'

const NOW = new Date('2026-08-25T09:30:00.000Z')

describe('msUntil', () => {
  it('measures the gap to a future instant', () => {
    expect(msUntil('2026-08-25T09:31:30.000Z', NOW)).toBe(90_000)
  })

  it('floors a passed deadline at zero rather than going negative', () => {
    expect(msUntil('2026-08-25T09:00:00.000Z', NOW)).toBe(0)
  })

  // A missing or broken expiry must read as expired, never as "plenty of time":
  // the 수락 button is disabled off the back of this number.
  it('treats a missing expiry as already expired', () => {
    expect(msUntil(null, NOW)).toBe(0)
    expect(msUntil(undefined, NOW)).toBe(0)
  })

  it('treats an unparseable expiry as already expired', () => {
    expect(msUntil('nope', NOW)).toBe(0)
  })
})

describe('formatCountdown', () => {
  it('drops to days and hours for a long window', () => {
    expect(formatCountdown(36 * 3_600_000)).toBe('1일 12시간 남음')
  })

  it('shows hours and minutes for the usual 12-hour offer', () => {
    expect(formatCountdown(11 * 3_600_000 + 42 * 60_000 + 30_000)).toBe('11시간 42분 남음')
  })

  it('pads the seconds once only minutes are left', () => {
    expect(formatCountdown(4 * 60_000 + 9_000)).toBe('4분 09초 남음')
  })

  it('counts bare seconds in the last minute', () => {
    expect(formatCountdown(7_400)).toBe('7초 남음')
  })

  it('returns null at and past zero so the caller can say what happens next', () => {
    expect(formatCountdown(0)).toBeNull()
    expect(formatCountdown(-1)).toBeNull()
    expect(formatCountdown(Number.NaN)).toBeNull()
  })
})
