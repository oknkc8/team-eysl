// The month grid behind 일정 캘린더, and the date-range arithmetic a multi-day
// activity needs.
//
// Same discipline as order.ts, for the same reason: a date key is compared as a
// string and only ever turned into a Date from its parts. `new Date('2026-09-02')`
// is parsed as UTC midnight, which is the previous day for anyone west of
// Greenwich — and a calendar that files a race under the wrong square is exactly
// the kind of wrong that looks fine.

import { shiftDays } from './order'

const pad = (n: number) => String(n).padStart(2, '0')

/** 'YYYY-MM' for a month, which is also the prefix every date key in it shares. */
export function monthPrefix(year: number, month: number): string {
  return `${year}-${pad(month)}`
}

/**
 * The last date key of a month, 'YYYY-MM-DD'.
 *
 * Day 0 of the next month is the last day of this one — the one piece of Date
 * arithmetic here that string comparison cannot do, because February's length
 * depends on the year.
 */
export function lastDayOfMonth(year: number, month: number): string {
  return `${monthPrefix(year, month)}-${pad(new Date(year, month, 0).getDate())}`
}

/** '2026년 3월', the label between the two arrows. */
export function formatMonthTitle(year: number, month: number): string {
  return `${year}년 ${month}월`
}

/**
 * Stepping a month, carrying across the year boundary in both directions.
 *
 * His calendar does the same by mutating a Date (`currentMonth`), which works
 * but leaves the day-of-month in play: stepping from 31 January lands on 2 or 3
 * March depending on the year, because there is no 31 February. Working in
 * (year, month) integers has no such edge.
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

/** A grid slot: a real day, or a blank that pads the first week. */
export type CalendarCell = { key: string; day: number } | null

/**
 * Leading blanks then one cell per day, matching his grid exactly
 * (`new Date(y,m,1).getDay()` blanks, then 1..last).
 *
 * The week starts on Sunday because his does, and because that is what a Korean
 * wall calendar does. Nothing here depends on it beyond the blank count.
 */
export function monthGrid(year: number, month: number): CalendarCell[] {
  const leading = new Date(year, month - 1, 1).getDay()
  // Day 0 of the next month is the last day of this one.
  const days = new Date(year, month, 0).getDate()

  const cells: CalendarCell[] = Array.from({ length: leading }, () => null)
  for (let day = 1; day <= days; day += 1) {
    cells.push({ key: `${monthPrefix(year, month)}-${pad(day)}`, day })
  }
  return cells
}

/**
 * The most days one activity may occupy.
 *
 * The migration's CHECK guarantees end >= start, so a range cannot run
 * backwards, but nothing stops somebody typing 2099 into the end field. This
 * bound protects the render loop rather than the data: an unbounded `while`
 * building twenty-seven thousand keys inside a component is a frozen tab, and no
 * swim meet in this club runs for a year.
 */
export const MAX_SPAN_DAYS = 366

/**
 * Every date key an activity occupies, inclusive of both ends.
 *
 * A null or empty end means a single day, which is the overwhelming majority of
 * rows — his reader defaults the same way (`d.endDate || row.activity_date`,
 * upstream:1503). An end BEFORE the start is also read as a single day rather
 * than as an empty range: such a row is malformed, and dropping it off the
 * calendar entirely would hide an activity that exists.
 */
export function datesInRange(start: string, end: string | null | undefined): string[] {
  if (!start) return []
  if (!end || end <= start) return [start]

  const keys: string[] = []
  let cursor = start
  while (cursor <= end && keys.length < MAX_SPAN_DAYS) {
    keys.push(cursor)
    cursor = shiftDays(cursor, 1)
  }
  return keys
}

/** Whether an activity covers a day — his dateInActivityRange (upstream:3166). */
export function coversDate(
  activity: { activity_date: string; end_date?: string | null },
  key: string,
): boolean {
  const start = activity.activity_date
  if (!start) return false
  const end = activity.end_date && activity.end_date > start ? activity.end_date : start
  return key >= start && key <= end
}

/** True when the activity runs over more than one day. */
export function isMultiDay(activity: {
  activity_date: string
  end_date?: string | null
}): boolean {
  return !!activity.end_date && activity.end_date > activity.activity_date
}

/**
 * '2026.03.02 (월) ~ 2026.03.04 (수)' for a range, the single date otherwise.
 *
 * Takes the formatter rather than importing one, so a date reads the same here
 * as on the detail page and in the list — three spellings of one date across
 * three screens is how a member ends up unsure whether they are looking at the
 * same event.
 */
export function formatDateRange(
  start: string,
  end: string | null | undefined,
  formatDate: (key: string) => string,
): string {
  if (!end || end <= start) return formatDate(start)
  return `${formatDate(start)} ~ ${formatDate(end)}`
}
