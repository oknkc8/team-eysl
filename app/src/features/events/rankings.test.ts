import { describe, it, expect } from 'vitest'
import {
  RankingsContractError,
  TOP_RANK_LIMIT,
  countListsFor,
  formatSeconds,
  groupByStroke,
  hasHiddenRanks,
  isRankingKind,
  isRankingsEmpty,
  isStrokeRankingsEmpty,
  parseStrokeRankings,
  strokeRowsFor,
  parseRankings,
  rankDisplay,
  rankToggleLabel,
  type ImprovementRow,
} from './rankings'

// The payloads below mirror what team_event_rankings_v1() actually returned
// against the dev database, not what the contract says it should return.

const FULL = {
  year: 2026,
  attendance: {
    lifetime: [
      { rank: 1, nickname: '가람', count: 9 },
      { rank: 2, nickname: '나루', count: 4 },
    ],
    h1: [
      { rank: 1, nickname: '가람', count: 2 },
      { rank: 1, nickname: '나루', count: 2 },
      { rank: 3, nickname: '사랑', count: 1 },
    ],
    h2: [{ rank: 1, nickname: '다솜', count: 2 }],
  },
  late: {
    lifetime: [{ rank: 1, nickname: '가람', count: 3 }],
    h1: [],
    h2: [],
  },
  improvements: {
    within_year: [
      { rank: 1, nickname: '가람', stroke: '배영', distance: 50, seconds: 1.0 },
      { rank: 1, nickname: '나루', stroke: '자유형', distance: 100, seconds: 5.0 },
      { rank: 2, nickname: '가람', stroke: '자유형', distance: 50, seconds: 1.5 },
    ],
    yoy_pb: [{ rank: 1, nickname: '가람', stroke: '평영', distance: 100, seconds: 3.0 }],
  },
}

const EMPTY = {
  year: 2026,
  attendance: { lifetime: [], h1: [], h2: [] },
  late: { lifetime: [], h1: [], h2: [] },
  improvements: { within_year: [], yoy_pb: [] },
}

describe('parseRankings', () => {
  it('reads a full payload', () => {
    const data = parseRankings(FULL)
    expect(data.year).toBe(2026)
    expect(data.attendance.lifetime).toHaveLength(2)
    expect(data.late.lifetime[0]).toEqual({ rank: 1, nickname: '가람', count: 3 })
    expect(data.improvements.yoy_pb).toHaveLength(1)
    expect(data.improvements.yoy_pb[0]!.seconds).toBe(3)
  })

  // The server answers a caller who is not an approved member with a payload
  // rather than an error, so a successful response can still be a refusal.
  it('treats an error payload as a failure', () => {
    expect(() => parseRankings({ error: 'unauthorized' })).toThrow(RankingsContractError)
  })

  it('refuses a payload with no year, because every heading interpolates it', () => {
    expect(() => parseRankings({ attendance: {}, late: {}, improvements: {} })).toThrow(
      RankingsContractError,
    )
    expect(() => parseRankings({ year: '2026' })).toThrow(RankingsContractError)
  })

  it('refuses a non-object', () => {
    expect(() => parseRankings(null)).toThrow(RankingsContractError)
    expect(() => parseRankings([])).toThrow(RankingsContractError)
  })

  // Empty is a real state — a club whose first season has not started — so a
  // missing list must read as "nothing yet", never as a broken response.
  it('reads a missing list as empty rather than failing', () => {
    const data = parseRankings({ year: 2026 })
    expect(data.attendance.lifetime).toEqual([])
    expect(data.attendance.h1).toEqual([])
    expect(data.late.h2).toEqual([])
    expect(data.improvements.within_year).toEqual([])
    expect(data.improvements.yoy_pb).toEqual([])
  })

  it('drops rows that are not objects instead of rendering holes', () => {
    const data = parseRankings({ year: 2026, attendance: { lifetime: [null, 7, { rank: 1 }] } })
    expect(data.attendance.lifetime).toEqual([{ rank: 1, nickname: '', count: 0 }])
  })

  // The server sends 1.50 as a JSON number inside the jsonb payload, so a
  // fractional time has to survive narrowing intact — truncating it to 1 would
  // silently rewrite every 단축왕 row.
  it('keeps a fractional seconds value', () => {
    const data = parseRankings({
      year: 2026,
      improvements: {
        within_year: [{ rank: 1, nickname: '가람', stroke: '자유형', distance: 50, seconds: 1.5 }],
      },
    })
    expect(data.improvements.within_year).toHaveLength(1)
    expect(data.improvements.within_year[0]!.seconds).toBe(1.5)
  })
})

