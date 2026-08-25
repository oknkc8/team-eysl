import { describe, it, expect } from 'vitest'
import { formatRelative } from './relativeTime'

const NOW = new Date('2026-08-25T09:30:00.000Z')

describe('formatRelative', () => {
  it('collapses the last minute to 방금 전', () => {
    expect(formatRelative('2026-08-25T09:29:31.000Z', NOW)).toBe('방금 전')
  })

  it('counts minutes, then hours, then days', () => {
    expect(formatRelative('2026-08-25T09:18:00.000Z', NOW)).toBe('12분 전')
    expect(formatRelative('2026-08-25T06:30:00.000Z', NOW)).toBe('3시간 전')
    expect(formatRelative('2026-08-20T09:30:00.000Z', NOW)).toBe('5일 전')
  })

  it('switches to a plain date past a week', () => {
    // The fallback renders in local time, so the day can land either side of
    // the UTC instant depending on where this runs.
    expect(formatRelative('2026-07-04T01:02:03.000Z', NOW)).toMatch(/^2026\.07\.0[34]$/)
  })

  // A comment written a moment ago on a device whose clock runs fast must not
  // render as a negative age.
  it('treats a future timestamp as 방금 전', () => {
    expect(formatRelative('2026-08-25T09:45:00.000Z', NOW)).toBe('방금 전')
  })

  it('returns an empty string for an unparseable value', () => {
    expect(formatRelative('not-a-date', NOW)).toBe('')
  })
})
