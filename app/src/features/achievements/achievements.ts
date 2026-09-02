// 나의 성과 — the badge ladder, the PB 모먼트 feed, and the 월간 활동 요약.
//
// The ladder lives here rather than in the database on purpose: his client
// carries it too (attendanceBadgeDefs, upstream:2144-2150), and 0034 returns
// only the count. That split is what lets a message be retuned without a
// migration, and it keeps the server from having an opinion about copy.
//
// Narrowing follows rankings.ts and splits tolerance the same way:
//   * A missing or non-array LIST is read as empty. A member with no PB yet is
//     a real state — the screen has its own sentence for it — so treating the
//     absence as a failure would put an error in front of somebody whose only
//     problem is that they have not raced yet.
//   * A missing `year` (or `month`) is NOT tolerated. Every heading interpolates
//     it and the server always sends it, so a payload without one is a broken
//     contract, and "undefined년 누적 3회" is worse than an error state.

import { viewerKey } from '../../lib/queryKeys'

export type BadgeDef = { count: number; title: string; message: string }

/** His five tiers and his exact copy (upstream:2144-2150), in order. */
export const ATTENDANCE_BADGES: readonly BadgeDef[] = [
  { count: 5, title: '5회', message: '팀아이슬, 이제 익숙해졌죠?' },
  { count: 10, title: '10회', message: '이제 나는 아이슬과 한 몸!' },
  { count: 15, title: '15회', message: '당신, 재능있어 계속해!' },
  { count: 20, title: '20회', message: '오 좀 치네?' },
  { count: 25, title: '25회', message: '아이슬 포세이돈' },
] as const

/**
 * final73-badge-reveal is this one string. Before it every message was visible;
 * after it a locked tier hides its copy, so part of the reward for turning up is
 * finding out what it says.
 */
export const LOCKED_MESSAGE = '달성하면 공개!'

export type PbMoment = {
  stroke: string
  distance: number
  event_date: string
  event_name: string
  /** Seconds, not centiseconds — 0034 divides before it serialises. */
  old_pb: number
  new_pb: number
  improvement: number
}

export type Achievement = {
  year: number
  attendance_count: number
  pb_moments: PbMoment[]
}

export type MonthlyActivity = {
  year: number
  month: number
  training_count: number
  race_count: number
  other_count: number
  attendance_marked: number
  attendance_present: number
  attendance_rate: number
}

export class AchievementContractError extends Error {}

// ----------------------------------------------------------------- cache keys
//
// The member id belongs in the key, not in the fetch alone. Both RPCs derive the
// caller from the session and take no member id, so two members' payloads are
// indistinguishable once cached — same key, same entry, and the second member
// reads the first one's badges. SessionProvider also clears the cache on an
// identity change; this is the half that does not depend on remembering to.

export function achievementQueryKey(userId: string | undefined) {
  return viewerKey(['my-achievement'], userId)
}

// The month is part of what invalidation targets — AdminCheckInPage sends the
// bare ['my-monthly-activity'] — so the month sits in the prefix and the viewer
// after it.
export function monthlyActivityQueryKey(
  userId: string | undefined,
  year: number,
  month: number,
) {
  return viewerKey(['my-monthly-activity', year, month], userId)
}

// ------------------------------------------------------------------ narrowing

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Shared by both payloads: the server answers a refusal as data, not an error. */
function refuseErrorPayload(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new AchievementContractError('응답이 객체가 아닙니다')
  if (typeof value.error === 'string') throw new AchievementContractError(value.error)
  return value
}

function requireNumber(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new AchievementContractError(message)
  return value
}

function pbMoments(value: unknown): PbMoment[] {
  return asArray(value)
    .filter(isRecord)
    .map((row) => ({
      stroke: asString(row.stroke),
      distance: asNumber(row.distance),
      event_date: asString(row.event_date),
      event_name: asString(row.event_name),
      old_pb: asNumber(row.old_pb),
      new_pb: asNumber(row.new_pb),
      improvement: asNumber(row.improvement),
    }))
}

export function parseAchievement(value: unknown): Achievement {
  const source = refuseErrorPayload(value)
  return {
    year: requireNumber(source.year, '성과 응답에 연도가 없습니다'),
    attendance_count: asNumber(source.attendance_count),
    pb_moments: pbMoments(source.pb_moments),
  }
}

export function parseMonthlyActivity(value: unknown): MonthlyActivity {
  const source = refuseErrorPayload(value)
  return {
    year: requireNumber(source.year, '월간 요약 응답에 연도가 없습니다'),
    month: requireNumber(source.month, '월간 요약 응답에 월이 없습니다'),
    training_count: asNumber(source.training_count),
    race_count: asNumber(source.race_count),
    other_count: asNumber(source.other_count),
    attendance_marked: asNumber(source.attendance_marked),
    attendance_present: asNumber(source.attendance_present),
    attendance_rate: asNumber(source.attendance_rate),
  }
}

// --------------------------------------------------------------------- badges

/** True once the member has reached this tier. */
export function isBadgeUnlocked(count: number, badge: BadgeDef): boolean {
  return count >= badge.count
}