describe('isRankingsEmpty', () => {
  it('is true only when every list for that kind is empty', () => {
    const empty = parseRankings(EMPTY)
    expect(isRankingsEmpty(empty, 'attendance')).toBe(true)
    expect(isRankingsEmpty(empty, 'late')).toBe(true)
    expect(isRankingsEmpty(empty, 'improve')).toBe(true)
  })

  it('is false when any single period has rows', () => {
    const data = parseRankings(FULL)
    expect(isRankingsEmpty(data, 'attendance')).toBe(false)
    expect(isRankingsEmpty(data, 'improve')).toBe(false)
  })

  // 지각왕 has rows in lifetime only. Keying the empty state off one period
  // would show "아직 집계할 기록이 없습니다" over a list that has content.
  it('is false when only the lifetime list has rows', () => {
    expect(isRankingsEmpty(parseRankings(FULL), 'late')).toBe(false)
  })
})

describe('countListsFor', () => {
  it('picks the lists belonging to the kind', () => {
    const data = parseRankings(FULL)
    const attendanceLifetime = countListsFor(data, 'attendance').lifetime
    expect(attendanceLifetime).toHaveLength(2)
    expect(attendanceLifetime[0]!.count).toBe(9)
    const lateLifetime = countListsFor(data, 'late').lifetime
    expect(lateLifetime).toHaveLength(1)
    expect(lateLifetime[0]!.count).toBe(3)
  })
})

describe('groupByStroke', () => {
  const rows = parseRankings(FULL).improvements.within_year

  it('returns all four strokes in programme order, even the empty ones', () => {
    expect(groupByStroke(rows).map((group) => group.stroke)).toEqual([
      '자유형',
      '배영',
      '평영',
      '접영',
    ])
  })

  it('files each row under its own stroke', () => {
    const groups = groupByStroke(rows)
    // groupByStroke always returns one entry per STROKES (4), never fewer —
    // asserted by the previous test — so indexing here can't be out of range.
    expect(groups[0]!.rows.map((row) => row.nickname)).toEqual(['나루', '가람'])
    expect(groups[1]!.rows.map((row) => row.nickname)).toEqual(['가람'])
  })

  // Empty groups are kept rather than filtered: the screen prints all four
  // headings, and a missing 접영 heading reads as a bug where an empty one
  // reads as "nobody has raced it yet".
  it('keeps a stroke nobody has raced', () => {
    expect(groupByStroke(rows)[3]).toEqual({ stroke: '접영', rows: [] })
  })

  // The server filters to the four strokes, so this only guards against one
  // slipping through — '핀 자유형' must not be folded into 자유형.
  it('does not fold a stroke that merely contains another name', () => {
    const finRow: ImprovementRow = {
      rank: 1,
      nickname: '가람',
      stroke: '핀 자유형',
      distance: 50,
      seconds: 10,
    }
    // Same fixed-length guarantee as above: groupByStroke([finRow]) still
    // returns all four STROKES entries, so index 0 is never undefined.
    expect(groupByStroke([finRow])[0]!.rows).toEqual([])
  })
})

describe('formatSeconds', () => {
  it('always shows two decimals, matching the legacy toFixed(2)', () => {
    expect(formatSeconds(1.5)).toBe('1.50')
    expect(formatSeconds(3)).toBe('3.00')
    expect(formatSeconds(12.345)).toBe('12.35')
  })
})

describe('isRankingKind', () => {
  it('accepts the three the hub links to', () => {
    expect(isRankingKind('attendance')).toBe(true)
    expect(isRankingKind('late')).toBe(true)
    expect(isRankingKind('improve')).toBe(true)
  })

  it('rejects anything else, so a typed URL gets its own answer', () => {
    expect(isRankingKind('improvements')).toBe(false)
    expect(isRankingKind(undefined)).toBe(false)
  })
})

