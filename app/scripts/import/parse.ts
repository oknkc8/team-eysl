// The club master workbook, turned into plain JSON.
//
// Pure: this module opens no socket and reads no file. It takes the bytes of
// ☆TEAM_EYSL.xlsx and returns data. Everything that touches the database lives
// in toSql.ts, so this half can be unit-tested against a synthetic fixture and
// the real workbook never has to be committed anywhere to prove it works.
//
// THREE SHEETS, AND ONLY THREE.
//
//   ☆명단(출석부)  the roster plus a per-date attendance grid
//   ☆대회 기록      per-meet swim times, in three sections
//   ☆2026 대회      row 0 only, to date the meets whose label omits a date
//
// The workbook also holds four bank-and-dues sheets — 계좌거래내역 plus three
// 회비 sheets, one of them titled with a member's given name. The app has no
// feature that reads any of them and this repository is public, so they are not
// named here and never reach memory: XLSX.read is given an explicit `sheets`
// allowlist, so the other twenty-one are skipped at parse time rather than
// parsed and then politely ignored. ☆2026 대회 carries phone numbers from row 3
// down, which is why only its row 0 is ever read.
//
// The same rule governs the comments in this file: no real name, birth date or
// phone number appears anywhere below, and none should be added.

import * as XLSX from 'xlsx'
import { parseSwimTime } from '../../src/features/records/time.ts'

// ---------------------------------------------------------------- the shapes

export type ImportedMember = {
  no: number
  /**
   * The display name, and the key the SQL joins on.
   *
   * Normally the sheet's short name (column 2), but two members share one, and
   * members_nickname_lower_uq is unique on lower(nickname) — so a colliding
   * short name is disambiguated here rather than losing a member to the upsert.
   */
  nickname: string
  /** The row this member was read from, which is how attendance finds them. */
  sourceRow: number
  shortName: string
  realName: string
  birthYear: number | null
  birthDateText: string
  gender: string
  joinDateText: string
  joinReason: string
  lessonLevel: string
  swimExperience: string
  notes: string
}

export type ImportedTraining = {
  /** ISO yyyy-mm-dd. */
  date: string
  /** The sheet's own half-year split, which is also the ranking window in 0016. */
  half: 'H1' | 'H2'
  /** '1월 4일', kept for the activity title. */
  label: string
}

export type ImportedAttendance = {
  date: string
  nickname: string
  status: 'present' | 'late'
}

export type RecordCategory = 'meet' | 'fin' | 'other'

export type ImportedRecord = {
  nickname: string
  category: RecordCategory
  subcategory: 'personal'
  stroke: string
  distanceM: number
  eventName: string
  eventDate: string
  resultDisplay: string
  resultCentiseconds: number
  memo: string
  /** How eventDate was obtained, so a reader can tell derived from stated. */
  dateSource: 'label' | 'meets-sheet'
  /** True when distanceM fell back to 50 because the label carried no number. */
  distanceAssumed: boolean
}

/**
 * A 단체전 row: a relay time with no swimmer attached.
 *
 * Captured but NOT loadable. public.records.member_id is NOT NULL and the sheet
 * names nobody for these rows — see the note on `relays` in ClubData.
 */
export type ImportedRelay = {
  category: RecordCategory
  relayType: string
  gender: string
  eventName: string
  eventDate: string
  resultDisplay: string
  resultCentiseconds: number
}

export type ImportedMeet = {
  category: RecordCategory
  name: string
  date: string
  dateSource: 'label' | 'meets-sheet'
}

export type ClubData = {
  members: ImportedMember[]
  trainings: ImportedTraining[]
  attendance: ImportedAttendance[]
  meets: ImportedMeet[]
  records: ImportedRecord[]
  /**
   * Relay results, parsed so they are visible, and deliberately not turned into
   * `records` rows by toSql.ts. records.member_id is NOT NULL (0004:67) and the
   * 단체전 block names no swimmers — only 계영/혼계영/혼성계영 and a time. The
   * squads do exist in the 대회 순서 sheet, but only as a given-name fragment
   * with the leg's stroke in brackets, laid out differently for every meet — so
   * attaching them would be a guess that files one member's swim under another
   * member's name.
   */
  relays: ImportedRelay[]
  warnings: string[]
}

