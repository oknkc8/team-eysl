// Rows from race_my_history_v1(), and the precedence rule that decides which
// one survives when the same meet arrives twice.
//
// The president's app merges two lists in the browser: applications it built
// from activity_applications, and rows from his RPC. Ours does the merge on the
// server, so a screen makes one call instead of two. What could not move to the
// server is the RULE, because it is his and worth keeping identical: dedupe on
// `title|date`, and let a live application win over a backfilled history row
// for the same meet (renderMyStatusList, upstream-index.html:2741 — he
// concatenates `current` before `hist` and keeps the first of each key).
//
// Today our RPC only ever emits source='application', so this dedupe is a no-op
// in practice. It is written and tested now anyway: the day a historical
// backfill exists, the overlap appears on the same screen, and a rule
// discovered then would be a rule guessed twice.

export type RaceHistoryRow = {
  title: string
  activity_date: string
  status: string
  source: string
}

// Lower wins. An unrecognised source sorts last rather than being dropped: a
// row we cannot classify is still a race this member swam.
const SOURCE_PRECEDENCE: Record<string, number> = { application: 0, history: 1 }

function precedence(row: RaceHistoryRow): number {
  return SOURCE_PRECEDENCE[row.source] ?? 2
}

/** `${title}|${activity_date}` — the president's key, kept verbatim. */
function key(row: RaceHistoryRow): string {
  return `${row.title}|${row.activity_date}`
}

/**
 * One row per meet, newest first.
 *
 * Sort is stable in every engine this app runs on, so rows sharing a source
 * keep the order the server sent them in — which is already date-descending.
 */
export function dedupeRaceHistory(rows: RaceHistoryRow[]): RaceHistoryRow[] {
  const byPrecedence = [...rows].sort((a, b) => precedence(a) - precedence(b))

  const seen = new Set<string>()
  const kept: RaceHistoryRow[] = []
  for (const row of byPrecedence) {
    if (seen.has(key(row))) continue
    seen.add(key(row))
    kept.push(row)
  }

  return kept.sort((a, b) => b.activity_date.localeCompare(a.activity_date))
}

/**
 * Whether a row is over. Read off the status the server computed rather than
 * recomputed here: the server decides in Asia/Seoul, and a member travelling
 * would otherwise see a race flip to 종료 a day early or late.
 */
export function isFinished(row: RaceHistoryRow): boolean {
  return row.status === '종료'
}

export function isWaiting(row: RaceHistoryRow): boolean {
  return row.status === '대기'
}
