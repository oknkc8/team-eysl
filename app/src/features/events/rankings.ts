// Narrowing for the payload team_event_rankings_v1() returns. The RPC is typed
// as Json by the generator, so the shape has to be established here rather than
// asserted with a cast — a cast would let a renamed key reach the screen as
// `undefined` printed into a heading.
//
// The split of what is tolerated and what is not is deliberate:
//   * A missing or non-array LIST is tolerated and read as empty. Empty is a
//     real state — a fresh season, a stroke nobody has raced yet — and the
//     server sends [] for it, so treating a missing list as a failure would put
//     an error screen in front of a member whose club simply has no data yet.
//   * A missing `year` is NOT tolerated. Every heading on the ranking screen
//     interpolates it, and the server always sends it. A payload without one is
//     a broken contract, and showing "undefined 상반기 출석왕" is worse than
//     showing the error state.

export type RankingKind = 'attendance' | 'late' | 'improve'
export type RankingPeriod = 'lifetime' | 'h1' | 'h2'

/** 출석왕 · 지각왕 row. */
export type CountRow = { rank: number; nickname: string; count: number }

/** 단축왕 row. `seconds` is already in seconds; the database holds centiseconds. */
export type ImprovementRow = {
  rank: number
  nickname: string
  stroke: string
  distance: number
  seconds: number
}

export type CountLists = Record<RankingPeriod, CountRow[]>

export type TeamEventRankings = {
  year: number
  attendance: CountLists
  late: CountLists
  improvements: { within_year: ImprovementRow[]; yoy_pb: ImprovementRow[] }
}

/**
 * The four strokes the rankings screen groups by, in Korean meet-programme
 * order. The server filters to exactly these, so a stroke outside the list —
 * '핀 자유형', '개인혼영' — never arrives rather than being dropped here.
 */
export const STROKES = ['자유형', '배영', '평영', '접영'] as const

export const PERIODS: RankingPeriod[] = ['lifetime', 'h1', 'h2']

export const KIND_TITLE: Record<RankingKind, string> = {
  attendance: '출석왕',
  late: '지각왕',
  improve: '단축왕',
}

export function isRankingKind(value: string | undefined): value is RankingKind {
  return value === 'attendance' || value === 'late' || value === 'improve'
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

function countRows(value: unknown): CountRow[] {
  return asArray(value)
    .filter(isRecord)
    .map((row) => ({
      rank: asNumber(row.rank),
      nickname: asString(row.nickname),
      count: asNumber(row.count),
    }))
}

function improvementRows(value: unknown): ImprovementRow[] {
  return asArray(value)
    .filter(isRecord)
    .map((row) => ({
      rank: asNumber(row.rank),
      nickname: asString(row.nickname),
      stroke: asString(row.stroke),
      distance: asNumber(row.distance),
      // A JSON number, not a string: the server builds this with
      // jsonb_build_object, so round(numeric) is serialised into the payload as
      // 5.00 rather than handed over as a bare numeric column would be.
      seconds: asNumber(row.seconds),
    }))
}

function countLists(value: unknown): CountLists {
  const source = isRecord(value) ? value : {}
  return {
    lifetime: countRows(source.lifetime),
    h1: countRows(source.h1),
    h2: countRows(source.h2),
  }
}

export class RankingsContractError extends Error {}

export function parseRankings(value: unknown): TeamEventRankings {
  if (!isRecord(value)) throw new RankingsContractError('랭킹 응답이 객체가 아닙니다')

  // The server answers a caller who is not an approved member with this instead
  // of raising, so it reaches us as a successful response carrying a failure.
  if (typeof value.error === 'string') throw new RankingsContractError(value.error)

  if (typeof value.year !== 'number' || !Number.isFinite(value.year))
    throw new RankingsContractError('랭킹 응답에 연도가 없습니다')

  const improvements = isRecord(value.improvements) ? value.improvements : {}

  return {
    year: value.year,
    attendance: countLists(value.attendance),
    late: countLists(value.late),
    improvements: {
      within_year: improvementRows(improvements.within_year),
      yoy_pb: improvementRows(improvements.yoy_pb),
    },
  }
}

// -------------------------------------------------------------------- reading

/** The three lists behind 출석왕 or 지각왕, in display order. */
export function countListsFor(data: TeamEventRankings, kind: 'attendance' | 'late'): CountLists {
  return kind === 'attendance' ? data.attendance : data.late
}

/**
 * Improvement rows split into the four strokes. Every stroke is returned even
 * when it has no rows, because the screen shows all four headings and says so
 * under the empty ones rather than hiding them — a missing 접영 heading reads
 * as a broken screen, an empty one reads as "nobody has raced it yet".
 */
export function groupByStroke(
  rows: ImprovementRow[],
): { stroke: string; rows: ImprovementRow[] }[] {
  return STROKES.map((stroke) => ({ stroke, rows: rows.filter((row) => row.stroke === stroke) }))
}

/**
 * True when the whole payload has nothing to show. Used for one empty state
 * over the entire screen instead of the same sentence repeated under every
 * heading, which is what a club with no data yet would otherwise read.
 */
export function isRankingsEmpty(data: TeamEventRankings, kind: RankingKind): boolean {
  if (kind === 'improve')
    return data.improvements.within_year.length === 0 && data.improvements.yoy_pb.length === 0
  const lists = countListsFor(data, kind)
  return PERIODS.every((period) => lists[period].length === 0)
}

/** `1.5` → `"1.50"`, matching the president's `Number(r.seconds).toFixed(2)`. */
export function formatSeconds(seconds: number): string {
  return seconds.toFixed(2)
}

// ---------------------------------------------------------------- 메달·등급

/**
 * How many rows a ranking shows before the 전체 랭킹 보기 button
 * (upstream:4152, and his rankToggleButton at :4226).
 */
export const TOP_RANK_LIMIT = 5

/**
 * 금·은·동 for the podium, the plain number for everybody else — his
 * rankDisplay (upstream:4212-4218), shipped in final75-medal-rank.
 *
 * Ties make this less obvious than it looks. team_event_rankings_v1 ranks with
 * rank(), so two members on the same count share a rank and the next distinct
 * count skips: two 1st places are followed by a 3rd, never a 2nd. The screen
 * then shows two 🥇 and a 🥉 with no 🥈 at all — which is correct, and is what a
 * real podium does, but reads as a missing medal unless you know the rule.
 */
export const RANK_MEDALS: Readonly<Record<number, string>> = { 1: '🥇', 2: '🥈', 3: '🥉' }

export function rankDisplay(rank: number): string {
  return RANK_MEDALS[rank] ?? String(rank)
}

/** True once a list is long enough to be worth collapsing. */
export function hasHiddenRanks(rowCount: number): boolean {
  return rowCount > TOP_RANK_LIMIT
}

/** The button's label, which says what the next tap will do (upstream:4224). */
export function rankToggleLabel(expanded: boolean): string {
  return expanded ? 'TOP5만 보기' : '전체 랭킹 보기'
}
