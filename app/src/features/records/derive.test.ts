import { describe, it, expect } from 'vitest'
import { personalBests, raceEvents, relayRecords, withDeltas } from './derive'

type Row = {
  id: string
  category: string
  subcategory: string
  stroke: string
  distance_m: number
  event_date: string
  created_at: string
  result_centiseconds: number
}

let sequence = 0

// created_at tracks event_date unless a test says otherwise, which is what a
// row written the day it was swum looks like.
function row(over: Partial<Row> & { event_date: string; result_centiseconds: number }): Row {
  sequence += 1
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    category: 'meet',
    subcategory: 'personal',
    stroke: '자유형',
    distance_m: 50,
    created_at: `${over.event_date}T02:00:00.000Z`,
    ...over,
  }
}

describe('personalBests', () => {
  it('keeps the fastest swim for each stroke and distance', () => {
    const best = personalBests([
      row({ event_date: '2026-03-14', result_centiseconds: 3308 }),
      row({ event_date: '2026-05-02', result_centiseconds: 3251 }),
      row({ event_date: '2026-06-20', result_centiseconds: 3400 }),
    ])

    expect(best).toHaveLength(1)
    expect(best[0]?.result_centiseconds).toBe(3251)
  })

  it('separates the same stroke at different distances', () => {
    const best = personalBests([
      row({ event_date: '2026-03-14', distance_m: 50, result_centiseconds: 3308 }),
      row({ event_date: '2026-03-14', distance_m: 100, result_centiseconds: 7210 }),
    ])

    expect(best.map((r) => r.distance_m)).toEqual([50, 100])
  })

  // A relay leg is swum off a flying start, so it must never become the best
  // for an event a swimmer also races individually.
  it('ignores relay legs entirely', () => {
    const best = personalBests([
      row({ event_date: '2026-03-14', result_centiseconds: 3308 }),
      row({ event_date: '2026-05-02', subcategory: 'relay', result_centiseconds: 3100 }),
    ])

    expect(best).toHaveLength(1)
    expect(best[0]?.result_centiseconds).toBe(3308)
  })

  // Fins are worth several seconds over 50m, so a finned swim standing as the
  // best for the unfinned event would be a time the swimmer cannot reproduce.
  it('does not let a 핀 swim become the best for the same event at a meet', () => {
    const best = personalBests([
      row({ event_date: '2026-03-14', result_centiseconds: 3308 }),
      row({ event_date: '2026-05-02', category: 'fin', result_centiseconds: 2800 }),
    ])

    expect(best).toHaveLength(2)
    expect(best.map((r) => [r.category, r.result_centiseconds])).toEqual([
      ['meet', 3308],
      ['fin', 2800],
    ])
  })

  it('orders events the way a meet programme lists them, then by distance', () => {
    const best = personalBests([
      row({ event_date: '2026-03-14', stroke: '접영', distance_m: 50, result_centiseconds: 3800 }),
      row({
        event_date: '2026-03-14',
        stroke: '자유형',
        distance_m: 100,
        result_centiseconds: 7210,
      }),
      row({ event_date: '2026-03-14', stroke: '자유형', distance_m: 50, result_centiseconds: 3308 }),
      row({ event_date: '2026-03-14', stroke: '배영', distance_m: 50, result_centiseconds: 4100 }),
    ])

    expect(best.map((r) => `${r.stroke} ${r.distance_m}`)).toEqual([
      '자유형 50',
      '자유형 100',
      '배영 50',
      '접영 50',
    ])
  })

  // stroke is free text out of parsed sheets, so an unlisted label has to land
  // somewhere predictable rather than being dropped.
  it('sorts an unrecognised stroke after the listed ones', () => {
    const best = personalBests([
      row({ event_date: '2026-03-14', stroke: '핀 자유형', result_centiseconds: 2800 }),
      row({ event_date: '2026-03-14', stroke: '자유형', result_centiseconds: 3308 }),
    ])

    expect(best.map((r) => r.stroke)).toEqual(['자유형', '핀 자유형'])
  })

  it('returns nothing for a member with no personal swims', () => {
    expect(personalBests([])).toEqual([])
    expect(
      personalBests([
        row({ event_date: '2026-03-14', subcategory: 'relay', result_centiseconds: 3100 }),
      ]),
    ).toEqual([])
  })
})

