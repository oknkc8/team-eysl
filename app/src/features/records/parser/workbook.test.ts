import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import type { MatchState, RosterEntry } from './roster'
import { parseWorkbook, sheetToMatrix } from './workbook'

// No real meet sheet was available to write these against — the club's result
// sheets live in the president's own storage, which this work could not reach.
// Every fixture below reproduces a shape the legacy parser is *documented* to
// expect, which is not the same as proving the parser handles every sheet it
// will actually meet. What they do prove is that the port did not change the
// behaviour on the shapes we can describe, and that the failure modes that
// matter — a wrong time, a time filed against the wrong person — are refused.

type SheetSpec = {
  name: string
  rows: unknown[][]
  merges?: XLSX.Range[]
}

/**
 * Fixtures go through XLSX.write/read rather than straight into the parser, so
 * they exercise the same path the browser does: merges, number formats and
 * date cells all survive a real xlsx round trip, or the test fails.
 */
function workbookBuffer(sheets: SheetSpec[]): ArrayBuffer {
  const wb = XLSX.utils.book_new()
  for (const sheet of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(sheet.rows, { cellDates: true })
    if (sheet.merges) ws['!merges'] = sheet.merges
    XLSX.utils.book_append_sheet(wb, ws, sheet.name)
  }
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
}

/** How Excel stores a time: a moment on its zero day, which SheetJS reads in UTC. */
function excelTime(seconds: number): Date {
  const whole = Math.floor(seconds)
  const millis = Math.round((seconds - whole) * 1000)
  return new Date(Date.UTC(1899, 11, 30, 0, 0, whole, millis))
}

const KIM: RosterEntry = { memberId: 'm-kim', nickname: '철수', realName: '김철수' }
const LEE: RosterEntry = { memberId: 'm-lee', nickname: '영희', realName: '이영희' }
const PARK: RosterEntry = { memberId: 'm-park', nickname: '서준', realName: '박서준' }
const CHOI: RosterEntry = { memberId: 'm-choi', nickname: '유진', realName: '최유진' }
const ROSTER = [KIM, LEE, PARK, CHOI]

// Carries no readable date, so every fixture's event_date comes from the sheet
// itself and the assertions stay deterministic. inferMeetName keeps it verbatim
// once the trailing 결과 is stripped.
const FILE_NAME = '2026 한강배 수영대회 결과.xlsx'

function parse(sheets: SheetSpec[], roster: RosterEntry[] = ROSTER) {
  return parseWorkbook(workbookBuffer(sheets), { fileName: FILE_NAME, category: 'meet', roster })
}

const memberOf = (match: MatchState) => (match.kind === 'matched' ? match.memberId : null)

