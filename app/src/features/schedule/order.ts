// activity_date is a bare `date` column, so it arrives as 'YYYY-MM-DD' with no
// zone attached. Comparing those strings directly is both correct and cheaper
// than parsing: Date('2026-09-02') is read as UTC midnight, which lands on the
// previous day for anyone west of Greenwich and would file today's training
// under "지난 일정" for them.

/** Local calendar day as 'YYYY-MM-DD' — what a member means by "today". */
export function todayKey(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** The same key shifted by whole days, used to bound how far back the list reaches. */
export function shiftDays(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number)
  if (y === undefined || m === undefined || d === undefined) return key
  // Month and day overflow roll over on their own, so 2026-01-05 minus 30 days
  // needs no special casing.
  return todayKey(new Date(y, m - 1, d + days))
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
