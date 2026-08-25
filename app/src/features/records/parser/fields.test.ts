import { describe, expect, it } from 'vitest'
import {
  detectDistance,
  detectRelayType,
  detectStroke,
  genericNamesFromCells,
  inferMeetName,
  normResultText,
  normalizedKey,
  parseResultDate,
} from './fields'

// Unit cover for the heuristics the sheet walk is built out of. These are the
// pieces most likely to be "improved" by someone who has not seen the sheets
// they were tuned against, so what each one refuses is asserted as carefully as
// what it accepts.

describe('normResultText', () => {
  it('collapses the whitespace a spreadsheet cell arrives with', () => {
    expect(normResultText('  김철수\n\t ')).toBe('김철수')
    expect(normResultText('자유형   50m')).toBe('자유형 50m')
  })

  it('reads an empty cell as an empty string, not as "null"', () => {
    expect(normResultText(null)).toBe('')
    expect(normResultText(undefined)).toBe('')
    expect(normResultText(0)).toBe('0')
  })
})

describe('normalizedKey', () => {
  it('sees through the punctuation a header hides behind', () => {
    expect(normalizedKey(' 소 속 (팀) ')).toBe('소속팀')
    expect(normalizedKey('Result_Time')).toBe('resulttime')
  })
})

describe('parseResultDate', () => {
  it('reads the spellings a Korean sheet writes a date in', () => {
    expect(parseResultDate('일시: 2026.05.17')).toBe('2026-05-17')
    expect(parseResultDate('2026년 5월 17일')).toBe('2026-05-17')
    expect(parseResultDate('2026-5-7 예선')).toBe('2026-05-07')
  })

  it('reads the run-together date a file name carries', () => {
    expect(parseResultDate('TalkFile_20260517.xlsx')).toBe('2026-05-17')
  })

  it('falls back rather than inventing a date', () => {
    expect(parseResultDate('대회 결과', '2026-01-01')).toBe('2026-01-01')
  })
})

describe('detectStroke', () => {
  it('names the four strokes, in Korean or English', () => {
    expect(detectStroke('자유형 50m')).toBe('자유형')
    expect(detectStroke('50m Backstroke')).toBe('배영')
    expect(detectStroke('평영 100')).toBe('평영')
    expect(detectStroke('Butterfly')).toBe('접영')
  })

  it("returns '' for a row that names no event", () => {
    // The caller treats '' as "do not file this row" — the whole reason a
    // stroke-less row is skipped rather than guessed at.
    expect(detectStroke('1 김철수 EYSL 27.31')).toBe('')
  })
})

describe('detectDistance', () => {
  it('reads a pool distance out of an event title', () => {
    expect(detectDistance('자유형 50m')).toBe(50)
    expect(detectDistance('1500 미터 자유형')).toBe(1500)
    expect(detectDistance('200M 혼계영')).toBe(200)
  })

  it('refuses a number that is not a pool distance', () => {
    // 75 is not a distance anyone swims, and a lane or a rank is not a distance
    // at all. Accepting either would send the time through the wrong
    // plausibility window and file a swim nobody swam.
    expect(detectDistance('자유형 75m')).toBeNull()
    expect(detectDistance('레인 3')).toBeNull()
    expect(detectDistance('27.31')).toBeNull()
  })

  it('does not find a distance inside a longer number', () => {
    expect(detectDistance('150')).toBeNull()
    expect(detectDistance('2026.05.17')).toBeNull()
  })
})

describe('detectRelayType', () => {
  it('takes the longest label that fits', () => {
    // Order matters: every one of these contains 계영 as a substring.
    expect(detectRelayType('혼성혼계영 200m')).toBe('혼성혼계영')
    expect(detectRelayType('혼성계영 200m')).toBe('혼성계영')
    expect(detectRelayType('혼계영 200m')).toBe('혼계영')
    expect(detectRelayType('계영 400m')).toBe('계영')
  })

  it("returns '' for an individual event", () => {
    expect(detectRelayType('자유형 50m')).toBe('')
  })
})

describe('inferMeetName', () => {
  it('prefers the file name, cleaned of what messaging apps add', () => {
    expect(inferMeetName('', 'TalkFile_2026 한강배(결과집계).xlsx')).toBe('2026 한강배')
    expect(inferMeetName('', '2026 한강배 수영대회 결과지.xlsx')).toBe('2026 한강배 수영대회')
  })

  it('falls back to a line of the sheet that reads like a title', () => {
    expect(inferMeetName('제5회 한강배 수영대회  일시 2026.05.17', 'a.xlsx')).toBe(
      '제5회 한강배 수영대회',
    )
  })

  it('falls back to the sheet name, then to a generic label', () => {
    expect(inferMeetName('기록 모음', 'a.xlsx', '5월 결과')).toBe('5월 결과')
    expect(inferMeetName('', 'a.xlsx')).toBe('수영대회')
  })
})

describe('genericNamesFromCells', () => {
  it('picks out cells shaped like a Korean name, once each', () => {
    expect(genericNamesFromCells(['김철수', '이영희', '김철수'])).toEqual(['김철수', '이영희'])
  })

  it('drops division words that have the same shape', () => {
    expect(genericNamesFromCells(['성인', '남자', '일반', '계영', '박서준'])).toEqual(['박서준'])
  })

  it('drops anything that is not two to four syllables of Hangul', () => {
    expect(genericNamesFromCells(['EYSL', '27.31', '김', '가나다라마', '김 철수'])).toEqual([])
  })

  it('also picks up two-syllable column headings — a ported wart', () => {
    // 순위, 소속 and 기록 are not in the blacklist, so a relay block's
    // teammates list carries its own headings. Locked in here so a cleanup
    // pass has to change it on purpose. See the note in matrix.ts.
    expect(genericNamesFromCells(['순위', '소속', '기록'])).toEqual(['순위', '소속', '기록'])
  })
})
