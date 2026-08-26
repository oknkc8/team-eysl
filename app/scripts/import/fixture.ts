// A synthetic workbook shaped like the club's, built in memory.
//
// EVERY VALUE HERE IS INVENTED. The real ☆TEAM_EYSL.xlsx holds the names, birth
// dates and phone numbers of forty real people and this repository is public,
// so it is never committed, never copied in, and never read by a test. What is
// committed is this builder: the *shape* of the sheet, which is the part the
// parser has to get right, filled with 테스트일/테스트이/테스트삼 and times
// nobody swam.
//
// The shape is small but not simplified. It keeps every part that has actually
// broken a reading: the merged month header, the merged 계영 label spanning its
// 남/여 pair, the '+-' delta columns that must be skipped, a meet whose label
// carries no date, and three cells that are not times ('-', '0.00', 'DQ').

import * as XLSX from 'xlsx'
import { SHEET_MEETS, SHEET_MEMBERS, SHEET_RECORDS } from './parse.ts'

type Row = string[]

/** Places values at given column indexes, leaving '' between them. */
function row(cells: Record<number, string>): Row {
  const indexes = Object.keys(cells).map(Number)
  const out: Row = new Array(Math.max(...indexes) + 1).fill('')
  for (const [c, v] of Object.entries(cells)) out[Number(c)] = v
  return out
}

// ------------------------------------------------------------ ☆명단(출석부)
//
// Columns 0..14 are the scalar member fields, 15+ the attendance grid. The
// month sits on row 3 and the day on row 4, and '1월' is merged across its two
// date columns exactly as the real sheet writes it.
//
// In 2026 all three dated columns are Saturdays, which is what lets a test
// assert that the wrong year produces a warning for each of them.
const MEMBER_ROWS: Row[] = [
  row({ 0: '☆TEST 명단' }),
  row({ 0: '_테스트_', 15: '코칭', 16: '지각', 17: 'V' }),
  row({ 15: '상반기', 17: '하반기' }),
  // '1월' spans c15..c16 (see MEMBER_MERGES); '2월' sits on its own column.
  row({ 15: '1월', 17: '2월' }),
  row({
    0: 'NO',
    1: '이름\n(full)',
    2: '이름',
    3: '가입일',
    4: '가입사유',
    5: '생년월일',
    6: '성별',
    7: '강습',
    8: '수력',
    9: '기타',
    10: '상반기',
    11: '지각',
    12: '하반기',
    13: '지각',
    14: '토탈',
    15: '3일',
    16: '10일',
    17: '7일',
  }),
  // 출석 / 지각 / 출석
  row({
    0: '1',
    1: '테스트일',
    2: '일',
    3: '26.01.02',
    4: '연습',
    5: '900101',
    6: '여',
    7: '상급',
    8: '-',
    10: '2',
    11: '1',
    12: '0',
    13: '0',
    14: '2',
    15: 'O',
    16: 'V',
    17: 'O',
  }),
  // A blank, an 출석, and a '-' — the sheet's 'was not a member yet' marker.
  // Neither the blank nor the dash may become an attendance row.
  row({
    0: '2',
    1: '테스트이',
    2: '이',
    3: '26.01.05',
    4: '대회 참가',
    5: '95',
    6: '남',
    7: '중급',
    8: '2년',
    9: '메모입니다',
    10: '1',
    11: '0',
    12: '0',
    13: '0',
    14: '1',
    16: 'O',
    17: '-',
  }),
  // 'X' is not a mark this sheet defines, so it has to be reported rather than
  // guessed at.
  row({
    0: '3',
    1: '테스트삼',
    2: '삼',
    3: '26.02.01',
    5: '000315',
    6: '여',
    7: '연수',
    10: '1',
    11: '0',
    12: '0',
    13: '0',
    14: '1',
    15: 'O',
    17: 'X',
  }),
  // Numbered but unnamed, like the trailing row 41 of the real sheet. Must not
  // become a member.
  row({ 0: '4' }),
  // The summary row below the roster. Also must not become a member.
  row({ 14: '총 인원', 15: '2' }),
]

const MEMBER_MERGES: XLSX.Range[] = [
  // '1월' spanning its two date columns — the case that leaves c16 with no
  // month at all unless merged blocks are filled.
  { s: { r: 3, c: 15 }, e: { r: 3, c: 16 } },
]

