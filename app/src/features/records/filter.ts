// The 대분류 × 개인/단체 × 영법 × 거리 filter the president added this week,
// as a pure model rather than as four pieces of component state.
//
// It lives apart from the screens for two reasons. The member's own 기록 screen
// and a staffer's drill-down into somebody else's ask the identical question, so
// there is one answer rather than two that drift. And the part worth testing is
// not the tabs — it is what happens at the edges of his closed option set, which
// is where his version loses rows.
//
// The rule this module holds to: **an option list always contains every value
// present in the data.** His lists are fixed (50/100/200/400, five strokes), and
// the schema is not — `distance_m` is a plain int and `stroke` is free text out
// of parsed meet sheets. A 1500m swim or a stroke label nobody anticipated
// matches none of his tabs and simply vanishes from the screen. Here the
// canonical options are always offered, and anything else the member actually
// swam is appended to them, so no row is unreachable.

import type { RecordCategory, RecordSubcategory } from './api'

/** 0 is 전체 — every distance in the current selection, not a distance of zero. */
export const ALL_DISTANCES = 0

export type RecordFilter = {
  major: RecordCategory
  sub: RecordSubcategory
  /** A bucket label, not the stored `stroke` — see `strokeBucket`. */
  stroke: string
  distance: number
}

/** What a screen holds while the user is choosing. Resolved by `resolveFilter`. */
export type PartialFilter = Partial<RecordFilter>

// Structural, the same way derive.ts takes a `Comparable`: four columns, so a
// test can pass a literal and api.ts stays the only module that knows what a
// records row looks like.
export type Filterable = {
  category: string
  subcategory: string
  stroke: string
  distance_m: number
}

// ------------------------------------------------------------------- labels

export const MAJOR_LABEL: Record<RecordCategory, string> = {
  meet: '일반',
  fin: '핀',
  other: '기타',
}

export const MAJORS: readonly RecordCategory[] = ['meet', 'fin', 'other']

export const SUBS: readonly RecordSubcategory[] = ['personal', 'relay']

/**
 * 기타 says 개인기록/단체기록 where a meet says 개인전/단체전.
 *
 * His own distinction (index.html:4006-4008), and it is a real one: a 기타 row
 * is not a race, so calling it 개인전 would name it after something it is not.
 */
export function subLabel(major: RecordCategory, sub: RecordSubcategory): string {
  if (major === 'other') return sub === 'personal' ? '개인기록' : '단체기록'
  return sub === 'personal' ? '개인전' : '단체전'
}

// ------------------------------------------------------------------ buckets
// A stored stroke is free text; a tab is one of a handful of buckets. Which
// bucket a row falls in is decided here, once.

/** Everything outside the canonical strokes, so nothing is unreachable. */
export const OTHER_STROKE = '기타'

/** 기타 대분류 has no swim programme, so its team rows share one bucket. */
export const ALL_RELAYS = '단체기록'

const CANONICAL_PERSONAL_STROKES = ['자유형', '배영', '평영', '접영', '개인혼영'] as const
const CANONICAL_FIN_STROKES = ['자유형', '접영'] as const
const CANONICAL_RELAY_STROKES = ['계영', '혼계영', '혼성계영', '혼성혼계영'] as const

const squash = (value: string) => value.replace(/\s/g, '')

/**
 * Which relay a row is, most specific first.
 *
 * The order is load-bearing rather than stylistic: 혼성혼계영 contains 혼계영
 * contains 계영, so testing the short one first would file every medley relay as
 * a freestyle relay.
 */
function relayBucket(stroke: string): string {
  const text = squash(stroke)
  if (text.includes('혼성혼계영')) return '혼성혼계영'
  if (text.includes('혼성계영')) return '혼성계영'
  if (text.includes('혼계영')) return '혼계영'
  if (text.includes('계영')) return '계영'
  return OTHER_STROKE
}