describe('a standard meet sheet', () => {
  // 종목 / 순위 / 이름 / 소속 / 기록, several clubs mixed into one table — the
  // shape every 결과지 the club receives is some variation of.
  const SHEET: SheetSpec = {
    name: '결과',
    rows: [
      ['2026 한강배 수영대회', '', '', '', ''],
      ['일시: 2026.05.17', '', '', '', ''],
      ['종목', '순위', '이름', '소속', '기록'],
      ['자유형 50m', 1, '김철수', 'EYSL', '27.31'],
      ['자유형 50m', 2, '박민수', '한강클럽', '28.02'],
      ['자유형 50m', 3, '이영희', 'EYSL', '29.44'],
      ['자유형 100m', 1, '최지훈', 'SEOUL SC', '58.10'],
      ['자유형 100m', 2, '김철수', 'EYSL', '1:02.55'],
    ],
  }

  it('returns only the EYSL rows, one per swim', async () => {
    const result = await parse([SHEET])

    expect(result.rows).toHaveLength(3)
    expect(result.rows.map((row) => row.sourceName)).toEqual(['김철수', '이영희', '김철수'])
    // 박민수 and 최지훈 swam the same events for other clubs. Nothing about
    // them reaches the review table.
    expect(result.rows.some((row) => row.sourceTeam !== 'EYSL')).toBe(false)
  })

  it('reads the whole row, not just the time', async () => {
    const result = await parse([SHEET])
    const [first] = result.rows

    expect(first).toMatchObject({
      sheetName: '결과',
      // 1-based: the row a person reading the sheet in Excel would point at.
      rowNumber: 4,
      sourceName: '김철수',
      sourceTeam: 'EYSL',
      category: 'meet',
      subcategory: 'personal',
      stroke: '자유형',
      distanceM: 50,
      eventDate: '2026-05-17',
      eventName: '2026 한강배 수영대회',
      resultDisplay: '27.31',
      resultCentiseconds: 2731,
      teammates: [],
    })
    expect(first && memberOf(first.match)).toBe('m-kim')
  })

  it('reads a time over a minute as minutes, not as seconds', async () => {
    const result = await parse([SHEET])
    const hundred = result.rows.find((row) => row.distanceM === 100)

    expect(hundred?.resultDisplay).toBe('1:02.55')
    expect(hundred?.resultCentiseconds).toBe(6255)
  })

  it('counts what it saw, so an empty table can be explained', async () => {
    const result = await parse([SHEET])

    expect(result.sheets).toEqual([
      { sheetName: '결과', headerRows: 1, eyslRows: 3, parsedRows: 3, skippedRows: 0 },
    ])
  })

  it('carries the match state rather than the member id alone', async () => {
    // 이영희 is off the roster for this parse — a swimmer who has not signed up
    // yet, or whose 실명 is spelled differently on the club's list.
    const result = await parse([SHEET], [KIM])

    expect(result.rows).toHaveLength(3)
    const lee = result.rows.find((row) => row.sourceName === '이영희')
    // The legacy dropped this row and said nothing. Now it survives, unsaveable
    // until a person says who swam it.
    expect(lee?.match).toEqual({ kind: 'unmatched' })
    expect(lee?.resultDisplay).toBe('29.44')
  })

  it('flags a 실명 two members share instead of picking one', async () => {
    const twin: RosterEntry = { memberId: 'm-kim-2', nickname: '철수2', realName: '김철수' }
    const result = await parse([SHEET], [KIM, twin])

    const kim = result.rows.find((row) => row.sourceName === '김철수')
    expect(kim?.match).toEqual({ kind: 'ambiguous', candidates: [KIM, twin] })
  })
})

describe('a merged event column', () => {
  // The event is written once and merged down over the twelve rows of the heat.
  // eventContextAbove only looks ten rows up, so the swimmer at the bottom is
  // out of its reach: without the merge fill this row names no stroke at all.
  const ROWS: unknown[][] = [
    ['종목', '순위', '이름', '소속', '기록'],
    ['배영 100m', 1, '가나다', 'A클럽', '1:05.10'],
    ['', 2, '라마바', 'B클럽', '1:06.20'],
    ['', 3, '사아자', 'C클럽', '1:07.30'],
    ['', 4, '차카타', 'D클럽', '1:08.40'],
    ['', 5, '파하가', 'E클럽', '1:09.50'],
    ['', 6, '나다라', 'F클럽', '1:10.60'],
    ['', 7, '마바사', 'G클럽', '1:11.70'],
    ['', 8, '아자차', 'H클럽', '1:12.80'],
    ['', 9, '카타파', 'I클럽', '1:13.90'],
    ['', 10, '하가나', 'J클럽', '1:14.00'],
    ['', 11, '다라마', 'K클럽', '1:15.10'],
    ['', 12, '김철수', 'EYSL', '1:16.44'],
  ]
  const MERGES: XLSX.Range[] = [{ s: { r: 1, c: 0 }, e: { r: 12, c: 0 } }]

  it('fills a merged block into the rows it covers', () => {
    const ws = XLSX.utils.aoa_to_sheet(ROWS, { cellDates: true })
    ws['!merges'] = MERGES
    const matrix = sheetToMatrix(ws)

    expect(matrix[1]?.[0]).toBe('배영 100m')
    expect(matrix[12]?.[0]).toBe('배영 100m')
  })

  it('files the swimmer under the event the merge covers', async () => {
    const result = await parse([{ name: '배영', rows: ROWS, merges: MERGES }])

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({
      stroke: '배영',
      distanceM: 100,
      resultDisplay: '1:16.44',
      resultCentiseconds: 7644,
    })
  })

  it('would have lost that swim without the merge — which is why the fill exists', async () => {
    const result = await parse([{ name: '배영', rows: ROWS }])

    // The same sheet with merge information removed. The row is still
    // recognised as an EYSL row and still counted, but it names no stroke, so
    // nothing is filed.
    expect(result.rows).toHaveLength(0)
    expect(result.sheets[0]).toMatchObject({ eyslRows: 1, parsedRows: 0, skippedRows: 1 })
  })
})

