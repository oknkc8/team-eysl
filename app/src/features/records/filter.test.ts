import { describe, it, expect } from 'vitest'
import {
  ALL_DISTANCES,
  ALL_RELAYS,
  applyFilter,
  distanceOptions,
  emptyReason,
  isExtraDistance,
  matchesFilter,
  OTHER_STROKE,
  personalBestGrid,
  resolveFilter,
  strokeBucket,
  strokeOptions,
  subLabel,
  type Filterable,
} from './filter'

type Row = Filterable & { result_centiseconds: number }

function row(over: Partial<Row> = {}): Row {
  return {
    category: 'meet',
    subcategory: 'personal',
    stroke: '자유형',
    distance_m: 50,
    result_centiseconds: 3308,
    ...over,
  }
}

describe('strokeBucket', () => {
  it('files a stroke the sheet spelled with a prefix under its stroke', () => {
    expect(strokeBucket({ stroke: '핀 자유형' }, 'fin', 'personal')).toBe('자유형')
    expect(strokeBucket({ stroke: '자유형' }, 'meet', 'personal')).toBe('자유형')
  })

  it('recognises 개인혼영, and a bare 혼영, as the medley', () => {
    expect(strokeBucket({ stroke: '개인혼영' }, 'meet', 'personal')).toBe('개인혼영')
    expect(strokeBucket({ stroke: '혼영' }, 'meet', 'personal')).toBe('개인혼영')
  })

  // 혼성혼계영 contains 혼계영 contains 계영, so a short-first test would file
  // every medley relay as a freestyle relay.
  it('separates the four relays despite each containing the next', () => {
    expect(strokeBucket({ stroke: '혼성혼계영' }, 'meet', 'relay')).toBe('혼성혼계영')
    expect(strokeBucket({ stroke: '혼성계영' }, 'meet', 'relay')).toBe('혼성계영')
    expect(strokeBucket({ stroke: '혼계영' }, 'meet', 'relay')).toBe('혼계영')
    expect(strokeBucket({ stroke: '계영' }, 'meet', 'relay')).toBe('계영')
  })

  it('puts every 기타 team record in one bucket, since 기타 has no programme', () => {
    expect(strokeBucket({ stroke: '단체 줄넘기' }, 'other', 'relay')).toBe(ALL_RELAYS)
  })

  it('sends a stroke nobody anticipated to 기타 rather than to a wrong stroke', () => {
    expect(strokeBucket({ stroke: '입영' }, 'meet', 'personal')).toBe(OTHER_STROKE)
    // 배영 is not one of the fin strokes his screen offers.
    expect(strokeBucket({ stroke: '배영' }, 'fin', 'personal')).toBe(OTHER_STROKE)
  })
})

describe('strokeOptions', () => {
  it('offers his five strokes for a meet, with no 기타 tab when nothing needs one', () => {
    expect(strokeOptions([row()], 'meet', 'personal')).toEqual([
      '자유형',
      '배영',
      '평영',
      '접영',
      '개인혼영',
    ])
  })

  // The reachability rule: his 일반/개인전 list has no 기타 at all, so a row
  // that buckets there has no tab on his screen and cannot be reached.
  it('appends 기타 when the member has a stroke outside the canonical list', () => {
    expect(strokeOptions([row({ stroke: '입영' })], 'meet', 'personal')).toContain(OTHER_STROKE)
  })

  it('does not append 기타 for a row belonging to a different 대분류', () => {
    expect(
      strokeOptions([row({ category: 'fin', stroke: '입영' })], 'meet', 'personal'),
    ).not.toContain(OTHER_STROKE)
  })
})

