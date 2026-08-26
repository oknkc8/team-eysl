import { seoulTodayKey } from '../../lib/seoulDate'

// activity_date is a bare `date` column, so it arrives as 'YYYY-MM-DD' with no
// zone attached. Comparing those strings directly is both correct and cheaper
// than parsing: Date('2026-09-02') is read as UTC midnight, which lands on the
// previous day for anyone west of Greenwich and would file today's training
// under "지난 일정" for them.

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * The club's calendar day as 'YYYY-MM-DD'.
 *
 * Seoul, not the device. Every activity_date is a bare `date` entered in Seoul
 * terms and the server takes its own year there (0034), so a member reading this
 * from another timezone would otherwise file today's training under 지난 일정 and
 * lose the 신청 button on an activity that has not started.
 */
export function todayKey(now: Date = new Date()): string {
  return seoulTodayKey(now)
}

/** An activity, as far as any date question in this app is concerned. */
export type Dated = { activity_date: string; end_date?: string | null }

/**
 * The last day an activity occupies: its end date, or its start when there is
 * none.
 */
export function lastDay(activity: Dated): string {
  const start = activity.activity_date
  const end = activity.end_date
  return end && end > start ? end : start
}

/**
 * Whether the activity is over on `today`. A multi-day activity is not over
 * until its LAST day has passed — on day two of three it is happening.
 *
 * This exists because five screens asked that question as `activity_date <
 * today` while the calendar asked it with the end date, so a three-day 대회
 * appeared on the calendar for all three days and the detail screen treated it
 * as finished on the morning of day two: 신청 and 취소 gone, offers hidden, the
 * member able to see the race and do nothing about it. Putting the end date in
 * the data fixed one of six readers. This is the rule the other five now share.
 */
export function hasFinished(activity: Dated, today: string): boolean {
  if (!activity.activity_date) return false
  return lastDay(activity) < today
}

// Number('a') is NaN rather than undefined, so a length check alone would let
// 'not-a-date' through and produce 'NaN-NaN-NaN'. Both readers below refuse the
// input outright instead of inventing a date from it.
function parseKey(key: string): [number, number, number] | null {
  const [y, m, d] = key.split('-').map(Number)
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null
  return [y as number, m as number, d as number]
}

/** The same key shifted by whole days, used to bound how far back the list reaches. */
export function shiftDays(key: string, days: number): string {
  const parts = parseKey(key)
  if (!parts) return key
  const [y, m, d] = parts
  // Month and day overflow roll over on their own, so 2026-01-05 minus 30 days
  // needs no special casing.
  return todayKey(new Date(y, m - 1, d + days))
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const

/**
 * '2026-09-02' → '2026.09.02 (수)'.
 *
 * The Date is built from local parts rather than parsed from the string, for
 * the reason at the top of this file — a UTC parse can name the wrong weekday.
 */
export function formatDateLabel(key: string): string {
  const parts = parseKey(key)
  if (!parts) return key
  const [y, m, d] = parts
  const weekday = WEEKDAYS[new Date(y, m - 1, d).getDay()] ?? ''
  return `${y}.${pad(m)}.${pad(d)} (${weekday})`
}

/** '19:30:00' + '21:00:00' → '19:30–21:00'. No start time means no time shown. */
export function formatTimeRange(start: string | null, end: string | null): string {
  if (!start) return ''
  const hhmm = (t: string) => t.slice(0, 5)
  return end ? `${hhmm(start)}–${hhmm(end)}` : hhmm(start)
}

type Sortable = Dated & { start_time: string | null }

// A `time` column sorts lexicographically too, and an activity with no start
// time is treated as the beginning of its day rather than dropped to the end.
const sortKey = (row: Sortable) => `${row.activity_date}T${row.start_time ?? '00:00:00'}`

/**
 * Upcoming activities in ascending order, then past ones most-recent-first.
 *
 * The screen exists to answer "무엇을 신청하지?", so the nearest upcoming date
 * belongs at the top. Past activities stay reachable underneath rather than
 * being filtered away, since nothing else in the app lists them for a member.
 */
export function sortUpcomingFirst<T extends Sortable>(rows: readonly T[], today: string): T[] {
  const upcoming: T[] = []
  const past: T[] = []
  // hasFinished, not `activity_date >= today`: a three-day 대회 on its second day
  // is happening, and filing it under 지난 일정 is the same defect the detail
  // screen had. This one was not on the review list; it is the sixth reader.
  for (const row of rows) (hasFinished(row, today) ? past : upcoming).push(row)

  upcoming.sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
  past.sort((a, b) => sortKey(b).localeCompare(sortKey(a)))
  return [...upcoming, ...past]
}