/**
 * Which stroke a personal row is.
 *
 * `includes` rather than equality because the parser preserves what the sheet
 * said: '핀 자유형' and '자유형' are the same stroke to a swimmer reading their
 * times. 혼영 is tested first — 개인혼영 contains it, and no other stroke does.
 *
 * Read off `stroke` alone, unlike his `personalStrokeKind` (index.html:2758),
 * which also searches `event_name`. Our parser fills the column properly, and
 * searching the meet title would file a 자유형 swim at a meet called
 * '접영 챌린지' under 접영.
 */
function personalBucket(stroke: string, major: RecordCategory): string {
  const text = squash(stroke)
  if (major === 'fin') {
    for (const candidate of CANONICAL_FIN_STROKES) if (text.includes(candidate)) return candidate
    return OTHER_STROKE
  }
  if (text.includes('혼영')) return '개인혼영'
  for (const candidate of CANONICAL_PERSONAL_STROKES) {
    if (candidate !== '개인혼영' && text.includes(candidate)) return candidate
  }
  return OTHER_STROKE
}

/** The tab a row belongs under, given which 대분류/종류 is being viewed. */
export function strokeBucket(
  record: Pick<Filterable, 'stroke'>,
  major: RecordCategory,
  sub: RecordSubcategory,
): string {
  if (sub === 'relay') return major === 'other' ? ALL_RELAYS : relayBucket(record.stroke)
  return personalBucket(record.stroke, major)
}

// ------------------------------------------------------------------ options

function canonicalStrokes(major: RecordCategory, sub: RecordSubcategory): readonly string[] {
  if (sub === 'relay') return major === 'other' ? [ALL_RELAYS] : CANONICAL_RELAY_STROKES
  return major === 'fin' ? [...CANONICAL_FIN_STROKES, OTHER_STROKE] : CANONICAL_PERSONAL_STROKES
}

/**
 * His distances (index.html:2777-2782 and :3996-4004), which agree across both
 * of his screens: a medley starts at 100, fins race longer, everything else is
 * a sprint pair.
 */
function canonicalDistances(
  major: RecordCategory,
  sub: RecordSubcategory,
  stroke: string,
): readonly number[] {
  if (sub === 'relay') return major === 'fin' ? [200, 400] : []
  if (stroke === '개인혼영') return [100, 200]
  if (major === 'fin') return [50, 100, 200]
  return [50, 100]
}

const inScope = (record: Filterable, major: RecordCategory, sub: RecordSubcategory) =>
  record.category === major && record.subcategory === sub

/**
 * The stroke tabs to render: his canonical list, plus 기타 when the member has
 * rows that fall outside it.
 *
 * 기타 is not in his 일반/개인전 list at all, so a stroke his set does not name
 * — anything a sheet spelled unusually — has no tab of its own on his screen and
 * cannot be reached. Appending the bucket only when it holds something keeps the
 * common case identical to his while making that row reachable.
 */
export function strokeOptions(
  rows: readonly Filterable[],
  major: RecordCategory,
  sub: RecordSubcategory,
): string[] {
  const options = [...canonicalStrokes(major, sub)]
  if (!options.includes(OTHER_STROKE)) {
    const hasOther = rows.some(
      (row) => inScope(row, major, sub) && strokeBucket(row, major, sub) === OTHER_STROKE,
    )
    if (hasOther) options.push(OTHER_STROKE)
  }
  return options
}

/**
 * The distance tabs: his closed set, plus every distance the member actually
 * swam in this selection, ascending. 전체 leads when there is anything to
 * choose between.
 *
 * This is the answer to a 25m or 1500m record, which exists in the schema and
 * not in his four buttons. It gets its own tab beside them rather than being
 * filtered out of a screen that then reports no records.
 */