describe('withDeltas', () => {
  it('reports the gap to the previous swim of the same event, newest first', () => {
    const history = withDeltas([
      row({ event_date: '2026-03-14', result_centiseconds: 3308 }),
      row({ event_date: '2026-05-02', result_centiseconds: 3251 }),
      row({ event_date: '2026-06-20', result_centiseconds: 3400 }),
    ])

    expect(history.map((r) => [r.event_date, r.delta_centiseconds])).toEqual([
      ['2026-06-20', 149], // slower than 32.51
      ['2026-05-02', -57], // faster than 33.08
      ['2026-03-14', null], // nothing before it
    ])
  })

  it('leaves the first swim of an event without a delta rather than calling it zero', () => {
    const [only] = withDeltas([row({ event_date: '2026-03-14', result_centiseconds: 3308 })])

    expect(only?.delta_centiseconds).toBeNull()
    expect(only?.is_personal_best).toBe(true)
  })

  it('compares only within the same stroke and distance', () => {
    const history = withDeltas([
      row({ event_date: '2026-03-14', stroke: '자유형', result_centiseconds: 3308 }),
      row({ event_date: '2026-05-02', stroke: '배영', result_centiseconds: 4100 }),
    ])

    // Neither has a predecessor in its own event, despite following one another
    // in time.
    expect(history.every((r) => r.delta_centiseconds === null)).toBe(true)
  })

  // The reason subcategory is in the grouping key: a 32.00 relay leg following
  // a 33.08 individual swim is not a 1.08 improvement.
  it('does not compare a relay leg against an individual swim', () => {
    const history = withDeltas([
      row({ event_date: '2026-03-14', result_centiseconds: 3308 }),
      row({ event_date: '2026-05-02', subcategory: 'relay', result_centiseconds: 3200 }),
    ])

    expect(history.map((r) => r.delta_centiseconds)).toEqual([null, null])
  })

  // The mirror of the personalBests case above, and the one the 대분류 filter
  // made visible: a 27.00 finned swim after a 33.08 unfinned one is not a six
  // second improvement, and the 일반 tab must never claim it was.
  it('does not compare a 핀 swim against the same event at a meet', () => {
    const history = withDeltas([
      row({ event_date: '2026-03-14', result_centiseconds: 3308 }),
      row({ event_date: '2026-05-02', category: 'fin', result_centiseconds: 2700 }),
    ])

    expect(history.map((r) => r.delta_centiseconds)).toEqual([null, null])
  })

  it('flags a swim that beat everything before it', () => {
    const history = withDeltas([
      row({ event_date: '2026-03-14', result_centiseconds: 3308 }),
      row({ event_date: '2026-05-02', result_centiseconds: 3251 }),
      row({ event_date: '2026-06-20', result_centiseconds: 3400 }),
      row({ event_date: '2026-07-11', result_centiseconds: 3260 }),
    ])

    // Newest first: 32.60 is faster than the swim before it but not a best,
    // because 32.51 still stands.
    expect(history.map((r) => [r.event_date, r.is_personal_best])).toEqual([
      ['2026-07-11', false],
      ['2026-06-20', false],
      ['2026-05-02', true],
      ['2026-03-14', true],
    ])
  })

  it('reports an unchanged time as a zero delta, not as a missing one', () => {
    const history = withDeltas([
      row({ event_date: '2026-03-14', result_centiseconds: 3308 }),
      row({ event_date: '2026-05-02', result_centiseconds: 3308 }),
    ])

    expect(history[0]?.delta_centiseconds).toBe(0)
    // Equal is not faster, so the earlier swim keeps the best.
    expect(history[0]?.is_personal_best).toBe(false)
  })

  // A bulk upload writes every row inside one transaction, so now() — and thus
  // created_at — is identical across them. Without the id tiebreak the pair
  // could swap on each refetch and hand the delta to the wrong row.
  it('orders two swims stamped at the same instant deterministically', () => {
    const shared = '2026-05-02T02:00:00.000Z'
    const first = {
      ...row({ event_date: '2026-05-02', result_centiseconds: 3308 }),
      id: 'a',
      created_at: shared,
    }
    const second = {
      ...row({ event_date: '2026-05-02', result_centiseconds: 3251 }),
      id: 'b',
      created_at: shared,
    }

    const forwards = withDeltas([first, second])
    const backwards = withDeltas([second, first])

    expect(forwards.map((r) => r.id)).toEqual(['b', 'a'])
    expect(backwards.map((r) => r.id)).toEqual(['b', 'a'])
    expect(forwards[0]?.delta_centiseconds).toBe(-57)
    expect(backwards[0]?.delta_centiseconds).toBe(-57)
  })

  it('does not mutate the array it was given', () => {
    const rows = [
      row({ event_date: '2026-06-20', result_centiseconds: 3400 }),
      row({ event_date: '2026-03-14', result_centiseconds: 3308 }),
    ]
    const order = rows.map((r) => r.id)

    withDeltas(rows)

    expect(rows.map((r) => r.id)).toEqual(order)
  })
})