describe('distanceOptions', () => {
  it('offers 전체 plus his canonical pair for a meet sprint', () => {
    expect(distanceOptions([row()], 'meet', 'personal', '자유형')).toEqual([ALL_DISTANCES, 50, 100])
  })

  it('starts a medley at 100, the way his does', () => {
    expect(distanceOptions([], 'meet', 'personal', '개인혼영')).toEqual([ALL_DISTANCES, 100, 200])
  })

  // The headline case from the brief: 1500 is in the schema and in none of his
  // four buttons, so on his screen the row is unreachable.
  it('adds a distance the member actually swam that his tabs never offer', () => {
    expect(distanceOptions([row({ distance_m: 1500 })], 'meet', 'personal', '자유형')).toEqual([
      ALL_DISTANCES,
      50,
      100,
      1500,
    ])
    expect(isExtraDistance(1500, 'meet', 'personal', '자유형')).toBe(true)
    expect(isExtraDistance(50, 'meet', 'personal', '자유형')).toBe(false)
  })

  it('shows no distance row for a meet relay, which his does not filter by distance', () => {
    expect(distanceOptions([], 'meet', 'relay', '계영')).toEqual([])
  })

  it('gives a meet relay a distance row once the data has one', () => {
    const relay = row({ subcategory: 'relay', stroke: '계영', distance_m: 200 })
    expect(distanceOptions([relay], 'meet', 'relay', '계영')).toEqual([ALL_DISTANCES, 200])
  })
})

describe('matchesFilter', () => {
  const filter = { major: 'meet', sub: 'personal', stroke: '자유형', distance: 50 } as const

  it('accepts the row it was built for', () => {
    expect(matchesFilter(row(), filter)).toBe(true)
  })

  it('rejects another 대분류, another 종류, another stroke and another distance', () => {
    expect(matchesFilter(row({ category: 'fin' }), filter)).toBe(false)
    expect(matchesFilter(row({ subcategory: 'relay' }), filter)).toBe(false)
    expect(matchesFilter(row({ stroke: '평영' }), filter)).toBe(false)
    expect(matchesFilter(row({ distance_m: 100 }), filter)).toBe(false)
  })

  it('lets 전체 through every distance, including one outside his set', () => {
    const all = { ...filter, distance: ALL_DISTANCES }
    expect(matchesFilter(row({ distance_m: 1500 }), all)).toBe(true)
    expect(applyFilter([row({ distance_m: 50 }), row({ distance_m: 1500 })], all)).toHaveLength(2)
  })
})

describe('resolveFilter', () => {
  it('lands on his defaults when the member has rows there', () => {
    expect(resolveFilter([row()])).toEqual({
      major: 'meet',
      sub: 'personal',
      stroke: '자유형',
      distance: 50,
    })
  })

  // His screen opens on 자유형 50M regardless, so a swimmer who has only ever
  // raced 평영 meets a blank panel and has to guess which tab to press.
  it('skips past a default stroke the member has never swum', () => {
    expect(resolveFilter([row({ stroke: '평영' })]).stroke).toBe('평영')
  })

  // Not 전체 but the 1500M tab itself: the appended option is a real choice, so
  // the screen opens naming the distance rather than hiding the row behind a
  // 50M default that can never match it.
  it('opens on a distance his tabs omit when that is all the member has swum', () => {
    expect(resolveFilter([row({ distance_m: 1500 })]).distance).toBe(1500)
  })

  it('falls back to 전체 only when no distance in the selection holds anything', () => {
    // 배영 has no rows, so neither 50 nor 100 can be defaulted to honestly.
    expect(resolveFilter([row()], { stroke: '배영' }).distance).toBe(ALL_DISTANCES)
  })

  it('keeps an explicit choice even when it is empty, because pressing it is an answer', () => {
    const resolved = resolveFilter([row({ distance_m: 100 })], {
      major: 'meet',
      sub: 'personal',
      stroke: '자유형',
      distance: 50,
    })
    expect(resolved.distance).toBe(50)
  })

  it('drops a stale stroke that the newly chosen 대분류 does not offer', () => {
    // 배영 exists for a meet and not for fins; a stale value must not survive
    // into a selection that can never match anything.
    const resolved = resolveFilter([row({ category: 'fin', stroke: '접영' })], {
      major: 'fin',
      sub: 'personal',
      stroke: '배영',
    })
    expect(resolved.stroke).toBe('접영')
  })

  it('resolves against an empty roster of records without throwing', () => {
    expect(resolveFilter([])).toEqual({
      major: 'meet',
      sub: 'personal',
      stroke: '자유형',
      distance: ALL_DISTANCES,
    })
  })
})

