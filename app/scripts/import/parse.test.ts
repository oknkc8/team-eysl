import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { buildFixtureWorkbook } from './fixture.ts'
import {
  RESERVED_NICKNAME_PREFIX,
  ReservedNicknameError,
  SHEET_MEMBERS,
  parseClubWorkbook,
} from './parse.ts'

const parse = (year?: number) =>
  parseClubWorkbook(buildFixtureWorkbook(), year === undefined ? {} : { attendanceYear: year })

/** The fixture with one member's name column rewritten, to test refusal. */
function workbookWithName(column: 1 | 2, row: number, value: string): ArrayBuffer {
  const workbook = XLSX.read(buildFixtureWorkbook(), { type: 'array' })
  const sheet = workbook.Sheets[SHEET_MEMBERS]
  if (!sheet) throw new Error('fixture lost its member sheet')
  XLSX.utils.sheet_add_aoa(sheet, [[value]], { origin: { r: row, c: column } })
  return XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
}

describe('the nickname prefix e2e owns', () => {
  // e2e/cleanup.sql deletes every member whose nickname starts with `pwtest`,
  // together with their attendance and records. A club member imported under it
  // would be destroyed by the next Playwright run — silently, because cleanup
  // removing rows is cleanup working. Nothing in the real sheet collides today;
  // that is a coincidence, not a control.
  it('refuses a short name carrying the prefix, and imports nothing', () => {
    expect(() => parseClubWorkbook(workbookWithName(2, 5, `${RESERVED_NICKNAME_PREFIX}일`))).toThrow(
      ReservedNicknameError,
    )
  })

  it('refuses a full name carrying the prefix', () => {
    // Both source columns, because the disambiguation path can fall back to the
    // real name — so checking only the short name would let a reserved value
    // reach the database by another route.
    expect(() => parseClubWorkbook(workbookWithName(1, 6, `${RESERVED_NICKNAME_PREFIX}이`))).toThrow(
      ReservedNicknameError,
    )
  })

  it('refuses regardless of case', () => {
    expect(() => parseClubWorkbook(workbookWithName(2, 5, 'PWTest일'))).toThrow(
      ReservedNicknameError,
    )
  })

  it('names the row and no member', () => {
    try {
      parseClubWorkbook(workbookWithName(2, 5, `${RESERVED_NICKNAME_PREFIX}비밀`))
      throw new Error('expected a ReservedNicknameError')
    } catch (error) {
      expect(error).toBeInstanceOf(ReservedNicknameError)
      const { message, rows } = error as ReservedNicknameError
      expect(rows).toEqual([5])
      expect(message).toContain('row(s) 5')
      // The message reaches stderr and gets pasted into public places.
      expect(message).not.toContain('비밀')
    }
  })

  it('does not rename around it', () => {
    // Importing under a different nickname than the sheet states is its own
    // defect: the roster would disagree with the spreadsheet the club maintains.
    expect(() => parseClubWorkbook(workbookWithName(2, 5, `${RESERVED_NICKNAME_PREFIX}일`))).toThrow(
      /No import was performed/,
    )
  })

  it('leaves the clean fixture importing normally', () => {
    // The negative control for all of the above: without a reserved name the
    // same workbook parses, so these tests are detecting the prefix rather than
    // a broken fixture.
    expect(parse().members).toHaveLength(3)
  })
})

describe('members', () => {
  it('reads the three member rows and neither of the two that only look like rows', () => {
    const { members } = parse()
    // Row 4 is numbered but unnamed, and the last row is the '총 인원' summary.
    expect(members.map((m) => m.nickname)).toEqual(['일', '이', '삼'])
  })

  it('carries every scalar column across', () => {
    const [first] = parse().members
    expect(first).toMatchObject({
      no: 1,
      nickname: '일',
      shortName: '일',
      realName: '테스트일',
      birthDateText: '900101',
      gender: '여',
      joinDateText: '26.01.02',
      joinReason: '연습',
      lessonLevel: '상급',
      swimExperience: '-',
    })
  })

  it('reads a birth year from either the 6-digit or the 2-digit spelling', () => {
    // '900101' → 1990, '95' → 1995, '000315' → 2000. The split is at 30, so a
    // two-digit 95 is the 1900s and 00 is the 2000s.
    expect(parse().members.map((m) => m.birthYear)).toEqual([1990, 1995, 2000])
  })
})

