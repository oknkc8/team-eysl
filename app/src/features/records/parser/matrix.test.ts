import { describe, expect, it } from 'vitest'
import {
  dedupeParsedRows,
  parseMatrixResults,
  relayCandidatesFromMatrix,
  type MatrixContext,
} from './matrix'
import type { RosterEntry } from './roster'
import type { ParsedRow } from './types'

// The row walk driven straight off a hand-written matrix, with no Excel in the
// way. workbook.test.ts proves the SheetJS encoding; this file proves what the
// walk does with the cells once it has them.

const KIM: RosterEntry = { memberId: 'm-kim', nickname: '철수', realName: '김철수' }
const LEE: RosterEntry = { memberId: 'm-lee', nickname: '영희', realName: '이영희' }
const PARK: RosterEntry = { memberId: 'm-park', nickname: '서준', realName: '박서준' }
const CHOI: RosterEntry = { memberId: 'm-choi', nickname: '유진', realName: '최유진' }

const context = (roster: RosterEntry[] = [KIM, LEE, PARK, CHOI]): MatrixContext => ({
  sheetName: '결과',
  eventDate: '2026-05-17',
  eventName: '한강배',
  category: 'meet',
  roster,
})

describe('parseMatrixResults', () => {
  it('keeps each table to its own header', () => {
    // Two events on one sheet, and the second puts its columns in a different
    // order. Without the "next header ends this table" rule the second table's
    // rows would be read through the first table's columns — a time filed
    // against whatever happened to sit in that column.
    const matrix = [
      ['종목', '이름', '소속', '기록'],
      ['자유형 50m', '김철수', 'EYSL', '27.31'],
      ['종목', '소속', '이름', '기록'],
      ['평영 100m', 'EYSL', '이영희', '1:28.90'],
    ]

    const walk = parseMatrixResults(matrix, context())

    expect(walk.headerRows).toBe(2)
    expect(walk.rows.map((row) => row.sourceName)).toEqual(['김철수', '이영희'])
    expect(walk.rows[1]).toMatchObject({ stroke: '평영', distanceM: 100, rowNumber: 4 })
  })

  it('prefers a 거리 column over anything read out of prose', () => {
    const matrix = [
      ['영법', '거리', '이름', '소속', '기록'],
      ['자유형', '100 m', '김철수', 'EYSL', '1:02.55'],
    ]

    const walk = parseMatrixResults(matrix, context())
    expect(walk.rows[0]).toMatchObject({ stroke: '자유형', distanceM: 100 })
  })

  it('takes the event from the rows above when there is no 종목 column', () => {
    const matrix = [
      ['여자 접영 50m 결선', '', '', ''],
      ['순위', '이름', '소속', '기록'],
      ['1', '이영희', 'EYSL', '33.08'],
    ]

    const walk = parseMatrixResults(matrix, context())
    expect(walk.rows[0]).toMatchObject({ stroke: '접영', distanceM: 50, resultCentiseconds: 3308 })
  })

  it('surfaces a row it cannot attribute instead of dropping it', () => {
    const matrix = [
      ['종목', '이름', '소속', '기록'],
      ['자유형 50m', '한가람', 'EYSL', '29.10'],
    ]

    const walk = parseMatrixResults(matrix, context())

    // The legacy `continue`d here and the swim was gone. It now reaches the
    // review screen with no member attached, which makes it the admin's
    // decision rather than the parser's.
    expect(walk.rows).toHaveLength(1)
    expect(walk.rows[0]?.match).toEqual({ kind: 'unmatched' })
    expect(walk.eyslRows).toBe(1)
  })

  it('refuses to choose between two members with the same 실명', () => {
    const twin: RosterEntry = { memberId: 'm-kim-2', nickname: '철수2', realName: '김철수' }
    const matrix = [
      ['종목', '이름', '소속', '기록'],
      ['자유형 50m', '김철수', 'EYSL', '27.31'],
    ]

    const walk = parseMatrixResults(matrix, context([KIM, twin]))

    // `.find()` would have taken whichever came first in the roster and filed
    // one swimmer's best against the other, silently and permanently.
    expect(walk.rows[0]?.match).toEqual({ kind: 'ambiguous', candidates: [KIM, twin] })
  })

  it('does not treat a spaced 실명 as a match', () => {
    const matrix = [
      ['종목', '이름', '소속', '기록'],
      ['자유형 50m', '김 철수', 'EYSL', '27.31'],
    ]

    const walk = parseMatrixResults(matrix, context())
    expect(walk.rows[0]?.match).toEqual({ kind: 'unmatched' })
    expect(walk.rows[0]?.sourceName).toBe('김 철수')
  })

  it('carries a row whose distance it never learned', () => {
    const matrix = [
      ['종목', '이름', '소속', '기록'],
      ['자유형 결선', '김철수', 'EYSL', '27.31'],
    ]

    const walk = parseMatrixResults(matrix, context())

    // distance_m is `not null check (> 0)`, so this row cannot be saved as it
    // stands — but it is shown rather than dropped, because "a time we could
    // not place" is something the admin should see.
    expect(walk.rows).toHaveLength(1)
    expect(walk.rows[0]?.distanceM).toBeNull()
  })

  it('skips an empty row without counting it against the sheet', () => {
    const matrix = [
      ['종목', '이름', '소속', '기록'],
      ['', '', '', ''],
      ['자유형 50m', '김철수', 'EYSL', '27.31'],
    ]

    const walk = parseMatrixResults(matrix, context())
    expect(walk).toMatchObject({ eyslRows: 1, skippedRows: 0 })
  })

  it('finds no header at all in a sheet with no 소속 column', () => {
    const matrix = [
      ['이름', '25m 자유형', '50m 자유형'],
      ['김철수', '14.20', '31.05'],
    ]

    expect(parseMatrixResults(matrix, context())).toEqual({
      rows: [],
      headerRows: 0,
      eyslRows: 0,
      skippedRows: 0,
    })
  })
})

