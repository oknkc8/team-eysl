import { describe, expect, it } from 'vitest'
import {
  candidateTimeFromCells,
  detectResultTime,
  looksLikeSwimTimeValue,
  normalizeResultForStorage,
  plausibleSwimTime,
  resultSeconds,
} from './swimTime'

// The plausibility windows are the safety rail of the whole parser: they are
// what stands between "a number in the 기록 column" and "a personal best on
// somebody's profile". The boundary cases below are asserted on both sides,
// because a window one second too wide is invisible until it files a lane
// number as a swim.

describe('looksLikeSwimTimeValue', () => {
  it('accepts a cell that is a time and nothing else', () => {
    expect(looksLikeSwimTimeValue('27.31')).toBe(true)
    expect(looksLikeSwimTimeValue('1:02.55')).toBe(true)
    expect(looksLikeSwimTimeValue('105.4')).toBe(true)
  })

  it('refuses a bare integer, which on a meet sheet is a rank or a lane', () => {
    expect(looksLikeSwimTimeValue('3')).toBe(false)
    expect(looksLikeSwimTimeValue('27')).toBe(false)
    expect(looksLikeSwimTimeValue('2026')).toBe(false)
  })

  it('refuses a single seconds digit and an empty cell', () => {
    expect(looksLikeSwimTimeValue('7.5')).toBe(false)
    expect(looksLikeSwimTimeValue('')).toBe(false)
    expect(looksLikeSwimTimeValue('DQ')).toBe(false)
  })

  it('refuses a cell that merely contains a time', () => {
    // detectResultTime would happily pull '27.31' out of this; the caller asks
    // this question first precisely so a memo column cannot become a record.
    expect(looksLikeSwimTimeValue('기록 27.31 (참고)')).toBe(false)
  })
})

describe('detectResultTime', () => {
  it('pulls the first time out of a longer string', () => {
    expect(detectResultTime('기록 27.31 (참고)')).toBe('27.31')
    expect(detectResultTime('1:02.55 예선')).toBe('1:02.55')
  })

  it('reads a comma as a decimal point', () => {
    expect(detectResultTime('27,31')).toBe('27.31')
  })

  it('reads the 초 spelling, which only the unported PDF path produced', () => {
    expect(detectResultTime('33초08')).toBe('33.08')
  })

  it("returns '' when there is no time at all", () => {
    expect(detectResultTime('실격')).toBe('')
  })
})

describe('resultSeconds', () => {
  it('reads every spelling as seconds', () => {
    expect(resultSeconds('27.31')).toBeCloseTo(27.31, 5)
    expect(resultSeconds('1:05.32')).toBeCloseTo(65.32, 5)
    expect(resultSeconds('33초08')).toBeCloseTo(33.08, 5)
  })

  it('reads a leading zero as what it says, not as what was meant', () => {
    // '05.10' in a 기록 column is five seconds. It is *not* quietly read as
    // 5:10 or as 1:05.10 — it is read literally and then refused by the
    // distance window, which is the only honest way to treat it.
    expect(resultSeconds('05.10')).toBeCloseTo(5.1, 5)
  })

  it('returns null for nothing at all', () => {
    expect(resultSeconds(null)).toBeNull()
    expect(resultSeconds('')).toBeNull()
  })
})

describe('normalizeResultForStorage', () => {
  it('writes under a minute as seconds and over as minutes', () => {
    expect(normalizeResultForStorage(27.31)).toBe('27.31')
    expect(normalizeResultForStorage(65.32)).toBe('1:05.32')
  })

  it('promotes exactly sixty seconds to a minute', () => {
    // Otherwise 60.00 and 0.00 would both read as a number of seconds with no
    // minute, and one of them is not a swim.
    expect(normalizeResultForStorage(60)).toBe('1:00.00')
    expect(normalizeResultForStorage('59.99')).toBe('59.99')
  })

  it('pads the seconds so the string always reads as m:ss.cc', () => {
    expect(normalizeResultForStorage(65)).toBe('1:05.00')
  })

  it("returns '' rather than a plausible-looking string for a non-time", () => {
    expect(normalizeResultForStorage('실격')).toBe('')
    expect(normalizeResultForStorage(0)).toBe('')
  })
})

describe('plausibleSwimTime', () => {
  it('accepts a 50m at both ends of what a club swims', () => {
    expect(plausibleSwimTime('15.00', 50)).toBe(true)
    expect(plausibleSwimTime('27.31', 50)).toBe(true)
    expect(plausibleSwimTime('179.99', 50)).toBe(true)
  })

  it('refuses a 50m nobody swam', () => {
    // Just under the floor: a rank, a lane, an entry fee, a head count.
    expect(plausibleSwimTime('14.99', 50)).toBe(false)
    expect(plausibleSwimTime('05.10', 50)).toBe(false)
    // Just over the ceiling: three minutes for a 50m is a mis-read column.
    expect(plausibleSwimTime('180.00', 50)).toBe(false)
  })

  it('scales the window with the distance', () => {
    expect(plausibleSwimTime('27.31', 100)).toBe(false)
    expect(plausibleSwimTime('1:02.55', 100)).toBe(true)
    expect(plausibleSwimTime('1:02.55', 400)).toBe(false)
    expect(plausibleSwimTime('7.00', 25)).toBe(true)
    expect(plausibleSwimTime('6.99', 25)).toBe(false)
  })

  it('falls back to a loose window when the distance is unknown', () => {
    // Which is why the caller also insists on a stroke: this window alone
    // would accept almost any number on the sheet.
    expect(plausibleSwimTime('27.31', null)).toBe(true)
    expect(plausibleSwimTime('9.99', null)).toBe(false)
    expect(plausibleSwimTime('1800.00', null)).toBe(false)
  })

  it('checks a relay leg far more loosely, but still checks it', () => {
    expect(plausibleSwimTime('2:05.31', 200, true)).toBe(true)
    // A 200m relay in under forty seconds is a heading, not a swim.
    expect(plausibleSwimTime('39.99', 200, true)).toBe(false)
    expect(plausibleSwimTime('19.99', 100, true)).toBe(false)
    expect(plausibleSwimTime('20.00', 100, true)).toBe(true)
  })

  it('refuses anything that is not a positive time', () => {
    expect(plausibleSwimTime('', 50)).toBe(false)
    expect(plausibleSwimTime('실격', 50)).toBe(false)
  })
})

describe('candidateTimeFromCells', () => {
  it('prefers a reading with real hundredths over a rounded one', () => {
    // A sheet often prints an official rounded time beside the timed one. The
    // legacy filed 33.00 for a 33.08 swim until this sort was added.
    expect(candidateTimeFromCells(['33.00', '33.08'], 50)).toBe('33.08')
    expect(candidateTimeFromCells(['33.08', '33.00'], 50)).toBe('33.08')
  })

  it('ignores cells that are not times, and times that are not plausible', () => {
    expect(candidateTimeFromCells(['1', '김철수', 'EYSL', '05.10', '31.05'], 50)).toBe('31.05')
  })

  it("returns '' when the group holds no usable time", () => {
    expect(candidateTimeFromCells(['1', '김철수', 'EYSL'], 50)).toBe('')
  })
})