describe('trainings', () => {
  it('dates each column from the merged month row and the day row', () => {
    expect(parse().trainings).toEqual([
      { date: '2026-01-03', half: 'H1', label: '1월 3일' },
      // c16 has a month only because '1월' is a merged block. Reading the sheet
      // without filling merges leaves this column undated and it disappears.
      { date: '2026-01-10', half: 'H1', label: '1월 10일' },
      { date: '2026-02-07', half: 'H1', label: '2월 7일' },
    ])
  })

  it('warns for every training that is not on a weekend in the year given', () => {
    // The club trains at weekends. All three dates are Saturdays in 2026 and
    // none is in 2025, so a wrong year announces itself instead of quietly
    // loading the activities onto the wrong days.
    expect(parse(2026).warnings.filter((w) => w.includes('not a weekend'))).toHaveLength(0)
    expect(parse(2025).warnings.filter((w) => w.includes('not a weekend'))).toHaveLength(3)
  })
})

describe('attendance', () => {
  it('turns O into present and V into late, and a blank or a dash into nothing', () => {
    expect(parse().attendance).toEqual([
      { date: '2026-01-03', nickname: '일', status: 'present' },
      { date: '2026-01-10', nickname: '일', status: 'late' },
      { date: '2026-02-07', nickname: '일', status: 'present' },
      // 테스트이's first cell is blank and the third is '-'; only the O survives.
      { date: '2026-01-10', nickname: '이', status: 'present' },
      { date: '2026-01-03', nickname: '삼', status: 'present' },
    ])
  })

  it('never invents an absent row', () => {
    // 'absent' is unreachable through the type — ImportedAttendance.status is
    // 'present' | 'late' — so the interesting half is the count. Three members
    // across three dated columns is nine cells, of which four are a blank, a
    // '-', a blank and an 'X'. A blank is ambiguous ('did not come' and 'was
    // not a member yet' look identical), so the import records only what the
    // register actually asserts, and those four produce no row at all.
    const { attendance } = parse()
    expect(attendance).toHaveLength(5)
    expect([...new Set<string>(attendance.map((a) => a.status))].sort()).toEqual([
      'late',
      'present',
    ])
  })

  it('reports a mark it does not recognise instead of guessing', () => {
    expect(parse().warnings.some((w) => w.includes('unrecognised attendance mark "X"'))).toBe(true)
  })
})