export function distanceOptions(
  rows: readonly Filterable[],
  major: RecordCategory,
  sub: RecordSubcategory,
  stroke: string,
): number[] {
  const present = new Set<number>(canonicalDistances(major, sub, stroke))
  for (const row of rows) {
    if (!inScope(row, major, sub)) continue
    if (strokeBucket(row, major, sub) !== stroke) continue
    if (row.distance_m > 0) present.add(row.distance_m)
  }
  if (present.size === 0) return []
  return [ALL_DISTANCES, ...[...present].sort((a, b) => a - b)]
}

/** True when a distance tab shows something his four buttons never would. */
export function isExtraDistance(
  distance: number,
  major: RecordCategory,
  sub: RecordSubcategory,
  stroke: string,
): boolean {
  if (distance === ALL_DISTANCES) return false
  return !canonicalDistances(major, sub, stroke).includes(distance)
}

// ----------------------------------------------------------------- matching

export function matchesFilter(record: Filterable, filter: RecordFilter): boolean {
  if (!inScope(record, filter.major, filter.sub)) return false
  if (strokeBucket(record, filter.major, filter.sub) !== filter.stroke) return false
  return filter.distance === ALL_DISTANCES || record.distance_m === filter.distance
}

export function applyFilter<T extends Filterable>(rows: readonly T[], filter: RecordFilter): T[] {
  return rows.filter((row) => matchesFilter(row, filter))
}

// ------------------------------------------------------------------ resolve

const countMatching = (rows: readonly Filterable[], filter: RecordFilter) =>
  rows.reduce((total, row) => (matchesFilter(row, filter) ? total + 1 : total), 0)

/**
 * Fill in whatever the user has not chosen, preferring a selection that has
 * something in it.
 *
 * His defaults are fixed — 일반, 개인전, 자유형, 50M — so a swimmer who has only
 * ever raced 평영 opens the screen on a blank panel and has to guess which tab
 * to press. Here a default is only kept when it holds rows; otherwise the first
 * option that holds any wins, and the distance falls back to 전체 rather than to
 * a length this member never swam.
 *
 * An explicit choice is never overridden, only an absent one — pressing 50M and
 * finding it empty is an answer, and `emptyReason` explains it.
 */
export function resolveFilter(
  rows: readonly Filterable[],
  partial: PartialFilter = {},
): RecordFilter {
  const major = partial.major ?? 'meet'
  const sub = partial.sub ?? 'personal'

  const strokes = strokeOptions(rows, major, sub)
  const chosenStroke =
    partial.stroke !== undefined && strokes.includes(partial.stroke) ? partial.stroke : undefined
  const stroke =
    chosenStroke ??
    strokes.find((candidate) =>
      rows.some((row) => inScope(row, major, sub) && strokeBucket(row, major, sub) === candidate),
    ) ??
    strokes[0] ??
    ''

  const distances = distanceOptions(rows, major, sub, stroke)
  const chosenDistance =
    partial.distance !== undefined && distances.includes(partial.distance)
      ? partial.distance
      : undefined
  const distance =
    chosenDistance ??
    distances.find(
      (candidate) =>
        candidate !== ALL_DISTANCES &&
        countMatching(rows, { major, sub, stroke, distance: candidate }) > 0,
    ) ??
    ALL_DISTANCES

  return { major, sub, stroke, distance }
}

// -------------------------------------------------------------- empty state

/**
 * Why the list is empty, and one press that fixes it.
 *
 * The legacy screen printed 해당 조건의 기록이 없습니다 for every empty
 * combination, which reads as "this member has no records" when it usually means
 * "not at this distance". Each branch below names the filter that emptied the
 * list and carries a filter that is guaranteed to hold something, so the reader
 * is never left guessing which of four tab rows to undo.
 */
export type EmptyReason = {
  /** Names the filter responsible, not just the absence. */
  message: string
  /** Guaranteed non-empty, or null when the member genuinely has no rows. */
  fallback: PartialFilter | null
  /** What the button offering `fallback` says. */
  fallbackLabel: string
}

