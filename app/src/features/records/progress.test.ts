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
  it('strips the 핀 marker so a finned swim keeps its stroke', () => {
    expect(normaliseStroke('핀 자유형')).toBe('자유형')
    expect(normaliseStroke('핀자유형')).toBe('자유형')
  })

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


  // The mutation that survived the first fourteen tests: emit the running best
  // instead of the swim's own time. Flags and best_centiseconds both stay
  // correct, and the drawn line quietly becomes a staircase that only ever
  // descends — every slower swim erased from the one screen that exists to show
  // them. Assert the plotted values themselves, because nothing else does.
  it('plots each swim at its own time, regressions included', () => {
    const series = must(
      progressSeries([
        swim({ event_date: '2026-01-01', result_centiseconds: 3100 }),
        swim({ event_date: '2026-02-01', result_centiseconds: 3000 }),
        swim({ event_date: '2026-03-01', result_centiseconds: 3050 }),
      ])[0],
    )
    expect(series.points.map((p) => p.result_centiseconds)).toEqual([3100, 3000, 3050])
  })

  // 핀 자유형 returned [] before this: it matched none of the four strokes and
  // left the chart without a trace. 0041 never meets this case because it
  // filters to category='meet' first.
  it('charts a 핀 자유형 row instead of dropping it', () => {
    const series = progressSeries([
      swim({ category: 'fin', stroke: '핀 자유형', result_centiseconds: 2400 }),
    ])
    expect(series).toHaveLength(1)
    expect(must(series[0]).stroke).toBe('자유형')
    expect(must(series[0]).category).toBe('fin')
  })

  // And it must not reach the pool line even if the category column disagrees.
  it('keeps a mislabelled 핀 row off the meet line', () => {
    const series = progressSeries([
      swim({ category: 'meet', stroke: '자유형', result_centiseconds: 3000 }),
      swim({ category: 'meet', stroke: '핀 자유형', result_centiseconds: 2400 }),
    ])
    expect(series).toHaveLength(2)
    expect(series.map((s) => s.category)).toEqual(['meet', 'fin'])
  })

  // Every swim of one meet is written in a single transaction, so created_at
  // ties and a random uuid decided the order. Two of the four same-day pairs in
  // the dev database were drawn final-first, which reads as a regression that
  // ran backwards.
  it('draws a heat before the final it qualified for', () => {
    const heat = swim({
      id: 'zzz',
      stroke: '배영(예선)',
      event_date: '2026-06-20',
      created_at: '2026-06-20T00:00:00Z',
      result_centiseconds: 3500,
    })
    const final = swim({
      id: 'aaa',
      stroke: '배영(결승)',
      event_date: '2026-06-20',
      created_at: '2026-06-20T00:00:00Z',
      result_centiseconds: 3400,
    })
    const series = must(progressSeries([final, heat])[0])
    expect(series.points.map((p) => p.result_centiseconds)).toEqual([3500, 3400])
    expect(series.points.map((p) => p.is_best_so_far)).toEqual([true, true])
  })

  // An unlabelled swim is after an explicit heat and before an explicit final.
  it('places an unlabelled swim between a heat and a final', () => {
    const series = must(
      progressSeries([
        swim({ id: 'a', stroke: '배영(결승)', result_centiseconds: 3300 }),
        swim({ id: 'b', stroke: '배영', result_centiseconds: 3400 }),
        swim({ id: 'c', stroke: '배영(예선)', result_centiseconds: 3500 }),
      ])[0],
    )
    expect(series.points.map((p) => p.result_centiseconds)).toEqual([3500, 3400, 3300])
  })


  // 준결승 contains 결승, so a matcher that tests 결승 first ranks a semifinal
  // after the final it preceded. The comment in progress.ts says to check the
  // longer label first; this is the test that makes that comment binding.
  it('puts a semifinal between the heat and the final', () => {
    const series = must(
      progressSeries([
        swim({ id: 'a', stroke: '접영(결승)', result_centiseconds: 3300 }),
        swim({ id: 'b', stroke: '접영(준결승)', result_centiseconds: 3400 }),
        swim({ id: 'c', stroke: '접영(예선)', result_centiseconds: 3500 }),
      ])[0],
    )
    expect(series.points.map((p) => p.result_centiseconds)).toEqual([3500, 3400, 3300])
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
