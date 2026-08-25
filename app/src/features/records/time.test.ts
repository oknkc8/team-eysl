import { describe, it, expect } from 'vitest'
import { formatCentiseconds, formatDelta, parseSwimTime } from './time'

describe('formatCentiseconds', () => {
  it('prints a sub-minute swim without a leading minute', () => {
    expect(formatCentiseconds(3308)).toBe('33.08')
    expect(formatCentiseconds(5999)).toBe('59.99')
  })

  it('pads the hundredths but not the seconds below a minute', () => {
    expect(formatCentiseconds(908)).toBe('9.08')
    expect(formatCentiseconds(8)).toBe('0.08')
    expect(formatCentiseconds(0)).toBe('0.00')
  })

  // The boundary the whole format turns on: one centisecond either side of a
  // minute has to land on a different shape, or 6000 and 0 both read '0.00'.
  it('rolls into minutes at exactly 60 seconds', () => {
    expect(formatCentiseconds(6000)).toBe('1:00.00')
    expect(formatCentiseconds(5999)).toBe('59.99')
    expect(formatCentiseconds(6001)).toBe('1:00.01')
  })

  it('pads the seconds once a minute is on the clock', () => {
    expect(formatCentiseconds(6532)).toBe('1:05.32')
    expect(formatCentiseconds(7000)).toBe('1:10.00')
    expect(formatCentiseconds(11_999)).toBe('1:59.99')
  })

  it('keeps counting in minutes past an hour rather than adding an hours field', () => {
    expect(formatCentiseconds(360_000)).toBe('60:00.00')
  })

  // Number('a') is NaN, not undefined — the exact hole a length check leaves
  // open, and how a previous helper printed 'NaN-NaN-NaN' onto a record card.
  it('refuses anything that is not a whole count of centiseconds', () => {
    expect(formatCentiseconds(Number('a'))).toBeNull()
    expect(formatCentiseconds(Number.NaN)).toBeNull()
    expect(formatCentiseconds(Number.POSITIVE_INFINITY)).toBeNull()
    expect(formatCentiseconds(-1)).toBeNull()
    expect(formatCentiseconds(33.5)).toBeNull()
  })
})

describe('parseSwimTime', () => {
  it('reads a sub-minute time', () => {
    expect(parseSwimTime('33.08')).toBe(3308)
    expect(parseSwimTime('9.08')).toBe(908)
    expect(parseSwimTime('59.99')).toBe(5999)
  })

  it('reads a time over a minute', () => {
    expect(parseSwimTime('1:05.32')).toBe(6532)
    expect(parseSwimTime('12:34.56')).toBe(75_456)
  })

  // Without a minute written down, sixty seconds is unambiguous and normalises
  // on the way back out; with one, the sheet is unreadable.
  it('accepts a bare 60 seconds but not 60 seconds inside a minute', () => {
    expect(parseSwimTime('60.00')).toBe(6000)
    expect(formatCentiseconds(6000)).toBe('1:00.00')
    expect(parseSwimTime('1:60.00')).toBeNull()
    expect(parseSwimTime('1:99.00')).toBeNull()
  })

  it('treats a single fractional digit as tenths', () => {
    expect(parseSwimTime('33.8')).toBe(3380)
    expect(parseSwimTime('1:05.3')).toBe(6530)
  })

  it('allows the hundredths to be left off entirely', () => {
    expect(parseSwimTime('33')).toBe(3300)
    expect(parseSwimTime('1:05')).toBe(6500)
  })

  it('ignores surrounding whitespace', () => {
    expect(parseSwimTime('  1:05.32  ')).toBe(6532)
  })

  it('returns null for malformed input rather than NaN', () => {
    for (const bad of [
      'a',
      '',
      '   ',
      'abc.de',
      '33,08',
      '1:2:3',
      '-5.00',
      '33.081', // three fractional digits are refused, not rounded
      '1:',
      ':05.32',
      '33.',
      '1:05.32초',
      '１:０５.３２', // full-width digits
    ]) {
      expect(parseSwimTime(bad), `expected ${JSON.stringify(bad)} to be rejected`).toBeNull()
    }
  })

  // The property that matters: whatever the screen prints, the form can read
  // back. Both directions live in one module precisely so this holds.
  it('round-trips every value formatCentiseconds can produce', () => {
    for (const cs of [0, 8, 99, 100, 908, 3308, 5999, 6000, 6001, 6532, 75_456, 360_000]) {
      const printed = formatCentiseconds(cs)
      expect(printed).not.toBeNull()
      expect(parseSwimTime(printed as string)).toBe(cs)
    }
  })
})

describe('formatDelta', () => {
  it('marks a faster swim with a minus and a slower one with a plus', () => {
    expect(formatDelta(-57)).toBe('-0.57')
    expect(formatDelta(124)).toBe('+1.24')
  })

  it('spans a minute the same way a time does', () => {
    expect(formatDelta(-6532)).toBe('-1:05.32')
  })

  it('shows an unchanged time as neither faster nor slower', () => {
    expect(formatDelta(0)).toBe('±0.00')
  })

  it('refuses a delta that is not a whole count of centiseconds', () => {
    expect(formatDelta(Number('a'))).toBeNull()
    expect(formatDelta(Number.NaN)).toBeNull()
    expect(formatDelta(1.5)).toBeNull()
  })
})
