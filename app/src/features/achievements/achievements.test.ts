import { describe, it, expect } from 'vitest'
import {
  ATTENDANCE_BADGES,
  AchievementContractError,
  LOCKED_MESSAGE,
  PB_CONGRATS,
  badgeMessage,
  badgeProgressLabel,
  badgeYearLabel,
  formatMonthLabel,
  formatPb,
  isBadgeUnlocked,
  isMonthEmpty,
  momentEventLabel,
  monthlySentence,
  nextBadge,
  parseAchievement,
  parseMonthlyActivity,
  stablePbMessage,
  stepMonth,
  type MonthlyActivity,
} from './achievements'

// The payloads below are the shapes my_achievement_v1 and my_monthly_activity_v1
// actually returned against the dev database, with the club's real nicknames and
// meet names replaced — this repository is public.

/**
 * A member on 13, made of 11 출석 and 2 지각. The split matters: 13 crosses the
 * 10회 tier ONLY because 지각 counts, which is 0034's rule and the one a reader
 * is most likely to assume works the other way.
 */
const THIRTEEN = {
  year: 2026,
  attendance_count: 13,
  pb_moments: [
    {
      stroke: '자유형',
      distance: 50,
      event_date: '2026-07-19',
      event_name: '여름 대회',
      old_pb: 37.72,
      new_pb: 37.41,
      improvement: 0.31,
    },
    {
      stroke: '접영',
      distance: 50,
      event_date: '2026-07-19',
      event_name: '여름 대회',
      old_pb: 42.56,
      new_pb: 38.26,
      improvement: 4.3,
    },
  ],
}

/** A member who has never been marked and has never raced. */
const NOBODY = { year: 2026, attendance_count: 0, pb_moments: [] }

/** A member whose only marks are 지각 — three of them, so still short of 5회. */
const LATE_ONLY = { year: 2026, attendance_count: 3, pb_moments: [] }

describe('parseAchievement', () => {
  it('reads a full payload', () => {
    const data = parseAchievement(THIRTEEN)
    expect(data.year).toBe(2026)
    expect(data.attendance_count).toBe(13)
    expect(data.pb_moments).toHaveLength(2)
    expect(data.pb_moments[0]!.improvement).toBe(0.31)
  })

  // The server answers a caller who is not an approved member with a payload
  // rather than raising, so a successful response can still be a refusal.
  it('treats an error payload as a failure', () => {
    expect(() => parseAchievement({ error: 'unauthorized' })).toThrow(AchievementContractError)
  })

  it('refuses a payload with no year, because the heading interpolates it', () => {
    expect(() => parseAchievement({ attendance_count: 3 })).toThrow(AchievementContractError)
    expect(() => parseAchievement({ year: '2026' })).toThrow(AchievementContractError)
  })

  it('refuses a non-object', () => {
    expect(() => parseAchievement(null)).toThrow(AchievementContractError)
    expect(() => parseAchievement([])).toThrow(AchievementContractError)
  })

  // Having raced nothing yet is a real state with its own sentence on screen,
  // never an error.
  it('reads a missing moment list as empty rather than failing', () => {
    expect(parseAchievement({ year: 2026 }).pb_moments).toEqual([])
    expect(parseAchievement({ year: 2026, pb_moments: 'nope' }).pb_moments).toEqual([])
  })

  it('keeps a fractional improvement intact', () => {
    const data = parseAchievement({
      year: 2026,
      pb_moments: [
        { stroke: '평영', distance: 50, old_pb: 52.39, new_pb: 48.07, improvement: 4.32 },
      ],
    })
    expect(data.pb_moments[0]!.improvement).toBe(4.32)
  })
})

describe('출석 배지', () => {
  it('unlocks every tier at or below the count', () => {
    const count = parseAchievement(THIRTEEN).attendance_count
    expect(ATTENDANCE_BADGES.map((badge) => isBadgeUnlocked(count, badge))).toEqual([
      true, // 5
      true, // 10 — reached only because the two 지각 marks counted
      false, // 15
      false, // 20
      false, // 25
    ])
  })

  // A member who has never been marked. Every tier locked, and the progress line
  // still has to name the first one rather than reading as "all done".
  it('locks everything for a member with zero attendance', () => {
    const count = parseAchievement(NOBODY).attendance_count
    expect(ATTENDANCE_BADGES.every((badge) => !isBadgeUnlocked(count, badge))).toBe(true)
    expect(badgeProgressLabel(count)).toBe('다음 배지 5회까지 5회 남음')
    expect(badgeYearLabel(2026, count)).toBe('2026년 누적 0회')
  })

  // 지각 counts toward the badge (0034, matching 0016:86-88): somebody who
  // turned up late still turned up. Three late marks are three counts — short of
  // the first tier, but counted rather than discarded.
  it('counts a 지각-only member toward the ladder', () => {
    const count = parseAchievement(LATE_ONLY).attendance_count
    expect(count).toBe(3)
    expect(badgeProgressLabel(count)).toBe('다음 배지 5회까지 2회 남음')
  })

  it('names the next tier and the gap to it', () => {
    expect(nextBadge(13)?.count).toBe(15)
    expect(badgeProgressLabel(13)).toBe('다음 배지 15회까지 2회 남음')
  })

  // Exactly on a threshold is unlocked, not "one more to go".
  it('treats the threshold itself as reached', () => {
    expect(isBadgeUnlocked(5, ATTENDANCE_BADGES[0]!)).toBe(true)
    expect(badgeProgressLabel(5)).toBe('다음 배지 10회까지 5회 남음')
  })

  it('has no next tier once all five are done', () => {
    expect(nextBadge(25)).toBeUndefined()
    expect(nextBadge(400)).toBeUndefined()
    expect(badgeProgressLabel(25)).toBe('25회 배지까지 모두 달성!')
    expect(badgeProgressLabel(400)).toBe('25회 배지까지 모두 달성!')
  })

  // final73-badge-reveal: a locked tier withholds its copy. Getting this
  // backwards would spoil every message the member has not earned yet.
  it('hides a locked tier message and shows an unlocked one', () => {
    const fifth = ATTENDANCE_BADGES[4]!
    expect(badgeMessage(13, fifth)).toBe(LOCKED_MESSAGE)
    expect(badgeMessage(25, fifth)).toBe('아이슬 포세이돈')
  })
})