// -------------------------------------------------------------- ☆대회 기록
//
// Two sections, so the 일반 → 'meet' and 핀 → 'fin' mapping is exercised. Each
// section repeats an 11-column block per meet starting at column 11:
//   +0 자유형  +1 +-  +2 배영  +3 +-  +4 평영  +5 +-  +6 접영  +7 +-
//   +8 기타 기록(label)  +9 기타 기록(value)  +10 메모
const BLOCK_HEADER: Record<number, string> = {
  0: 'NO',
  1: '이름\n(full)',
  2: '이름',
  4: '성별',
  5: '자유형',
  7: '자유형',
  8: '배영',
  9: '평영',
  10: '접영',
  11: '자유형',
  12: '+-',
  13: '배영',
  14: '+-',
  15: '평영',
  16: '+-',
  17: '접영',
  18: '+-',
  19: '기타 기록',
  21: '메모',
  22: '자유형',
  23: '+-',
  24: '배영',
  25: '+-',
  26: '평영',
  27: '+-',
  28: '접영',
  29: '+-',
  30: '기타 기록',
  32: '메모',
}

const RECORD_ROWS: Row[] = [
  row({ 0: '☆TEST 대회 기록' }),
  row({ 0: '' }),
  row({ 0: '*50m 기준', 5: '일자', 6: '첫 측정', 7: '개인 최고 기록' }),
  row(BLOCK_HEADER),
  row({ 0: '1) 일반 수영 대회' }),
  row({ 11: '2026년' }),
  // c11 dates itself; c22 does not, and has to be resolved from ☆2026 대회.
  row({
    0: '*50m 기준',
    5: '일자',
    6: '첫 측정',
    7: '개인 최고 기록',
    11: '테스트 대회 (26/03/08)',
    22: '테스트 무일자 대회',
  }),
  row(BLOCK_HEADER),
  // 단체전. '계영' is merged down onto the 여 row beneath it.
  row({ 0: '단\n체\n전', 1: '계영', 4: '남', 6: '-', 11: '1:58.54' }),
  row({ 4: '여' }),
  // 자유형 44.40 and 배영 58.57 at the dated meet, plus a 기타 기록 pair whose
  // label carries its own distance ('자100' → 자유형 100m) and a memo. c12 is a
  // '+-' delta column and must not be read as a result.
  row({
    0: '1',
    1: '테스트일',
    2: '일',
    3: '90',
    4: '여',
    5: '2025',
    6: '44.40',
    11: '44.40',
    12: '1.10',
    13: '58.57',
    19: '자100',
    20: '1:05.32',
    21: '좋았음',
  }),
  // 'DQ' is a real thing a meet sheet says and this schema cannot store, so it
  // must warn. '0.00' is the sheet's own 'no result' filler and must not.
  row({ 0: '2', 1: '테스트이', 2: '이', 3: '95', 4: '남', 11: 'DQ', 13: '0.00' }),
  // Swam only at the undated meet, which is what proves the date lookup ran.
  row({ 0: '3', 1: '테스트삼', 2: '삼', 3: '00', 4: '여', 22: '33.33' }),

  row({ 0: '2) 핀 수영 대회' }),
  row({ 0: '*50m 기준', 5: '일자', 11: '테스트 핀대회 (26/05/17)' }),
  row(BLOCK_HEADER),
  row({ 0: '1', 1: '테스트일', 2: '일', 3: '90', 4: '여', 11: '30.00' }),
]

const RECORD_MERGES: XLSX.Range[] = [
  // '계영' spanning its 남/여 pair — without the fill the 여 row has no relay
  // type and is dropped.
  { s: { r: 8, c: 1 }, e: { r: 9, c: 1 } },
]

// --------------------------------------------------------------- ☆2026 대회
//
// Row 0 only. In the real workbook everything from row 3 down is personal data,
// which is why the parser never looks below row 0 — the fixture keeps the same
// discipline so a test cannot pass on a sheet the parser would refuse to read.
const MEET_ROWS: Row[] = [row({ 0: '테스트 무일자 대회', 3: '대회일자', 4: '7월 19일 (일)' })]

/** The synthetic workbook, as the bytes parseClubWorkbook expects. */
export function buildFixtureWorkbook(): ArrayBuffer {
  const workbook = XLSX.utils.book_new()

  const members = XLSX.utils.aoa_to_sheet(MEMBER_ROWS)
  members['!merges'] = MEMBER_MERGES
  XLSX.utils.book_append_sheet(workbook, members, SHEET_MEMBERS)

  const records = XLSX.utils.aoa_to_sheet(RECORD_ROWS)
  records['!merges'] = RECORD_MERGES
  XLSX.utils.book_append_sheet(workbook, records, SHEET_RECORDS)

  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(MEET_ROWS), SHEET_MEETS)

  return XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
}