export type ParseOptions = {
  /**
   * The calendar year of the attendance grid. The sheet never states one.
   *
   * 2026 is not a guess: all 21 dated columns fall on a Saturday or Sunday in
   * 2026 and only 4 of 21 do in 2025, the 8월 29일 column is empty while 8월
   * 23일 is marked (the grid stops at today), and 17 of the 40 join dates are
   * 26.xx. parseClubWorkbook re-checks the weekend property at parse time and
   * warns rather than trusting this comment.
   */
  attendanceYear?: number
}

// ------------------------------------------------------------------- helpers

/** Cell text, trimmed, with merged blocks filled from their top-left value. */
function sheetMatrix(worksheet: XLSX.WorkSheet): string[][] {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
    header: 1,
    raw: false,
    defval: '',
  })
  const matrix: string[][] = rows.map((row) =>
    (row ?? []).map((cell) => String(cell ?? '').trim()),
  )

  // Excel stores a merged block as one value plus an empty rectangle. The month
  // row of the attendance grid is exactly that — '1월' is written once and
  // spans its three date columns — so without this the second and third columns
  // of every month have no month at all. The 단체전 rows lean on it too: 계영 is
  // written once and spans its 남/여 pair.
  for (const merge of worksheet['!merges'] ?? []) {
    const top = matrix[merge.s.r]?.[merge.s.c] ?? ''
    if (!top) continue
    for (let r = merge.s.r; r <= merge.e.r; r++) {
      const row = (matrix[r] ??= [])
      // Only where the merge left a hole: a value that survived the read is the
      // sheet's own and outranks the block heading.
      for (let c = merge.s.c; c <= merge.e.c; c++) if (!row[c]) row[c] = top
    }
  }

  return matrix
}

const at = (matrix: string[][], r: number, c: number): string => matrix[r]?.[c] ?? ''

const widthOf = (matrix: string[][]): number =>
  matrix.reduce((w, row) => Math.max(w, row?.length ?? 0), 0)