describe('메달·등급', () => {
  it('puts 금·은·동 on the podium and a number everywhere else', () => {
    expect(rankDisplay(1)).toBe('🥇')
    expect(rankDisplay(2)).toBe('🥈')
    expect(rankDisplay(3)).toBe('🥉')
    expect(rankDisplay(4)).toBe('4')
    expect(rankDisplay(11)).toBe('11')
  })

  /*
   * The case a fixture of all-distinct counts cannot see.
   *
   * team_event_rankings_v1 ranks with rank(), so tied members share a rank and
   * the next distinct count skips the numbers they used up. A list whose top two
   * are tied is therefore ranked 1, 1, 3 — and the screen shows two 🥇 followed
   * by a 🥉 with NO 🥈 anywhere on it.
   *
   * That is correct: a real podium with two golds has no silver. But it looks
   * exactly like a bug, and a lookup written as `MEDALS[index]` rather than
   * `MEDALS[rank]` would render 🥇🥈🥉 here — wrong, while looking right. Every
   * rank below is one the server can actually emit.
   */
  it('shares a medal on a tie and skips the rank the tie consumed', () => {
    const tied = [1, 1, 3, 4, 5, 5, 7]
    expect(tied.map(rankDisplay)).toEqual(['🥇', '🥇', '🥉', '4', '5', '5', '7'])
    expect(tied.map(rankDisplay)).not.toContain('🥈')
  })

  it('gives silver only when exactly one member is first', () => {
    expect([1, 2, 3].map(rankDisplay)).toEqual(['🥇', '🥈', '🥉'])
  })

  // Three-way tie for first: the next distinct count is rank 4, so the whole
  // podium is gold and neither 🥈 nor 🥉 appears.
  it('handles a three-way tie for first', () => {
    expect([1, 1, 1, 4].map(rankDisplay)).toEqual(['🥇', '🥇', '🥇', '4'])
  })
})

describe('전체 랭킹 보기', () => {
  it('collapses only a list longer than the top five', () => {
    expect(TOP_RANK_LIMIT).toBe(5)
    expect(hasHiddenRanks(5)).toBe(false)
    expect(hasHiddenRanks(6)).toBe(true)
    expect(hasHiddenRanks(0)).toBe(false)
  })

  // The label names what the next tap does, not the current state — a button
  // reading "전체 랭킹 보기" while the full list is already open is a lie.
  it('labels the button by what tapping it will do', () => {
    expect(rankToggleLabel(false)).toBe('전체 랭킹 보기')
    expect(rankToggleLabel(true)).toBe('TOP5만 보기')
  })
})

describe('parseStrokeRankings', () => {
  const payload = {
    year: 2026,
    rows: [
      { gender: '여', stroke: '자유형', nickname: '영희', rank: 1, pb_seconds: 32.8, score: 100 },
      { gender: '여', stroke: '자유형', nickname: '철수', rank: 2, pb_seconds: 41.0, score: 80 },
      { gender: '남', stroke: '평영', nickname: '길동', rank: 1, pb_seconds: 35.49, score: 100 },
    ],
  }

  it('reads the payload the RPC sends', () => {
    const data = parseStrokeRankings(payload)
    expect(data.year).toBe(2026)
    expect(data.rows).toHaveLength(3)
    // pb_seconds -> pbSeconds: the wire is snake_case, the screen is not.
    expect(data.rows[0]).toEqual({
      gender: '여',
      stroke: '자유형',
      nickname: '영희',
      rank: 1,
      pbSeconds: 32.8,
      score: 100,
    })
  })

  it('refuses the unauthorized answer instead of rendering it', () => {
    // The RPC answers a non-member with a 200 carrying {error}, exactly as
    // team_event_rankings_v1 does, so it arrives as success.
    expect(() => parseStrokeRankings({ error: 'unauthorized' })).toThrow(RankingsContractError)
  })

  it('refuses a payload with no year', () => {
    expect(() => parseStrokeRankings({ rows: [] })).toThrow(RankingsContractError)
  })

  it('treats a missing rows list as empty rather than broken', () => {
    // A club with no meet records yet is an ordinary state and the screen has
    // an empty view for it; only a missing `year` is a broken contract.
    const data = parseStrokeRankings({ year: 2026 })
    expect(data.rows).toEqual([])
    expect(isStrokeRankingsEmpty(data)).toBe(true)
  })

  it('picks out one gender and stroke, keeping server order', () => {
    const data = parseStrokeRankings(payload)
    expect(strokeRowsFor(data, '여', '자유형').map((r) => r.nickname)).toEqual(['영희', '철수'])
    expect(strokeRowsFor(data, '남', '평영').map((r) => r.nickname)).toEqual(['길동'])
    // An empty group is empty, not absent — the screen still renders its card.
    expect(strokeRowsFor(data, '남', '접영')).toEqual([])
  })

  it('does not confuse the two genders', () => {
    const data = parseStrokeRankings(payload)
    expect(strokeRowsFor(data, '남', '자유형')).toEqual([])
  })
})
