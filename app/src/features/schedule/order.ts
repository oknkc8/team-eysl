// activity_date is a bare `date` column, so it arrives as 'YYYY-MM-DD' with no
// zone attached. Comparing those strings directly is both correct and cheaper
// than parsing: Date('2026-09-02') is read as UTC midnight, which lands on the
// previous day for anyone west of Greenwich and would file today's training
// under "지난 일정" for them.

const pad = (n: number) => String(n).padStart(2, '0')

/** Local calendar day as 'YYYY-MM-DD' — what a member means by "today". */
export function todayKey(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
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

type Dated = { activity_date: string; start_time: string | null }

// A `time` column sorts lexicographically too, and an activity with no start
// time is treated as the beginning of its day rather than dropped to the end.
const sortKey = (row: Dated) => `${row.activity_date}T${row.start_time ?? '00:00:00'}`

/**
 * Upcoming activities in ascending order, then past ones most-recent-first.
 *
 * The screen exists to answer "무엇을 신청하지?", so the nearest upcoming date
 * belongs at the top. Past activities stay reachable underneath rather than
 * being filtered away, since nothing else in the app lists them for a member.
 */
export function sortUpcomingFirst<T extends Dated>(rows: readonly T[], today: string): T[] {
  const upcoming: T[] = []
  const past: T[] = []
  for (const row of rows) (row.activity_date >= today ? upcoming : past).push(row)

  upcoming.sort((a, b) => sortKey(a).localeCompare(sortKey(b)))
  past.sort((a, b) => sortKey(b).localeCompare(sortKey(a)))
  return [...upcoming, ...past]
}