describe('records', () => {
  it('parses a plain seconds time to centiseconds', () => {
    const record = parse().records.find(
      (r) => r.nickname === '일' && r.stroke === '자유형' && r.eventDate === '2026-03-08',
    )
    expect(record).toMatchObject({
      resultDisplay: '44.40',
      resultCentiseconds: 4440,
      distanceM: 50,
      category: 'meet',
      subcategory: 'personal',
      memo: '좋았음',
    })
  })

  it('parses a minutes:seconds time to centiseconds', () => {
    // '자100' is a 기타 기록 label: it names the stroke and carries its own
    // distance, so this is a 100m freestyle rather than the 50m default.
    const record = parse().records.find((r) => r.distanceM === 100)
    expect(record).toMatchObject({
      nickname: '일',
      stroke: '자유형',
      distanceM: 100,
      resultDisplay: '1:05.32',
      resultCentiseconds: 6532,
      distanceAssumed: false,
    })
  })

  it('skips a malformed cell and says which one', () => {
    const { records, warnings } = parse()
    // 'DQ' is a disqualification. result_centiseconds is NOT NULL with a > 0
    // CHECK, so there is no way to file it — but dropping it silently would
    // read as 테스트이 never having swum that event.
    //
    // Scoped to the meet that holds the DQ. 테스트이 does have a result in the
    // 기타 section, so a global "has no records" assertion would pass for the
    // wrong reason before that section existed and fail for the wrong reason
    // after it.
    const atDqMeet = records.filter((r) => r.nickname === '이' && r.eventDate === '2026-03-08')
    expect(atDqMeet).toHaveLength(0)
    expect(warnings.some((w) => w.includes('DQ'))).toBe(true)
  })

  it('treats 0.00 as the sheet saying nothing, not as a bad reading', () => {
    // Unlike DQ this is filler, and warning about it would train a reader to
    // ignore the warnings that matter.
    expect(parse().warnings.some((w) => w.includes('0.00'))).toBe(false)
  })

  it('skips the +- delta columns', () => {
    // c12 holds '1.10', a delta against the previous meet. If the block walk
    // were off by one it would be filed as a 1.10-second swim.
    expect(parse().records.some((r) => r.resultDisplay === '1.10')).toBe(false)
  })

  it('dates a meet from its own label', () => {
    expect(parse().meets.find((m) => m.name === '테스트 대회')).toMatchObject({
      date: '2026-03-08',
      dateSource: 'label',
      category: 'meet',
    })
  })

  it('dates a meet with no date in its label from ☆2026 대회', () => {
    const { meets, records } = parse()
    expect(meets.find((m) => m.name === '테스트 무일자 대회')).toMatchObject({
      date: '2026-07-19',
      dateSource: 'meets-sheet',
    })
    // And the result inside that block actually lands on the resolved date.
    expect(records.find((r) => r.nickname === '삼')).toMatchObject({
      eventDate: '2026-07-19',
      resultCentiseconds: 3333,
    })
  })

  it('maps all three sections to their own category', () => {
    const { records } = parse()
    expect(records.find((r) => r.eventDate === '2026-03-08')?.category).toBe('meet')
    expect(records.find((r) => r.eventDate === '2026-05-17')?.category).toBe('fin')
    // 기타 → 'other'. Until the fixture grew a third section this branch of
    // categoryFromSectionTitle was never executed by a test, and every one of
    // the schema's three categories has to be reachable from a real sheet.
    expect(records.find((r) => r.eventDate === '2026-01-17')?.category).toBe('other')
  })

  it('walks past a section boundary without losing or merging rows', () => {
    const { records, meets } = parse()
    // Three sections, each with its own meet row, header row and 단체전 block.
    // A walk that overran section 2 would file 기타 results under 'fin'.
    expect(meets.map((m) => m.category)).toEqual(['meet', 'meet', 'fin', 'other'])
    const other = records.filter((r) => r.category === 'other')
    expect(other).toHaveLength(2)
    expect(other.map((r) => r.stroke).sort()).toEqual(['배영', '자유형'])
  })
})

describe('relays', () => {
  it('reads a 단체전 time but keeps it out of records', () => {
    const { relays, records } = parse()
    expect(relays).toEqual([
      {
        category: 'meet',
        relayType: '계영',
        gender: '남',
        eventName: '테스트 대회',
        eventDate: '2026-03-08',
        resultDisplay: '1:58.54',
        resultCentiseconds: 11854,
      },
      // The 기타 section has a 단체전 block too, which is what proves the relay
      // walk is per-section rather than only ever finding the first one.
      {
        category: 'other',
        relayType: '혼성계영',
        gender: '',
        eventName: '테스트 신년회',
        eventDate: '2026-01-17',
        resultDisplay: '2:29.82',
        resultCentiseconds: 14982,
      },
    ])
    // records.member_id is NOT NULL and the block names no swimmers, so a relay
    // must never reach the records list.
    expect(records.some((r) => r.resultCentiseconds === 11854)).toBe(false)
    expect(records.some((r) => r.resultCentiseconds === 14982)).toBe(false)
  })
})
