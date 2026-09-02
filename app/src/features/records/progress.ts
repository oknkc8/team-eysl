// The shape a progress chart needs: one line per event, oldest swim first.
//
// Separate from derive.ts because it answers a different question and, for one
// specific reason, groups differently. derive.ts asks "what is this member's
// best, and did this swim improve on the last one" — questions about individual
// rows. A chart asks "how has this event gone over time", which is a question
// about a sequence, and the sequence is what neither personalBests nor
// withDeltas returns.

/**
 * The columns a series is derived from. Structural like derive.ts's Comparable,
 * so a test can pass literals and api.ts stays the only module that knows what
 * a records row really looks like.
 */
export type Swimmable = {
  id: string
  category: string
  subcategory: string
  stroke: string
  distance_m: number
  event_date: string
  created_at: string
  result_centiseconds: number
}

export type SeriesPoint = {
  id: string
  event_date: string
  result_centiseconds: number
  /** Nothing before it in this series was faster. The chart marks these. */
  is_best_so_far: boolean
}

export type ProgressSeries = {
  /**
   * meet / fin / other. Kept out of the stroke key's shadow deliberately: a
   * 핀수영 50m 자유형 is several seconds faster than the same swim off the
   * blocks, so folding the two into one line draws a improvement nobody swam
   * and then a regression at the next meet. derive.ts's eventKey separates them
   * for the same reason.
   */
  category: string
  /** Normalised — see normaliseStroke. */
  stroke: string
  distance_m: number
  /** Oldest first. A chart reads left to right. */
  points: SeriesPoint[]
  /** The fastest point in the series, for the summary line above the chart. */
  best_centiseconds: number
}

/**
 * The four strokes a progress chart draws, in meet-programme order.
 *
 * Matches `stroke_rankings_v1` (0041) rather than derive.ts's STROKE_ORDER,
 * which also carries 개인혼영. 0041 leaves 개인혼영 out because it is not one of
 * the four, and a member comparing this chart against their ranking should not
 * find a fifth line here that the ranking does not have.
 */
const CHARTED_STROKES = ['자유형', '배영', '평영', '접영'] as const

/**
 * `배영(결승)` and `배영(예선)` are 배영.
 *
 * The club workbook carries round suffixes, and `0041:97-107` had to solve this
 * already: it matches the stroke **by prefix** because "an equality test
 * silently drops them". The same reasoning applies here and matters more — on a
 * chart, an equality test would not drop those swims, it would draw them as
 * their own one-point line beside the real one, which reads as a different
 * event rather than as a missing row.
 *
 * derive.ts deliberately does NOT normalise, and that is right for what it does:
 * a delta is only meaningful against a comparable swim, and it treats stroke as
 * the free text it is. Here the question is "how is my 배영 going", and a final
 * swum off the blocks is part of that answer.
 *
 * Returns null for anything outside the four, which is how 개인혼영 and any
 * unrecognised text leave the chart without being silently folded into a stroke
 * they are not.
 */
export function normaliseStroke(stroke: string): string | null {
  return CHARTED_STROKES.find((known) => stroke.startsWith(known)) ?? null
}

// Same tiebreak as derive.ts's compareChronological, and for the same reason:
// created_at defaults to now(), which is the transaction start, so an upload
// writing a whole meet stamps every row identically. Without the id the two
// swims of one event swap places between refetches — and on a chart that swaps
// which point owns the "best so far" marker.
const chronological = (a: Swimmable, b: Swimmable) =>
  a.event_date.localeCompare(b.event_date) ||
  a.created_at.localeCompare(b.created_at) ||
  a.id.localeCompare(b.id)

const rank = (stroke: string) => (CHARTED_STROKES as readonly string[]).indexOf(stroke)

// meet first: it is the one every member has, and the one the rankings screens
// are built from. An unrecognised category sorts last rather than crashing.
const CATEGORY_ORDER = ['meet', 'fin', 'other'] as const
const categoryRank = (category: string) => {
  const i = (CATEGORY_ORDER as readonly string[]).indexOf(category)
  return i === -1 ? CATEGORY_ORDER.length : i
}

/**
 * One series per stroke and distance, oldest swim first.
 *
 * Personal swims only — a relay leg starts from a flying push, so it is not
 * comparable to the same distance swum off the blocks. Fins are excluded a
 * different way: `category` is part of the group key, so a 핀수영 swim gets its
 * own line rather than being dropped. The swimmer did swim it; it just is not
 * the same event.
 *
 * A single swim still returns a series. It cannot show a trend, but it is the
 * honest state of that event, and dropping it would make an event vanish from
 * the screen the moment a member has exactly one of them.
 */
export function progressSeries(records: readonly Swimmable[]): ProgressSeries[] {
  const groups = new Map<
    string,
    { category: string; stroke: string; distance_m: number; rows: Swimmable[] }
  >()

  for (const record of records) {
    if (record.subcategory !== 'personal') continue
    const stroke = normaliseStroke(record.stroke)
    if (stroke === null) continue

    const key = `${record.category}|${stroke}|${record.distance_m}`
    const group = groups.get(key)
    if (group) group.rows.push(record)
    else
      groups.set(key, {
        category: record.category,
        stroke,
        distance_m: record.distance_m,
        rows: [record],
      })
  }

  const series: ProgressSeries[] = []

  for (const group of groups.values()) {
    const rows = [...group.rows].sort(chronological)
    let best = Number.POSITIVE_INFINITY
    const points: SeriesPoint[] = []

    for (const row of rows) {
      // Strictly faster, so the earliest swim keeps the marker when two match —
      // the same rule personalBests uses to decide who owns a tied best.
      const improved = row.result_centiseconds < best
      if (improved) best = row.result_centiseconds
      points.push({
        id: row.id,
        event_date: row.event_date,
        result_centiseconds: row.result_centiseconds,
        is_best_so_far: improved,
      })
    }

    series.push({
      category: group.category,
      stroke: group.stroke,
      distance_m: group.distance_m,
      points,
      best_centiseconds: best,
    })
  }

  // Meet-programme order, then distance — the same reading order as the rest of
  // the records screens, so an event keeps its place when a new swim lands.
  return series.sort(
    (a, b) =>
      categoryRank(a.category) - categoryRank(b.category) ||
      rank(a.stroke) - rank(b.stroke) ||
      a.distance_m - b.distance_m,
  )
}