describe('relayCandidatesFromMatrix', () => {
  const BLOCK = [
    ['혼계영 200m 결선', '', '', '', '', ''],
    ['1', 'EYSL', '김철수', '이영희', '박서준', '최유진', '2:05.31'],
  ]

  it('reads the time off the row that names the club', () => {
    const rows = relayCandidatesFromMatrix(BLOCK, context())

    expect(rows).toHaveLength(4)
    expect(rows[0]).toMatchObject({
      subcategory: 'relay',
      stroke: '혼계영',
      distanceM: 200,
      resultDisplay: '2:05.31',
      // The title row, which is where an admin looking for this block starts.
      rowNumber: 1,
    })
  })

  it('ignores a heading that says 계영 but lists nobody', () => {
    const rows = relayCandidatesFromMatrix(
      [
        ['계영 400m 안내', '', '', ''],
        ['EYSL', '참가 신청 마감', '', '4:20.10'],
      ],
      context(),
    )
    expect(rows).toEqual([])
  })

  it('ignores a relay block with no EYSL entry in it', () => {
    const rows = relayCandidatesFromMatrix(
      [
        ['혼계영 200m 결선', '', '', '', '', ''],
        ['1', '한강클럽', '한가람', '두가람', '세가람', '네가람', '2:08.44'],
      ],
      context(),
    )
    expect(rows).toEqual([])
  })
})

describe('dedupeParsedRows', () => {
  const row = (over: Partial<ParsedRow>): ParsedRow => ({
    key: 'k',
    sheetName: '결과',
    rowNumber: 2,
    sourceName: '김철수',
    sourceTeam: 'EYSL',
    match: { kind: 'matched', memberId: 'm-kim', nickname: '철수' },
    category: 'meet',
    subcategory: 'personal',
    stroke: '자유형',
    distanceM: 50,
    eventDate: '2026-05-17',
    eventName: '한강배',
    resultDisplay: '27.31',
    resultCentiseconds: 2731,
    teammates: [],
    ...over,
  })

  it('collapses two readings of the same swim', () => {
    const rows = dedupeParsedRows([row({ key: 'a' }), row({ key: 'b' })])
    expect(rows).toHaveLength(1)
  })

  it('keeps two different events for the same swimmer', () => {
    const rows = dedupeParsedRows([
      row({ key: 'a', distanceM: 50 }),
      row({ key: 'b', distanceM: 100, resultDisplay: '1:02.55', resultCentiseconds: 6255 }),
    ])
    expect(rows).toHaveLength(2)
  })

  it('does not merge two swimmers it has not identified yet', () => {
    // Both rows have no member id. Keyed on that alone they would collapse into
    // one, and one of two swimmers would disappear before the admin ever saw
    // them.
    const rows = dedupeParsedRows([
      row({ key: 'a', sourceName: '한가람', match: { kind: 'unmatched' } }),
      row({ key: 'b', sourceName: '두가람', match: { kind: 'unmatched' } }),
    ])
    expect(rows.map((r) => r.sourceName)).toEqual(['한가람', '두가람'])
  })
})
