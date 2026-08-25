// Header and context location, ported from index.html:2831-2838
// (detectHeaderIndex), 2990-3002 (findHeaderMap) and 3003-3012
// (eventContextAbove).

import {
  detectDistance,
  detectRelayType,
  detectStroke,
  normResultText,
  normalizedKey,
} from './fields'

/** Where each column the row walk needs sits, and which row named them. */
export type HeaderMap = {
  /** 0-based index into the matrix. */
  row: number
  nameCol: number
  teamCol: number
  /** -1 when the sheet names the event above the rows instead of beside them. */
  eventCol: number
  distanceCol: number
  resultCol: number
}

/** What the rows above a result say about which event it belongs to. */
export type EventContext = {
  text: string
  relay: string
  stroke: string
  distance: number | null
}

/**
 * First column whose header contains any of the given words.
 *
 * `includes`, not equality: real sheets write 선수명(한글), 기록(초) and 소속팀,
 * and normalizedKey has already stripped the punctuation those hide behind.
 */
export function detectHeaderIndex(row: string[], keys: string[][]): number {
  const normalized = row.map(normalizedKey)
  for (const key of keys) {
    const idx = normalized.findIndex((x) => key.some((k) => x.includes(k)))
    if (idx >= 0) return idx
  }
  return -1
}

/**
 * Every header row in the sheet, in order.
 *
 * A meet sheet usually carries one table per event, each with its own header,
 * so this returns a list and the row walk treats the next header as the end of
 * the previous table.
 *
 * The three-way requirement — name AND team AND result — is what makes the
 * club's own internal sheet parse as nothing at all rather than as garbage: it
 * lists members down the side and events across the top, with no 소속 column
 * anywhere, so no row here ever qualifies.
 *
 * Only the first 60 rows are searched. A header below that is a sheet nobody
 * has seen, and scanning the whole thing would start finding headers inside
 * data.
 */
export function findHeaderMap(matrix: string[][]): HeaderMap[] {
  const maps: HeaderMap[] = []
  for (let r = 0; r < Math.min(matrix.length, 60); r++) {
    const h = (matrix[r] ?? []).map(normResultText)
    const nameCol = detectHeaderIndex(h, [['이름', '성명', '선수명', '선수', 'name']])
    const teamCol = detectHeaderIndex(h, [['팀명', '소속', '클럽', 'team', 'club']])
    const eventCol = detectHeaderIndex(h, [['종목', '영법', 'event', 'stroke']])
    const distanceCol = detectHeaderIndex(h, [['거리', 'distance']])
    const resultCol = detectHeaderIndex(h, [['기록', '결과', 'time', 'result', 'record']])
    if (nameCol >= 0 && teamCol >= 0 && resultCol >= 0)
      maps.push({ row: r, nameCol, teamCol, eventCol, distanceCol, resultCol })
  }
  return maps
}

/**
 * Walks up from a result row looking for the event it belongs to.
 *
 * Starts at the row itself, so a sheet that repeats 자유형 50m on every line
 * needs no lookup, and stops ten rows up — beyond that the nearest heading
 * belongs to a different event and would file the swim under the wrong stroke.
 *
 * Returns on the first row that yields anything at all, which is why a data row
 * carrying the number 50 in a lane column can shadow the real heading. That is
 * a real weakness of the heuristic, ported as it stands.
 */
export function eventContextAbove(matrix: string[][], rowIndex: number): EventContext {
  for (let r = rowIndex; r >= Math.max(0, rowIndex - 10); r--) {
    const t = (matrix[r] ?? []).map(normResultText).join(' ')
    const relay = detectRelayType(t)
    const stroke = detectStroke(t)
    const distance = detectDistance(t)
    if (relay || stroke || distance) return { text: t, relay, stroke, distance }
  }
  return { text: '', relay: '', stroke: '', distance: null }
}
