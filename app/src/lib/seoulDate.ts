/**
 * What day it is for this club.
 *
 * The device clock is the wrong source everywhere in this app. The club is in
 * Seoul, every activity date is a bare `date` column entered in Seoul terms, and
 * the server computes its own year in Asia/Seoul (0034). A member reading the
 * app from the US west coast on 1 September sees 31 August locally — so a
 * device-clock "today" opens the wrong month, files a training happening right
 * now under 지난 일정, and hides the 신청 button on an activity that has not
 * started.
 *
 * This is the second time the defect has been found. `seoulYearMonth` was
 * written inside the achievements feature for the monthly summary, and the
 * calendar then reproduced the same mistake a few files away. It lives here now
 * so the next screen inherits the right answer rather than the nearest one.
 *
 * `en-CA` is used only because it formats as YYYY-MM-DD — the one widely
 * available locale that yields sortable, unambiguous parts without assembling
 * them by hand. Nothing here depends on Canada.
 */
const SEOUL = 'Asia/Seoul'

/** Today in Seoul as 'YYYY-MM-DD', which is what every date column here holds. */
export function seoulTodayKey(now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: SEOUL })
}

/** Today's year and month in Seoul, for a screen that opens on the current month. */
export function seoulYearMonth(now: Date = new Date()): { year: number; month: number } {
  const [year, month] = seoulTodayKey(now).split('-')
  return { year: Number(year), month: Number(month) }
}