describe('times Excel did not store as text', () => {
  const SHEET: SheetSpec = {
    name: '기록',
    rows: [
      ['일시: 2026.05.17', '', '', '', ''],
      ['종목', '순위', '이름', '소속', '기록'],
      // A real time cell. Its number format is usually a date format, so the
      // formatted read of this cell is something like "1/0/00".
      ['자유형 50m', 1, '김철수', 'EYSL', excelTime(27.31)],
      // The same thing typed without a format: a fraction of a day.
      ['자유형 100m', 1, '이영희', 'EYSL', 65.32 / 86400],
    ],
  }

  it('recovers a Date cell as a swim time', async () => {
    const result = await parse([SHEET])
    const kim = result.rows.find((row) => row.sourceName === '김철수')

    expect(kim?.resultDisplay).toBe('27.31')
    expect(kim?.resultCentiseconds).toBe(2731)
  })

  it('recovers a fraction of a day as a swim time', async () => {
    const result = await parse([SHEET])
    const lee = result.rows.find((row) => row.sourceName === '이영희')

    expect(lee?.resultDisplay).toBe('1:05.32')
    expect(lee?.resultCentiseconds).toBe(6532)
  })

  it('leaves the rank column alone', async () => {
    // 1 is a number too, and coercing it would file a one-second swim.
    const result = await parse([SHEET])
    expect(result.rows).toHaveLength(2)
  })
})

describe('a relay block', () => {
  // No 이름 column and no per-swimmer rows: a title, then one row per club
  // carrying four swimmers and one time.
  const SHEET: SheetSpec = {
    name: '계영',
    rows: [
      ['일시: 2026.05.17', '', '', '', '', '', ''],
      ['혼계영 200m 결선', '', '', '', '', '', ''],
      ['순위', '소속', '영자1', '영자2', '영자3', '영자4', '기록'],
      [1, 'EYSL', '김철수', '이영희', '박서준', '최유진', '2:05.31'],
      [2, '한강클럽', '한가람', '두가람', '세가람', '네가람', '2:08.44'],
    ],
  }

  it('credits the swim to every swimmer the roster recognises', async () => {
    const result = await parse([SHEET])

    expect(result.rows).toHaveLength(4)
    expect(result.rows.map((row) => memberOf(row.match))).toEqual([
      'm-kim',
      'm-lee',
      'm-park',
      'm-choi',
    ])
    expect(result.rows[0]).toMatchObject({
      subcategory: 'relay',
      stroke: '혼계영',
      distanceM: 200,
      resultDisplay: '2:05.31',
      resultCentiseconds: 12531,
    })
  })

  it('does not credit the other club in the same block', async () => {
    const result = await parse([SHEET])
    expect(result.rows.some((row) => row.sourceName.endsWith('가람'))).toBe(false)
  })

  it('collects teammates from the whole block, header words included', async () => {
    const result = await parse([SHEET])

    // Ported behaviour, not desired behaviour: genericNamesFromCells matches
    // any two-to-four syllable cell, so the column headings come along.
    // Asserted so a cleanup pass has to change it deliberately.
    expect(result.rows[0]?.teammates).toEqual([
      '순위',
      '소속',
      '기록',
      '김철수',
      '이영희',
      '박서준',
      '최유진',
      '한강클럽',
    ])
  })

  it('surfaces a block it cannot attribute instead of dropping it', async () => {
    const result = await parse([SHEET], [])

    // The legacy required at least one matched member and skipped the block
    // otherwise, so an EYSL relay swum by four members who were not yet on the
    // roster vanished. One unattributed row now stands in for the block.
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({
      sourceName: '',
      subcategory: 'relay',
      stroke: '혼계영',
      resultDisplay: '2:05.31',
      match: { kind: 'unmatched' },
    })
  })
})

