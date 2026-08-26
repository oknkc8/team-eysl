// Personal bests and deltas are read off rows the client already holds rather
// than asked of the server: records_read (0004) shows a member only their own
// rows, so the one fetch that paints the history is the same set a best is the
// minimum of. A view or an RPC would be a second round trip for an answer
// already in hand.

// Structural, the same way order.ts takes a bare `Dated`: these functions need
// seven columns, not the whole row, so a test can pass a literal and api.ts
// stays the only module that knows what a records row actually looks like.
type Comparable = {
  id: string
  category: string
  subcategory: string
  stroke: string
  distance_m: number
  event_date: string
  created_at: string
  result_centiseconds: number
}

export type WithDelta<T> = T & {
  /**
   * Centiseconds against this member's previous swim of the same event.
   * Negative is faster, because the later swim took fewer of them. Null for the
   * first time they ever swam it, which is not the same as an unchanged time.
   */
  delta_centiseconds: number | null
  /** Nothing this member had swum in this event before was faster. */
  is_personal_best: boolean
}

// Category and subcategory are both part of the key everywhere below, and for
// the same reason. A relay leg starts from a flying push worth roughly half a
// second, so letting one share a group with an individual swim would credit a
// swimmer with an improvement they did not make — and, in personalBests, with a
// best they never swam off the blocks. A 핀 swim is a larger version of the same
// error: fins are worth several seconds over 50m, so a 자유형 50 with fins
// grouped against one without would report a spectacular improvement, then a
// spectacular regression at the next meet. The 대분류 filter added to both
// record screens is what made this visible — a delta shown under 일반 must be
// against another 일반 swim.
const eventKey = (r: Comparable) =>
  `${r.category}|${r.subcategory}|${r.stroke}|${r.distance_m}`

// The order a Korean meet programme lists events in, taken from the legacy
// screen's own option lists (index.html:2562-2566). stroke is free text on
// purpose — it comes from parsed sheets, not a set this app defines — so
// anything unlisted sorts after these, alphabetically, rather than being lost.
const STROKE_ORDER = ['자유형', '배영', '평영', '접영', '개인혼영'] as const

function strokeRank(stroke: string): number {
  const index = (STROKE_ORDER as readonly string[]).indexOf(stroke)
  return index === -1 ? STROKE_ORDER.length : index
}

function compareEvent(a: Comparable, b: Comparable): number {
  const byRank = strokeRank(a.stroke) - strokeRank(b.stroke)
  if (byRank !== 0) return byRank
  // Two unlisted strokes share a rank, so they still need separating.
  if (a.stroke !== b.stroke) return a.stroke.localeCompare(b.stroke, 'ko')
  return a.distance_m - b.distance_m
}

// event_date is a bare date and created_at an ISO timestamp, both of which sort
// correctly as strings. The id tiebreak is not decoration: created_at defaults
// to now(), which is the transaction start, so an upload writing a whole meet
// stamps every row identically and two swims of the same event would otherwise
// swap places between refetches — and swapping them swaps which one owns the
// delta.
const compareChronological = (a: Comparable, b: Comparable) =>
  a.event_date.localeCompare(b.event_date) ||
  a.created_at.localeCompare(b.created_at) ||
  a.id.localeCompare(b.id)

/**
 * The fastest swim for each stroke and distance, personal events only.
 *
 * Ordered the way a meet programme reads rather than by time or date, so an
 * event's card stays in the same place on the screen after a new swim moves its
 * number.
 */
export function personalBests<T extends Comparable>(records: readonly T[]): T[] {
  const best = new Map<string, T>()

  for (const record of records) {
    if (record.subcategory !== 'personal') continue
    const key = eventKey(record)
    const current = best.get(key)
    // Strictly faster, so the earliest swim keeps the honour when two match.
    if (current === undefined || record.result_centiseconds < current.result_centiseconds) {
      best.set(key, record)
    }
  }

  return [...best.values()].sort(compareEvent)
}

/**
 * Every swim newest first, each carrying the gap to that member's previous swim
 * of the same event.
 *
 * Relays stay in the list — the history tab shows a swimmer everything they did
 * — but are compared only against other relays of the same event, for the
 * reason on eventKey above.
 */
export function withDeltas<T extends Comparable>(records: readonly T[]): WithDelta<T>[] {
  // Oldest first, so each row can look back at the one before it.
  const chronological = [...records].sort(compareChronological)

  const previous = new Map<string, number>()
  const fastest = new Map<string, number>()
  const out: WithDelta<T>[] = []

  for (const record of chronological) {
    const key = eventKey(record)
    const last = previous.get(key)
    const best = fastest.get(key)
    const improved = best === undefined || record.result_centiseconds < best

    out.push({
      ...record,
      delta_centiseconds: last === undefined ? null : record.result_centiseconds - last,
      is_personal_best: improved,
    })

    previous.set(key, record.result_centiseconds)
    if (improved) fastest.set(key, record.result_centiseconds)
  }

  // Newest first is how the screen reads; the pass above needed the opposite.
  return out.reverse()
}

/** Team events only, newest first. */
export function relayRecords<T extends Comparable>(records: readonly T[]): T[] {
  return records
    .filter((record) => record.subcategory === 'relay')
    .sort((a, b) => compareChronological(b, a))
}

/** One meet a member swam at, however many events they swam in it. */
export type RaceEvent = {
  /** `event_name` and `event_date` joined — records carry no meet id. */
  id: string
  title: string
  date: string
  /** How many of their swims came from it, which is the row's whole substance. */
  swimCount: number
}

type Attendable = {
  category: string
  event_name: string
  event_date: string
}

/**
 * The meets a member competed at, newest first, rebuilt from their results.
 *
 * Same source as his 대회 참가 현황 (index.html:4079-4085): a meet is not a row
 * in this schema, so the evidence that somebody swam at one is that they have
 * results from it. 기타 is excluded because it is not a competition, and a
 * record with no `event_name` is skipped rather than grouped under an empty
 * heading — it attests to a swim, not to an identifiable meet.
 */
export function raceEvents(records: readonly Attendable[]): RaceEvent[] {
  const byMeet = new Map<string, RaceEvent>()

  for (const record of records) {
    if (record.category !== 'meet' && record.category !== 'fin') continue
    const title = record.event_name.trim()
    if (title === '') continue

    const id = `${title}|${record.event_date}`
    const existing = byMeet.get(id)
    if (existing) existing.swimCount += 1
    else byMeet.set(id, { id, title, date: record.event_date, swimCount: 1 })
  }

  // Same meet name on two dates is two entries, so the date decides the order.
  return [...byMeet.values()].sort((a, b) => b.date.localeCompare(a.date))
}