describe('raceEvents', () => {
  const meet = (over: { event_name: string; event_date: string; category?: string }) => ({
    category: 'meet',
    ...over,
  })

  it('collapses several swims at one meet into a single entry', () => {
    const events = raceEvents([
      meet({ event_name: '동아수영대회', event_date: '2026-05-02' }),
      meet({ event_name: '동아수영대회', event_date: '2026-05-02' }),
      meet({ event_name: '동아수영대회', event_date: '2026-05-02' }),
    ])

    expect(events).toHaveLength(1)
    expect(events[0]?.swimCount).toBe(3)
  })

  it('treats the same meet name on another date as another meet, newest first', () => {
    const events = raceEvents([
      meet({ event_name: '동아수영대회', event_date: '2025-05-02' }),
      meet({ event_name: '동아수영대회', event_date: '2026-05-02' }),
    ])

    expect(events.map((event) => event.date)).toEqual(['2026-05-02', '2025-05-02'])
  })

  it('counts a fin meet, since it is still a competition', () => {
    const events = raceEvents([
      meet({ event_name: '핀수영대회', event_date: '2026-05-02', category: 'fin' }),
    ])

    expect(events).toHaveLength(1)
  })

  // 기타 is not a competition, and a swim with no meet name attests to a swim
  // rather than to an identifiable meet — grouping it would print a blank row.
  it('skips 기타 rows and rows with no meet name', () => {
    const events = raceEvents([
      meet({ event_name: '단합대회', event_date: '2026-05-02', category: 'other' }),
      meet({ event_name: '   ', event_date: '2026-06-20' }),
      meet({ event_name: '', event_date: '2026-06-21' }),
    ])

    expect(events).toEqual([])
  })
})

describe('relayRecords', () => {
  it('keeps only team events, newest first', () => {
    const relays = relayRecords([
      row({ event_date: '2026-03-14', result_centiseconds: 3308 }),
      row({
        event_date: '2026-05-02',
        subcategory: 'relay',
        stroke: '계영',
        result_centiseconds: 3200,
      }),
      row({
        event_date: '2026-06-20',
        subcategory: 'relay',
        stroke: '혼계영',
        result_centiseconds: 3150,
      }),
    ])

    expect(relays.map((r) => r.stroke)).toEqual(['혼계영', '계영'])
  })

  it('returns nothing when the member has never swum a relay', () => {
    expect(relayRecords([row({ event_date: '2026-03-14', result_centiseconds: 3308 })])).toEqual([])
  })
})