describe('stablePbMessage', () => {
  const moment = { stroke: '자유형', event_date: '2026-07-19', new_pb: 37.41 }

  // The whole point: this list re-renders on every refetch, and a message that
  // changed each time would rewrite a card the member had already read.
  it('gives the same swim the same line every time', () => {
    expect(stablePbMessage(moment)).toBe(stablePbMessage(moment))
    expect(stablePbMessage({ ...moment })).toBe(stablePbMessage(moment))
  })

  it('always lands inside his eight lines', () => {
    expect(PB_CONGRATS).toContain(stablePbMessage(moment))
    expect(PB_CONGRATS).toContain(stablePbMessage({ stroke: '', event_date: '', new_pb: 0 }))
  })

  it('separates two different swims', () => {
    const other = { stroke: '접영', event_date: '2026-03-08', new_pb: 42.56 }
    expect(stablePbMessage(other)).not.toBe(stablePbMessage(moment))
  })
})

describe('PB 모먼트 formatting', () => {
  it('always shows two decimals, matching his toFixed(2)', () => {
    expect(formatPb(37.41)).toBe('37.41')
    expect(formatPb(4.3)).toBe('4.30')
    expect(formatPb(38)).toBe('38.00')
  })

  // His card prints the stroke alone, so a 50 and a 100 in one stroke look like
  // the same row twice. The distance is what tells them apart.
  it('names the distance beside the stroke', () => {
    expect(momentEventLabel({ stroke: '자유형', distance: 50 })).toBe('자유형 50M')
    expect(momentEventLabel({ stroke: '자유형', distance: 0 })).toBe('자유형')
  })
})

describe('월간 활동 요약', () => {
  const march: MonthlyActivity = {
    year: 2026,
    month: 3,
    training_count: 3,
    race_count: 1,
    other_count: 0,
    attendance_marked: 3,
    attendance_present: 3,
    attendance_rate: 100,
  }

  it('refuses a payload with no month', () => {
    expect(() => parseMonthlyActivity({ year: 2026 })).toThrow(AchievementContractError)
  })

  it('reads a full payload', () => {
    const data = parseMonthlyActivity(march)
    expect(data.attendance_rate).toBe(100)
    expect(data.training_count).toBe(3)
  })

  it('labels the month', () => {
    expect(formatMonthLabel(2026, 3)).toBe('2026년 3월')
  })

  it('writes his sentence when the month has activity', () => {
    expect(monthlySentence(march)).toBe('3월에는 훈련 3회, 대회 1회, 기타 0회에 참여했어요.')
  })

  it('writes the empty sentence when nothing was attended', () => {
    const empty: MonthlyActivity = { ...march, training_count: 0, race_count: 0, other_count: 0 }
    expect(isMonthEmpty(empty)).toBe(true)
    expect(monthlySentence(empty)).toBe('이번 달 등록된 활동 내역이 없습니다.')
  })

  // Emptiness is decided by participation alone. A month can hold attendance
  // marks for activities the member did not take part in, and calling that
  // "활동 내역" would be a lie — so a nonzero 출석률 must not make it non-empty.
  it('ignores 출석률 when deciding whether the month is empty', () => {
    const marksOnly: MonthlyActivity = {
      ...march,
      training_count: 0,
      race_count: 0,
      other_count: 0,
      attendance_marked: 4,
      attendance_present: 2,
      attendance_rate: 50,
    }
    expect(isMonthEmpty(marksOnly)).toBe(true)
  })
})

describe('stepMonth', () => {
  it('steps within a year', () => {
    expect(stepMonth(2026, 3, 1)).toEqual({ year: 2026, month: 4 })
    expect(stepMonth(2026, 3, -1)).toEqual({ year: 2026, month: 2 })
  })

  // His arrows clamp to 1..12 inside the current year, so last December is
  // unreachable from January. Carrying is the fix, and it has to work in both
  // directions or one end of the range simply moves.
  it('carries across the year boundary in both directions', () => {
    expect(stepMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 })
    expect(stepMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 })
  })

  it('carries more than a year at once', () => {
    expect(stepMonth(2026, 1, -13)).toEqual({ year: 2024, month: 12 })
    expect(stepMonth(2026, 12, 13)).toEqual({ year: 2028, month: 1 })
  })
})