function firstStrokeWithRows(
  rows: readonly Filterable[],
  major: RecordCategory,
  sub: RecordSubcategory,
): string | undefined {
  return strokeOptions(rows, major, sub).find((candidate) =>
    rows.some((row) => inScope(row, major, sub) && strokeBucket(row, major, sub) === candidate),
  )
}

export function emptyReason(rows: readonly Filterable[], filter: RecordFilter): EmptyReason {
  const { major, sub, stroke, distance } = filter
  const scope = `${MAJOR_LABEL[major]} ${subLabel(major, sub)}`

  if (rows.length === 0) {
    return { message: '아직 등록된 기록이 없습니다', fallback: null, fallbackLabel: '' }
  }

  // Narrowest first: the distance is the tab most likely to be the culprit and
  // the cheapest to undo.
  if (distance !== ALL_DISTANCES) {
    const atAnyDistance = countMatching(rows, { ...filter, distance: ALL_DISTANCES })
    if (atAnyDistance > 0) {
      return {
        message: `${scope} ${stroke} ${distance}M 기록이 없습니다. 거리를 전체로 보면 ${atAnyDistance}건이 있습니다.`,
        fallback: { major, sub, stroke, distance: ALL_DISTANCES },
        fallbackLabel: '거리 전체 보기',
      }
    }
  }

  const otherStroke = firstStrokeWithRows(rows, major, sub)
  if (otherStroke !== undefined) {
    return {
      message: `${scope}에 ${stroke} 기록이 없습니다.`,
      fallback: { major, sub, stroke: otherStroke },
      fallbackLabel: `${otherStroke} 보기`,
    }
  }

  const otherSub = SUBS.find(
    (candidate) => candidate !== sub && rows.some((row) => inScope(row, major, candidate)),
  )
  if (otherSub !== undefined) {
    return {
      message: `${scope} 기록이 없습니다.`,
      fallback: { major, sub: otherSub },
      fallbackLabel: `${subLabel(major, otherSub)} 보기`,
    }
  }

  const otherMajor = MAJORS.find(
    (candidate) => candidate !== major && rows.some((row) => row.category === candidate),
  )
  if (otherMajor !== undefined) {
    return {
      message: `${MAJOR_LABEL[major]} 기록이 없습니다.`,
      fallback: { major: otherMajor },
      fallbackLabel: `${MAJOR_LABEL[otherMajor]} 보기`,
    }
  }

  // Rows exist but none of them carries a category this app can read. Saying so
  // beats a fallback that would land on another empty screen.
  return { message: '표시할 수 있는 기록이 없습니다', fallback: null, fallbackLabel: '' }
}

// --------------------------------------------------------------- PB summary

/** The four strokes his PB grid shows, at the one distance it shows them. */
export const PB_STROKES = ['자유형', '배영', '평영', '접영'] as const
export const PB_DISTANCE = 50

export type PersonalBestCell<T> = { stroke: string; record: T | null }

/**
 * His 50M personal-best grid (index.html:3933), 일반 개인전 only.
 *
 * Always four cells, a dash where there is no swim — the grid is a fixed shape a
 * reader learns the position of, so dropping a stroke would move the other
 * three. Both of his screens show it for 일반 alone; the fin branch he wrote at
 * index.html:2831 is never reached, because :2849 renders the block only when
 * the 대분류 is 일반.
 */
export function personalBestGrid<T extends Filterable & { result_centiseconds: number }>(
  rows: readonly T[],
): PersonalBestCell<T>[] {
  return PB_STROKES.map((stroke) => {
    let best: T | null = null
    for (const row of rows) {
      if (!inScope(row, 'meet', 'personal')) continue
      if (row.distance_m !== PB_DISTANCE) continue
      if (strokeBucket(row, 'meet', 'personal') !== stroke) continue
      // Strictly faster, so the earliest swim keeps the honour when two match —
      // the same tiebreak personalBests() uses in derive.ts.
      if (best === null || row.result_centiseconds < best.result_centiseconds) best = row
    }
    return { stroke, record: best }
  })
}