describe('rows that must not parse', () => {
  it('refuses a time no one could have swum, and says it refused one', async () => {
    const result = await parse([
      {
        name: '불가능',
        rows: [
          ['일시: 2026.05.17', '', '', '', ''],
          ['종목', '순위', '이름', '소속', '기록'],
          // 5.1 seconds for a 50m. A rank, a lane or a fee that landed in the
          // 기록 column looks exactly like this.
          ['자유형 50m', 1, '김철수', 'EYSL', '05.10'],
        ],
      },
    ])

    expect(result.rows).toHaveLength(0)
    expect(result.sheets[0]).toMatchObject({ eyslRows: 1, parsedRows: 0, skippedRows: 1 })
  })

  it('refuses a row whose event is nowhere on the sheet', async () => {
    const result = await parse([
      {
        name: '무종목',
        rows: [
          ['이름', '소속', '기록'],
          ['김철수', 'EYSL', '27.31'],
        ],
      },
    ])

    // A readable, plausible time — but a time of *what*? stroke and distance_m
    // are both not-null columns, and a guess here is a fabricated record.
    expect(result.rows).toHaveLength(0)
    expect(result.sheets[0]).toMatchObject({ eyslRows: 1, skippedRows: 1 })
  })

  it('ignores a club that is not EYSL', async () => {
    const result = await parse([
      {
        name: '타클럽',
        rows: [
          ['종목', '이름', '소속', '기록'],
          ['자유형 50m', '박민수', '한강클럽', '28.02'],
        ],
      },
    ])

    expect(result.rows).toHaveLength(0)
    // Not even counted: this row was never a candidate, unlike the two above.
    expect(result.sheets[0]).toMatchObject({ headerRows: 1, eyslRows: 0, skippedRows: 0 })
  })
})

describe("the club's own internal sheet", () => {
  // The file the club actually has: members down the side, events across the
  // top, and no 소속 column anywhere, because everyone on it is EYSL.
  const SHEET: SheetSpec = {
    name: '팀 기록표',
    rows: [
      ['2026 EYSL 팀 기록표', '', '', '', ''],
      ['이름', '25m 자유형', '50m 자유형', '100m 자유형', '50m 접영'],
      ['김철수', '14.20', '31.05', '1:08.44', '35.10'],
      ['이영희', '15.10', '33.20', '1:12.10', '37.44'],
      ['박서준', '13.90', '30.11', '1:06.20', '33.80'],
    ],
  }

  it('yields nothing at all rather than throwing', async () => {
    const result = await parse([SHEET])
    expect(result.rows).toHaveLength(0)
  })

  it('reports that it found no header, a different problem from an empty meet', async () => {
    const result = await parse([SHEET])

    // headerRows: 0 is what lets the screen say "이름·소속·기록 열을 찾지
    // 못했습니다" instead of "이 대회에 EYSL 선수 기록이 없습니다". Both render
    // an empty table; only one of them is the admin's to fix.
    expect(result.sheets[0]).toEqual({
      sheetName: '팀 기록표',
      headerRows: 0,
      eyslRows: 0,
      parsedRows: 0,
      skippedRows: 0,
    })
  })
})

describe('a workbook of several sheets', () => {
  it('walks every sheet and reports each one separately', async () => {
    const result = await parse([
      {
        name: '자유형',
        rows: [
          ['일시: 2026.05.17', '', '', '', ''],
          ['종목', '순위', '이름', '소속', '기록'],
          ['자유형 50m', 1, '김철수', 'EYSL', '27.31'],
        ],
      },
      {
        name: '평영',
        rows: [
          ['일시: 2026.05.17', '', '', '', ''],
          ['종목', '순위', '이름', '소속', '기록'],
          ['평영 100m', 1, '이영희', 'EYSL', '1:28.90'],
        ],
      },
    ])

    expect(result.rows).toHaveLength(2)
    expect(result.sheets.map((sheet) => sheet.sheetName)).toEqual(['자유형', '평영'])
    expect(result.rows.map((row) => row.sheetName)).toEqual(['자유형', '평영'])
    expect(result.rows.map((row) => row.stroke)).toEqual(['자유형', '평영'])
  })

  it('reports progress per sheet, so a slow file is not a frozen screen', async () => {
    const seen: string[] = []
    await parseWorkbook(
      workbookBuffer([
        { name: 'A', rows: [['이름', '소속', '기록']] },
        { name: 'B', rows: [['이름', '소속', '기록']] },
      ]),
      {
        fileName: FILE_NAME,
        category: 'meet',
        roster: ROSTER,
        onProgress: (progress) => seen.push(`${progress.phase}:${progress.sheetName}`),
      },
    )

    expect(seen).toEqual(['parsing:A', 'parsing:B', 'done:'])
  })
})