function iso(year: number, month: number, day: number): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${year}-${p(month)}-${p(day)}`
}

function isWeekend(dateIso: string): boolean {
  const day = new Date(`${dateIso}T00:00:00Z`).getUTCDay()
  return day === 0 || day === 6
}

/**
 * A two-digit year to a four-digit one.
 *
 * 30 is the split: this is a masters club, so 97 is 1997 and 01 is 2001. A
 * member born in 2030 is not a case this app will see before the split needs
 * revisiting anyway.
 */
function fourDigitYear(yy: number): number {
  return yy >= 30 ? 1900 + yy : 2000 + yy
}

// ---------------------------------------------------------- ☆명단(출석부)

const COL = {
  no: 0,
  realName: 1,
  shortName: 2,
  joinDate: 3,
  joinReason: 4,
  birth: 5,
  gender: 6,
  lesson: 7,
  experience: 8,
  notes: 9,
  // 10..13 are the sheet's own 상반기/지각/하반기/지각 counters and 14 is 토탈.
  // They are NOT imported: 0016's team_event_rankings_v1 computes the same
  // totals by counting attendance rows and *adds*
  // historical_attendance_count_legacy on top (0016:155-157), so carrying the
  // counters across while also importing the grid would double every number.
  // They are stale besides — one row's 상반기 reads 7 where the grid holds 4,
  // and the workbook itself says '**수식 수정 필요' at the top of ☆대회 기록.
  firstDate: 15,
} as const

/**
 * The nickname prefix e2e owns, which a club member may never carry.
 *
 * e2e/cleanup.sql treats every member whose nickname starts with this as
 * test-owned and deletes them together with their attendance and records. A
 * club member imported under it would therefore be destroyed, silently, by the
 * next Playwright run — and cleanup removing rows looks exactly like cleanup
 * working.
 *
 * Nothing in the sheet collides today. That is a coincidence rather than a
 * control: one nickname edit is all it takes, and the failure is quiet.
 */
export const RESERVED_NICKNAME_PREFIX = 'pwtest'

/** Thrown to abort the whole import rather than skip or rename a row. */
export class ReservedNicknameError extends Error {
  // A plain field, not a `public readonly` constructor parameter: these modules
  // run under Node's strip-only type stripping, which erases annotations and
  // refuses syntax that would need emitting. tsconfig.scripts.json sets
  // erasableSyntaxOnly so tsc catches that at check time rather than at 2am.
  readonly rows: number[]

  constructor(rows: number[]) {
    super(
      `row(s) ${rows.join(', ')} of ☆명단(출석부) carry a nickname starting with ` +
        `'${RESERVED_NICKNAME_PREFIX}', which e2e/cleanup.sql deletes along with all ` +
        `attendance and records filed against it. Importing them would let the next ` +
        `Playwright run destroy real member history. Rename in the sheet and re-run. ` +
        `(No import was performed.)`,
    )
    this.name = 'ReservedNicknameError'
    this.rows = rows
  }
}

const isReserved = (value: string) =>
  value.trim().toLowerCase().startsWith(RESERVED_NICKNAME_PREFIX)

function parseMembers(matrix: string[][], warnings: string[]): ImportedMember[] {
  const members: ImportedMember[] = []
  const seen = new Map<string, number>()
  const reservedRows: number[] = []

  for (let r = 0; r < matrix.length; r++) {
    const no = at(matrix, r, COL.no)
    const realName = at(matrix, r, COL.realName)
    const shortName = at(matrix, r, COL.shortName)
    // A member row is a number, a full name and a short name together. The
    // sheet also holds a trailing row numbered 41 with no name, and a '총 인원'
    // summary row below that; both fail this test.
    if (!/^\d+$/.test(no) || !realName || !shortName) continue

    // Both source names, not the nickname that comes out the far end. The
    // disambiguation below can fall back to the real name, so checking only the
    // final value would let a reserved short name be renamed around — and a
    // member imported under a different nickname than the sheet states is its
    // own defect. Case-insensitive because 'PWtest' is no less confusing than
    // 'pwtest', even though cleanup.sql's LIKE would miss it.
    if (isReserved(shortName) || isReserved(realName)) {
      reservedRows.push(r)
      continue
    }

    const birth = at(matrix, r, COL.birth)
    let birthYear: number | null = null
    if (/^\d{6}$/.test(birth)) birthYear = fourDigitYear(Number(birth.slice(0, 2)))
    else if (/^\d{2}$/.test(birth)) birthYear = fourDigitYear(Number(birth))
    else if (birth) warnings.push(`row ${r}: unreadable 생년월일 shape`)

    // members_nickname_lower_uq (0001) is unique on lower(nickname), so two
    // members sharing a short name would collapse into one row on load — the
    // second overwriting the first, and taking their attendance and records
    // with them. One pair in the real roster does share a short name, so this
    // is not theoretical; without the branch below the import silently loses a
    // member and everything filed against them.
    //
    // Disambiguate rather than drop. Appending the birth year is the club's own
    // spelling of this problem: the legacy app already builds its nicknames as
    // <short name>/<yy>/<gender>/<area> for exactly this reason.
    let nickname = shortName
    if (seen.has(nickname.toLowerCase())) {
      const candidates = [
        birthYear === null ? null : `${shortName}/${String(birthYear).slice(2)}`,
        realName,
        `${realName}/${no}`,
      ]
      const resolved = candidates.find(
        (c): c is string => c !== null && !seen.has(c.toLowerCase()),
      )
      if (resolved === undefined) {
        warnings.push(`row ${r}: short name collides and could not be disambiguated — skipped`)
        continue
      }
      warnings.push(
        `rows ${seen.get(shortName.toLowerCase())} and ${r} share a short name; row ${r} ` +
          `imports with its birth year appended so members_nickname_lower_uq cannot collapse them`,
      )
      nickname = resolved
    }
    seen.set(nickname.toLowerCase(), r)

    members.push({
      no: Number(no),
      nickname,
      sourceRow: r,
      shortName,
      realName,
      birthYear,
      birthDateText: birth,
      gender: at(matrix, r, COL.gender),
      joinDateText: at(matrix, r, COL.joinDate),
      joinReason: at(matrix, r, COL.joinReason),
      lessonLevel: at(matrix, r, COL.lesson),
      swimExperience: at(matrix, r, COL.experience),
      notes: at(matrix, r, COL.notes),
    })
  }

  // After the walk, so one run names every offending row rather than making
  // somebody fix them one at a time. Thrown rather than warned: a warning would
  // let the other 39 members import while the flagged rows went missing, and a
  // partial import that looks successful is how this becomes somebody else's
  // confusing afternoon.
  if (reservedRows.length > 0) throw new ReservedNicknameError(reservedRows)

  return members
}

type DatedColumn = { column: number; date: string; label: string; half: 'H1' | 'H2' }

function parseTrainingColumns(
  matrix: string[][],
  year: number,
  warnings: string[],
): DatedColumn[] {
  const out: DatedColumn[] = []
  const width = widthOf(matrix)

  for (let c = COL.firstDate; c < width; c++) {
    // Row 3 is the month and row 4 the day. Row 3 is merged across each month's
    // columns, which sheetMatrix has already filled rightwards.
    const monthText = at(matrix, 3, c)
    const dayText = at(matrix, 4, c)
    const month = /^(\d{1,2})월$/.exec(monthText)
    const day = /^(\d{1,2})일$/.exec(dayText)
    if (!month || !day) continue

    const monthNumber = Number(month[1])
    const date = iso(year, monthNumber, Number(day[1]))
    if (!isWeekend(date)) {
      // The year is an input, and this is what catches a wrong one. The club
      // trains at weekends; a Tuesday means attendanceYear is off.
      warnings.push(`training ${date} (${monthText} ${dayText}) is not a weekend in ${year}`)
    }

    out.push({
      column: c,
      date,
      label: `${monthText} ${dayText}`,
      half: monthNumber <= 6 ? 'H1' : 'H2',
    })
  }

  return out
}

function parseAttendance(
  matrix: string[][],
  members: ImportedMember[],
  columns: DatedColumn[],
  warnings: string[],
): ImportedAttendance[] {
  const out: ImportedAttendance[] = []
  const unknown = new Set<string>()

  // Keyed by the row the member was read from, never by name. Two members share
  // a short name, so a name lookup would give one of them the other's register.
  for (const member of members) {
    for (const column of columns) {
      const mark = at(matrix, member.sourceRow, column.column)
      // O is 출석 and V is 지각 — stated in row 1 of the sheet ('코칭 / 지각 / V')
      // and confirmed arithmetically: the sheet's own 상반기 counter equals the
      // count of O *plus* V for 39 of 40 members, so a late arrival attended.
      if (mark === 'O') out.push({ date: column.date, nickname: member.nickname, status: 'present' })
      else if (mark === 'V') out.push({ date: column.date, nickname: member.nickname, status: 'late' })
      // '' and '-' produce nothing. See the note in toSql.ts on why a blank is
      // not an 'absent' row.
      else if (mark && mark !== '-') unknown.add(mark)
    }
  }

  for (const mark of unknown) warnings.push(`unrecognised attendance mark ${JSON.stringify(mark)}`)
  return out
}

// ------------------------------------------------------------- ☆대회 기록

/** One meet block is 11 columns wide and the first starts at column 11. */
const BLOCK_WIDTH = 11
const FIRST_BLOCK = 11
/** Offsets inside a block. The odd ones between them are the '+-' deltas. */
const STROKE_OFFSETS: ReadonlyArray<readonly [number, string]> = [
  [0, '자유형'],
  [2, '배영'],
  [4, '평영'],
  [6, '접영'],
]
const OTHER_LABEL_OFFSET = 8
const OTHER_VALUE_OFFSET = 9
const MEMO_OFFSET = 10

/** The sheet's stated basis: '*50m 기준' sits above every section. */
const BASE_DISTANCE = 50

const STROKE_ABBREVIATION: Record<string, string> = {
  자: '자유형',
  배: '배영',
  평: '평영',
  접: '접영',
}

/** Strips a parenthetical only when it holds a date, keeping '(단체전만)'. */
function meetDisplayName(label: string): string {
  return label
    .replace(/\s*\(\s*\d{2,4}\s*[/.]\s*\d{1,2}\s*[/.]\s*\d{1,2}[^)]*\)/g, '')
    .replace(/[<>]/g, '')
    .trim()
}

/** For matching the same meet across two sheets, which punctuate differently. */
function meetKey(label: string): string {
  return meetDisplayName(label).replace(/\([^)]*\)/g, '').replace(/\s+/g, '')
}

/** '(25/05/18)' → 2025-05-18. Takes the first date of a '~' range. */
function dateFromMeetLabel(label: string): string | null {
  const m = /\(\s*(\d{2,4})\s*[/.]\s*(\d{1,2})\s*[/.]\s*(\d{1,2})/.exec(label)
  if (!m) return null
  const y = m[1] ?? ''
  const year = y.length === 4 ? Number(y) : fourDigitYear(Number(y))
  return iso(year, Number(m[2]), Number(m[3]))
}

/**
 * Meet name → date, read from row 0 of ☆2026 대회.
 *
 * That row repeats [meet name] … '대회일자' … [date], and it is the only place
 * in the workbook that dates 제6회 성북구청장배 and 2026 아레나 마스터즈, whose
 * labels in ☆대회 기록 carry no date at all.
 *
 * The rule is checked rather than trusted: five other meets appear in both
 * sheets, and the date this derives agrees with the date written into the
 * ☆대회 기록 label for all five (3월 8일 ↔ 26/03/08, 4월 12일 ↔ 26/04/12,
 * 5월 17일 ↔ 26/05/17, 4월 26일 ↔ 26/04/26, 6월 20일 ↔ 2026/06/20).
 *
 * Row 0 only. Names, birth dates and phone numbers start at row 3.
 */
function parseMeetDateIndex(
  worksheet: XLSX.WorkSheet | undefined,
  year: number,
): Map<string, string> {
  const index = new Map<string, string>()
  if (!worksheet) return index

  const row = sheetMatrix(worksheet)[0] ?? []
  let pending: string | null = null

  for (let c = 0; c < row.length; c++) {
    const cell = row[c] ?? ''
    if (!cell) continue

    if (cell === '대회일자') {
      // The date is the next non-empty cell to the right.
      for (let k = c + 1; k < row.length; k++) {
        const value = row[k] ?? ''
        if (!value) continue
        // 'M월 D일 (요일)', or 'M월 D-D일 (토-일)' for a two-day meet.
        const m = /^(\d{1,2})월\s*(\d{1,2})/.exec(value)
        if (m && pending) index.set(pending, iso(year, Number(m[1]), Number(m[2])))
        break
      }
      pending = null
      continue
    }

    // Every other non-empty cell in row 0 is a meet heading. '대회일자' clears
    // it again, so only the heading immediately before a date is ever paired.
    pending = meetKey(cell)
  }

  return index
}

function categoryFromSectionTitle(title: string): RecordCategory {
  if (title.includes('핀')) return 'fin'
  if (title.includes('기타')) return 'other'
  return 'meet'
}

/** '자100' → 자유형 100m. '개인혼영' → the label itself at the 50m basis. */
function parseOtherEvent(label: string): { stroke: string; distanceM: number; assumed: boolean } {
  const digits = /(\d{2,4})/.exec(label)
  const distanceM = digits ? Number(digits[1]) : BASE_DISTANCE
  const bare = label.replace(/\d+/g, '').replace(/[mM]/g, '').trim()
  const stroke = STROKE_ABBREVIATION[bare] ?? (bare || '기타')
  return { stroke, distanceM, assumed: !digits }
}

type Section = { title: string; category: RecordCategory; meetRow: number; headerRow: number }

function findSections(matrix: string[][]): Section[] {
  const sections: Section[] = []

  for (let r = 0; r < matrix.length; r++) {
    const title = at(matrix, r, 0)
    if (!/^\d\)\s*\S/.test(title)) continue

    // Below a section title come its two header rows, in this order: the one
    // labelled '*50m 기준' carries the meet names, the one labelled 'NO'
    // carries the repeating stroke block.
    let meetRow = -1
    let headerRow = -1
    for (let k = r + 1; k < Math.min(r + 8, matrix.length); k++) {
      const label = at(matrix, k, 0)
      if (label.startsWith('*') && meetRow < 0) meetRow = k
      if (label === 'NO' && headerRow < 0) headerRow = k
    }
    if (meetRow < 0 || headerRow < 0) continue

    sections.push({ title, category: categoryFromSectionTitle(title), meetRow, headerRow })
  }

  return sections
}

function parseRecords(
  matrix: string[][],
  members: ImportedMember[],
  meetDates: Map<string, string>,
  warnings: string[],
): { meets: ImportedMeet[]; records: ImportedRecord[]; relays: ImportedRelay[] } {
  const meets: ImportedMeet[] = []
  const records: ImportedRecord[] = []
  const relays: ImportedRelay[] = []

  // ☆대회 기록 carries both names per row — column 1 the full name, column 2 the
  // short one — and the full name is the one that identifies somebody: two
  // members share a short name, so matching on it would file one person's swims
  // under the other. The short name is kept only as a fallback, and only where
  // it is unambiguous.
  const byRealName = new Map<string, ImportedMember>()
  const shortNameCounts = new Map<string, number>()
  for (const m of members) {
    byRealName.set(m.realName.toLowerCase(), m)
    const key = m.shortName.toLowerCase()
    shortNameCounts.set(key, (shortNameCounts.get(key) ?? 0) + 1)
  }
  const byShortName = new Map<string, ImportedMember>()
  for (const m of members) {
    const key = m.shortName.toLowerCase()
    if (shortNameCounts.get(key) === 1) byShortName.set(key, m)
  }

  // Row numbers, not names. A warning ends up on stderr, and --summary output
  // gets pasted into issues and PR comments — so nothing here may carry a name.
  const unresolved = new Set<number>()
  const width = widthOf(matrix)
  const sections = findSections(matrix)

  for (const [index, section] of sections.entries()) {
    const endRow = sections[index + 1]?.meetRow ?? matrix.length

    // The meets of this section, by block column.
    const blocks: Array<{ column: number; meet: ImportedMeet }> = []
    for (let c = FIRST_BLOCK; c < width; c += BLOCK_WIDTH) {
      const label = at(matrix, section.meetRow, c)
      if (!label) continue

      const fromLabel = dateFromMeetLabel(label)
      const fromSheet = meetDates.get(meetKey(label))
      const date = fromLabel ?? fromSheet ?? null
      if (!date) {
        // event_date is NOT NULL in 0004 and feeds records_dedup_uq, so a made
        // up date would be both a false claim and a sticky one. Skip loudly.
        warnings.push(
          `meet "${label}" (${section.title}) has no date in its label and none in ` +
            `☆2026 대회 — every result in this block is skipped`,
        )
        continue
      }

      const meet: ImportedMeet = {
        category: section.category,
        name: meetDisplayName(label),
        date,
        dateSource: fromLabel ? 'label' : 'meets-sheet',
      }
      meets.push(meet)
      blocks.push({ column: c, meet })
    }

    for (let r = section.headerRow + 1; r < endRow; r++) {
      const rowRealName = at(matrix, r, COL.realName)
      const rowShortName = at(matrix, r, COL.shortName)
      const isMemberRow = /^\d+$/.test(at(matrix, r, COL.no)) && rowShortName !== ''
      const isRelayRow = at(matrix, r, 0).replace(/\s/g, '') === '단체전'
      if (!isMemberRow && !isRelayRow) continue

      if (isRelayRow) {
        // col 1 is the relay type (merged down its gender pair) and col 4 the
        // gender. '녀' appears in the 핀 section where the others write '여'.
        const relayType = at(matrix, r, 1)
        if (!relayType) continue
        const gender = at(matrix, r, 4)
        for (const { column, meet } of blocks) {
          const display = at(matrix, r, column)
          if (!display || display === '-') continue
          const centiseconds = parseSwimTime(display)
          if (centiseconds === null || centiseconds <= 0) {
            warnings.push(
              `row ${r} (relay ${relayType}) at "${meet.name}": unreadable time ` +
                `${JSON.stringify(display)}`,
            )
            continue
          }
          relays.push({
            category: meet.category,
            relayType,
            gender,
            eventName: meet.name,
            eventDate: meet.date,
            resultDisplay: display,
            resultCentiseconds: centiseconds,
          })
        }
        continue
      }

      const member =
        byRealName.get(rowRealName.toLowerCase()) ?? byShortName.get(rowShortName.toLowerCase())
      if (!member) {
        unresolved.add(r)
        continue
      }
      const nickname = member.nickname

      for (const { column, meet } of blocks) {
        const memo = at(matrix, r, column + MEMO_OFFSET)

        const push = (
          stroke: string,
          distanceM: number,
          display: string,
          distanceAssumed: boolean,
        ) => {
          const centiseconds = parseSwimTime(display)
          if (centiseconds === null || centiseconds <= 0) {
            // '-' and '0.00' are both the sheet saying 'no result here', and
            // result_centiseconds > 0 is a CHECK in 0004, so neither can be
            // stored. Anything else that failed to parse is a real reading
            // problem and is named — 'DQ' is the live example, a disqualified
            // swim this schema has no way to record.
            if (display && display !== '-' && centiseconds !== 0) {
              warnings.push(
                `row ${r} ${stroke} at "${meet.name}": no storable time in ` +
                  `${JSON.stringify(display)} — skipped`,
              )
            }
            return
          }
          records.push({
            nickname,
            category: meet.category,
            subcategory: 'personal',
            stroke,
            distanceM,
            eventName: meet.name,
            eventDate: meet.date,
            resultDisplay: display,
            resultCentiseconds: centiseconds,
            memo,
            dateSource: meet.dateSource,
            distanceAssumed,
          })
        }

        // The four stroke columns. The '+-' column after each one is a delta
        // the sheet computes against the previous meet — derived, not data.
        for (const [offset, stroke] of STROKE_OFFSETS) {
          push(stroke, BASE_DISTANCE, at(matrix, r, column + offset), false)
        }

        // '기타 기록' is a label and a value in the next column over: the label
        // names the event ('자100', '개인혼영', '평영(결승)') and can carry its
        // own distance.
        const otherLabel = at(matrix, r, column + OTHER_LABEL_OFFSET)
        const otherValue = at(matrix, r, column + OTHER_VALUE_OFFSET)
        if (otherLabel && otherValue) {
          const parsed = parseOtherEvent(otherLabel)
          push(parsed.stroke, parsed.distanceM, otherValue, parsed.assumed)
        }
      }
    }
  }

  for (const r of unresolved) {
    warnings.push(`row ${r} of ☆대회 기록 names somebody absent from ☆명단(출석부) — records skipped`)
  }

  return { meets, records, relays }
}

// --------------------------------------------------------------- entry point

export const SHEET_MEMBERS = '☆명단(출석부)'
export const SHEET_RECORDS = '☆대회 기록'
export const SHEET_MEETS = '☆2026 대회'

export function parseClubWorkbook(
  data: ArrayBuffer | Uint8Array,
  options: ParseOptions = {},
): ClubData {
  const year = options.attendanceYear ?? 2026
  // An allowlist, not a denylist: `sheets` stops SheetJS parsing the other
  // twenty-one, so the bank and dues sheets never enter this process at all.
  // A denylist would have to be kept in step with a workbook we do not control.
  const workbook = XLSX.read(data, {
    type: 'array',
    sheets: [SHEET_MEMBERS, SHEET_RECORDS, SHEET_MEETS],
  })
  const warnings: string[] = []

  const memberSheet = workbook.Sheets[SHEET_MEMBERS]
  if (!memberSheet) throw new Error(`sheet ${SHEET_MEMBERS} not found`)
  const memberMatrix = sheetMatrix(memberSheet)

  const members = parseMembers(memberMatrix, warnings)
  const columns = parseTrainingColumns(memberMatrix, year, warnings)
  const attendance = parseAttendance(memberMatrix, members, columns, warnings)
  const trainings: ImportedTraining[] = columns.map(({ date, label, half }) => ({
    date,
    label,
    half,
  }))

  const meetDates = parseMeetDateIndex(workbook.Sheets[SHEET_MEETS], year)

  let meets: ImportedMeet[] = []
  let records: ImportedRecord[] = []
  let relays: ImportedRelay[] = []
  const recordSheet = workbook.Sheets[SHEET_RECORDS]
  if (recordSheet) {
    const parsed = parseRecords(sheetMatrix(recordSheet), members, meetDates, warnings)
    meets = parsed.meets
    records = parsed.records
    relays = parsed.relays
  } else {
    warnings.push(`sheet ${SHEET_RECORDS} not found — no records imported`)
  }

  return { members, trainings, attendance, meets, records, relays, warnings }
}
