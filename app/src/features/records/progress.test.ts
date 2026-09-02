import { describe, expect, it } from 'vitest'

import { normaliseStroke, progressSeries, type Swimmable } from './progress'

// noUncheckedIndexedAccess is on, so every indexed read is `T | undefined`.
// Throwing here rather than asserting with `!` means a wrong assumption fails
// as a test failure with a message, not as a TypeError three lines later.
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value, got undefined')
  return value
}


let seq = 0
const swim = (over: Partial<Swimmable> = {}): Swimmable => ({
  id: `r${(seq += 1)}`,
  category: 'meet',
  subcategory: 'personal',
  stroke: '자유형',
  distance_m: 50,
  event_date: '2026-01-01',
  created_at: '2026-01-01T00:00:00Z',
  result_centiseconds: 3000,
  ...over,
})

describe('normaliseStroke', () => {
  it('passes the four charted strokes through', () => {
    for (const s of ['자유형', '배영', '평영', '접영']) expect(normaliseStroke(s)).toBe(s)
  })

  // The reason this function exists. The club workbook carries round suffixes,
  // and 0041 had to solve the same thing by prefix because an equality test
  // "silently drops them". On a chart the failure is louder, not quieter: the
  // suffixed swim becomes its own one-point line beside the real one.
  it('folds a round suffix back into its stroke', () => {
    expect(normaliseStroke('배영(결승)')).toBe('배영')
    expect(normaliseStroke('배영(예선)')).toBe('배영')
    expect(normaliseStroke('자유형(결승)')).toBe('자유형')
  })

  // 개인혼영 is a real stroke in this data and is deliberately not charted —
  // 0041 leaves it out too, so a member comparing the chart to their ranking
  // does not find a fifth line here. Returning null keeps it out without
  // folding it into a stroke it is not.
  it('returns null for anything outside the four', () => {
    expect(normaliseStroke('개인혼영')).toBeNull()
    expect(normaliseStroke('')).toBeNull()
    expect(normaliseStroke('접')).toBeNull()
  })
})

describe('progressSeries', () => {
  it('orders points oldest first, the way a chart reads', () => {
    const series = must(
      progressSeries([
        swim({ event_date: '2026-05-01', result_centiseconds: 2900 }),
        swim({ event_date: '2026-01-01', result_centiseconds: 3100 }),
        swim({ event_date: '2026-03-01', result_centiseconds: 3000 }),
      ])[0],
    )
    expect(series.points.map((p) => p.event_date)).toEqual([
      '2026-01-01',
      '2026-03-01',
      '2026-05-01',
    ])
  })

  it('marks only the swims that beat everything before them', () => {
    const series = must(
      progressSeries([
        swim({ event_date: '2026-01-01', result_centiseconds: 3100 }),
        swim({ event_date: '2026-02-01', result_centiseconds: 3000 }),
        swim({ event_date: '2026-03-01', result_centiseconds: 3050 }),
        swim({ event_date: '2026-04-01', result_centiseconds: 2900 }),
      ])[0],
    )
    expect(series.points.map((p) => p.is_best_so_far)).toEqual([true, true, false, true])
    expect(series.best_centiseconds).toBe(2900)
  })

  // Strictly faster, so a tie leaves the honour with the earlier swim — the
  // same rule personalBests uses.
  it('does not re-award the marker on an equal time', () => {
    const series = must(
      progressSeries([
        swim({ event_date: '2026-01-01', result_centiseconds: 3000 }),
        swim({ event_date: '2026-02-01', result_centiseconds: 3000 }),
      ])[0],
    )
    expect(series.points.map((p) => p.is_best_so_far)).toEqual([true, false])
  })

  // A relay leg starts from a flying push, so it is not the same event as the
  // same distance swum off the blocks.
  it('leaves relay legs off the chart', () => {
    const series = progressSeries([
      swim({ subcategory: 'personal', result_centiseconds: 3000 }),
      swim({ subcategory: 'relay', result_centiseconds: 2500 }),
    ])
    expect(series).toHaveLength(1)
    expect(must(series[0]).points).toHaveLength(1)
    expect(must(series[0]).best_centiseconds).toBe(3000)
  })

  // The one that nearly shipped wrong. RecordSubcategory is only
  // 'personal' | 'relay' — 핀수영 is a CATEGORY — so filtering on subcategory
  // alone leaves fin swims on the meet line. Fins are worth several seconds over
  // 50m, which would draw a personal best the swimmer never swam.
  it('gives a fin swim its own line rather than the meet one', () => {
    // fin first on the way in, so the assertion below tests the sort rather
    // than agreeing with insertion order.
    const series = progressSeries([
      swim({ category: 'fin', stroke: '자유형', result_centiseconds: 2400 }),
      swim({ category: 'meet', stroke: '자유형', result_centiseconds: 3000 }),
    ])
    expect(series).toHaveLength(2)
    expect(series.map((s) => s.category)).toEqual(['meet', 'fin'])
    expect(series.map((s) => s.best_centiseconds)).toEqual([3000, 2400])
  })

  it('puts a suffixed round on the same line as the plain swim', () => {
    const series = progressSeries([
      swim({ stroke: '배영', event_date: '2026-01-01', result_centiseconds: 3500 }),
      swim({ stroke: '배영(결승)', event_date: '2026-02-01', result_centiseconds: 3400 }),
    ])
    expect(series).toHaveLength(1)
    expect(must(series[0]).stroke).toBe('배영')
    expect(must(series[0]).points).toHaveLength(2)
  })

  it('keeps distances apart within one stroke', () => {
    const series = progressSeries([
      swim({ stroke: '자유형', distance_m: 50 }),
      swim({ stroke: '자유형', distance_m: 100 }),
    ])
    expect(series.map((s) => s.distance_m)).toEqual([50, 100])
  })

  it('orders series the way a meet programme reads', () => {
    const series = progressSeries([
      swim({ stroke: '접영' }),
      swim({ stroke: '자유형' }),
      swim({ stroke: '평영' }),
      swim({ stroke: '배영' }),
    ])
    expect(series.map((s) => s.stroke)).toEqual(['자유형', '배영', '평영', '접영'])
  })

  // created_at defaults to now(), which is the transaction start, so an upload
  // writing a whole meet stamps every row identically. Without the id tiebreak
  // these two swap between refetches — and that swaps which point owns the
  // marker.
  it('breaks a same-date same-timestamp tie by id, stably', () => {
    const a = swim({
      id: 'aaa',
      event_date: '2026-01-01',
      created_at: '2026-01-01T00:00:00Z',
      result_centiseconds: 3000,
    })
    const b = swim({
      id: 'bbb',
      event_date: '2026-01-01',
      created_at: '2026-01-01T00:00:00Z',
      result_centiseconds: 2900,
    })
    const forward = must(progressSeries([a, b])[0]).points.map((p) => p.id)
    const reversed = must(progressSeries([b, a])[0]).points.map((p) => p.id)
    expect(forward).toEqual(['aaa', 'bbb'])
    expect(reversed).toEqual(forward)
  })

  it('returns a series for a member with a single swim', () => {
    const series = progressSeries([swim({ result_centiseconds: 3000 })])
    expect(series).toHaveLength(1)
    expect(must(series[0]).points).toHaveLength(1)
    expect(must(must(series[0]).points[0]).is_best_so_far).toBe(true)
  })

  it('returns nothing for a member with no chartable records', () => {
    expect(progressSeries([])).toEqual([])
    expect(progressSeries([swim({ stroke: '개인혼영' })])).toEqual([])
    expect(progressSeries([swim({ subcategory: 'relay' })])).toEqual([])
  })
})