describe('emptyReason', () => {
  it('says the member has nothing at all, and offers no way back', () => {
    const reason = emptyReason([], resolveFilter([]))
    expect(reason.message).toBe('아직 등록된 기록이 없습니다')
    expect(reason.fallback).toBeNull()
  })

  // The behaviour the brief asks for: never let a filter claim there are no
  // records when it means "not at this distance".
  it('blames the distance and counts what widening it would show', () => {
    const rows = [row({ distance_m: 100 }), row({ distance_m: 100 })]
    const reason = emptyReason(rows, {
      major: 'meet',
      sub: 'personal',
      stroke: '자유형',
      distance: 50,
    })

    expect(reason.message).toContain('50M')
    expect(reason.message).toContain('2건')
    expect(reason.fallback).toEqual({
      major: 'meet',
      sub: 'personal',
      stroke: '자유형',
      distance: ALL_DISTANCES,
    })
    expect(reason.fallbackLabel).toBe('거리 전체 보기')
  })

  it('blames the stroke and points at one the member has swum', () => {
    const reason = emptyReason([row({ stroke: '평영' })], {
      major: 'meet',
      sub: 'personal',
      stroke: '자유형',
      distance: ALL_DISTANCES,
    })

    expect(reason.message).toContain('자유형')
    expect(reason.fallback).toEqual({ major: 'meet', sub: 'personal', stroke: '평영' })
    expect(reason.fallbackLabel).toBe('평영 보기')
  })

  it('blames 개인전/단체전 and offers the other one', () => {
    const relay = row({ subcategory: 'relay', stroke: '계영' })
    const reason = emptyReason([relay], resolveFilter([relay], { sub: 'personal' }))

    expect(reason.fallback).toEqual({ major: 'meet', sub: 'relay' })
    expect(reason.fallbackLabel).toBe('단체전 보기')
  })

  it('blames the 대분류 and offers one that holds something', () => {
    const fin = row({ category: 'fin' })
    const reason = emptyReason([fin], resolveFilter([fin], { major: 'meet' }))

    expect(reason.message).toBe('일반 기록이 없습니다.')
    expect(reason.fallback).toEqual({ major: 'fin' })
    expect(reason.fallbackLabel).toBe('핀 보기')
  })

  // Every fallback is only worth offering if pressing it actually shows
  // something, so this walks each one back through the filter it produces.
  it('produces a fallback that is genuinely non-empty', () => {
    const rows = [row({ category: 'fin', stroke: '접영', distance_m: 200 })]
    let filter = resolveFilter(rows, { major: 'meet', sub: 'personal' })
    expect(applyFilter(rows, filter)).toHaveLength(0)

    for (let step = 0; step < 4; step += 1) {
      const reason = emptyReason(rows, filter)
      if (reason.fallback === null) break
      filter = resolveFilter(rows, reason.fallback)
      if (applyFilter(rows, filter).length > 0) break
    }

    expect(applyFilter(rows, filter)).toHaveLength(1)
  })
})

describe('subLabel', () => {
  it('calls a 기타 row a 기록, not a 전 — it is not a race', () => {
    expect(subLabel('other', 'personal')).toBe('개인기록')
    expect(subLabel('other', 'relay')).toBe('단체기록')
    expect(subLabel('meet', 'personal')).toBe('개인전')
    expect(subLabel('fin', 'relay')).toBe('단체전')
  })
})

describe('personalBestGrid', () => {
  it('always returns the four strokes, with a gap where there is no swim', () => {
    const grid = personalBestGrid([row({ stroke: '자유형', result_centiseconds: 3308 })])

    expect(grid.map((cell) => cell.stroke)).toEqual(['자유형', '배영', '평영', '접영'])
    expect(grid[0]?.record?.result_centiseconds).toBe(3308)
    expect(grid[1]?.record).toBeNull()
  })

  it('keeps the fastest 50M swim, and the earliest of two identical ones', () => {
    const first = row({ result_centiseconds: 3251 })
    const grid = personalBestGrid([
      row({ result_centiseconds: 3308 }),
      first,
      row({ result_centiseconds: 3251 }),
    ])

    expect(grid[0]?.record).toBe(first)
  })

  // A relay leg is swum off a flying start and a fin swim is a different sport;
  // neither may become somebody's 일반 개인전 best.
  it('ignores relays, fin swims and every distance but 50', () => {
    const grid = personalBestGrid([
      row({ subcategory: 'relay', stroke: '계영', result_centiseconds: 3000 }),
      row({ category: 'fin', result_centiseconds: 2800 }),
      row({ distance_m: 100, result_centiseconds: 3100 }),
    ])

    expect(grid.every((cell) => cell.record === null)).toBe(true)
  })
})