/**
 * The copy a tier shows. Locked tiers withhold theirs — that is the whole of
 * final73-badge-reveal, and it is a function rather than a ternary at the call
 * site so the reveal rule is stated in exactly one place.
 */
export function badgeMessage(count: number, badge: BadgeDef): string {
  return isBadgeUnlocked(count, badge) ? badge.message : LOCKED_MESSAGE
}

/** The next tier still to earn, or undefined once all five are done. */
export function nextBadge(count: number): BadgeDef | undefined {
  return ATTENDANCE_BADGES.find((badge) => count < badge.count)
}

/** His progress line (upstream:2179), including the finished case. */
export function badgeProgressLabel(count: number): string {
  const next = nextBadge(count)
  if (!next) return '25회 배지까지 모두 달성!'
  return `다음 배지 ${next.count}회까지 ${next.count - count}회 남음`
}

/** `${y}년 누적 ${count}회` — the meta line beside the heading (upstream:2178). */
export function badgeYearLabel(year: number, count: number): string {
  return `${year}년 누적 ${count}회`
}

// ------------------------------------------------------------------ PB 모먼트

/** His eight congratulation lines (upstream:2151-2160), in order. */
export const PB_CONGRATS: readonly string[] = [
  '또 한 번 빨라졌다 🔥',
  '오늘의 내가 어제의 나를 이김.',
  'PB 업데이트 완료. 다음 벽은 어디?',
  '기록은 거짓말 안 한다 😎',
  '또 벽 하나 깼다!',
  '수영장에 기록 하나 두고 갑니다 🏊',
  '조금씩, 그런데 확실하게 빨라지는 중!',
  '이 기록, 꽤 마음에 드는데? 😏',
] as const

/**
 * A congratulation picked from the moment itself rather than at random, ported
 * from his stablePbMessage (upstream:2161-2165) including the arithmetic.
 *
 * Stability is the point and it is not cosmetic: this list re-renders on every
 * refetch, so Math.random() would reshuffle the messages each time the screen
 * woke up and a card the member had already read would say something else.
 * Keying off (stroke, date, time) means the same swim always draws the same
 * line, and two different swims almost always draw different ones.
 */
export function stablePbMessage(moment: Pick<PbMoment, 'stroke' | 'event_date' | 'new_pb'>): string {
  const key = `${moment.stroke || ''}${moment.event_date || ''}${moment.new_pb || ''}`
  let n = 0
  for (let i = 0; i < key.length; i += 1) n = (n + key.charCodeAt(i) * (i + 1)) % 100000
  // PB_CONGRATS is a non-empty literal, so the modulo always lands on a string.
  return PB_CONGRATS[n % PB_CONGRATS.length]!
}

/** `37.41`, matching his `Number(x).toFixed(2)`. */
export function formatPb(seconds: number): string {
  return seconds.toFixed(2)
}

/**
 * `자유형 50M`. His card prints the stroke alone (upstream:2183), which renders
 * two genuine moments in one stroke as what looks like a duplicated row. 0034
 * sends the distance for exactly this.
 */
export function momentEventLabel(moment: Pick<PbMoment, 'stroke' | 'distance'>): string {
  return moment.distance > 0 ? `${moment.stroke} ${moment.distance}M` : moment.stroke
}

// ------------------------------------------------------------------ 월간 요약

// seoulYearMonth used to live here. It moved to lib/seoulDate.ts once the
// calendar needed the same answer and reproduced the same device-clock bug a
// few files away — re-exported so this feature's imports stay put.
export { seoulYearMonth } from '../../lib/seoulDate'

/** `2026년 3월` — the label between the two arrows. */
export function formatMonthLabel(year: number, month: number): string {
  return `${year}년 ${month}월`
}

/**
 * Stepping a month, carrying into the next or previous year.
 *
 * His changeSummaryMonth clamps to 1..12 inside the current year
 * (upstream:3511), so tapping ‹ in January does nothing and last December is
 * unreachable. Carrying is the same gesture without the wall, and 0034 already
 * accepts any year.
 */
export function stepMonth(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  const zeroBased = month - 1 + delta
  return {
    year: year + Math.floor(zeroBased / 12),
    month: (((zeroBased % 12) + 12) % 12) + 1,
  }
}

/**
 * Whether the month has nothing to report. His sentence switches on the three
 * participation counts and ignores 출석률 (upstream:3512), which is right: a
 * month can carry attendance marks for activities the member did not take part
 * in, and calling that "활동 내역" would be a lie.
 */
export function isMonthEmpty(summary: MonthlyActivity): boolean {
  return summary.training_count + summary.race_count + summary.other_count === 0
}

/** His closing sentence (upstream:3512), both branches. */
export function monthlySentence(summary: MonthlyActivity): string {
  if (isMonthEmpty(summary)) return '이번 달 등록된 활동 내역이 없습니다.'
  return `${summary.month}월에는 훈련 ${summary.training_count}회, 대회 ${summary.race_count}회, 기타 ${summary.other_count}회에 참여했어요.`
}
