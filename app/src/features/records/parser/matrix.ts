// The row walk, ported from index.html:2847-2887 (relayCandidatesFromMatrix),
// 2888-2892 (normalizeResultCandidate) and 2893-2933 (parseMatrixResults), plus
// 3154-3174 (dedupeParsedResults).
//
// index.html:3035-3037 defines parseMatrixResultsNeighborhood, which returns []
// and is called from nowhere. Not ported.
//
// One behaviour changes on the way over, deliberately and in one place: a name
// the roster cannot resolve no longer drops the row. See roster.ts.

import type { RecordCategory, RecordSubcategory } from '../api'
import { parseSwimTime } from '../time'
import {
  detectDistance,
  detectRelayType,
  detectStroke,
  genericNamesFromCells,
  normResultText,
} from './fields'
import { eventContextAbove, findHeaderMap } from './header'
import { matchRealName, type MatchState, type RosterEntry } from './roster'
import {
  candidateTimeFromCells,
  detectResultTime,
  looksLikeSwimTimeValue,
  normalizeResultForStorage,
  plausibleSwimTime,
} from './swimTime'
import type { ParsedRow } from './types'

/** Matched against the 소속 column, upper-cased, with `includes`. */
export const EYSL_RESULT_TEAM = 'EYSL'

export type MatrixContext = {
  sheetName: string
  eventDate: string
  eventName: string
  category: RecordCategory
  roster: RosterEntry[]
}

/** Rows found, plus the counts the review screen reports back to the admin. */
export type MatrixWalk = {
  rows: ParsedRow[]
  /**
   * Header rows found. Zero is what separates "this file is not a meet sheet"
   * from "this meet sheet had no EYSL swimmers" — two outcomes that both show
   * an empty table and need opposite things said about them.
   */
  headerRows: number
  eyslRows: number
  skippedRows: number
}

type Candidate = {
  context: MatrixContext
  rowNumber: number
  sourceName: string
  sourceTeam: string
  match: MatchState
  subcategory: RecordSubcategory
  stroke: string
  distance: number | null
  /** Raw, as read off the sheet — normalised here, not by the caller. */
  result: string
  teammates: string[]
}

/**
 * Port of normalizeResultCandidate (index.html:2888-2892), minus its member_id
 * requirement and plus the centisecond conversion the new schema needs.
 *
 * Returns null rather than a half-built row: no stroke, no time, or a display
 * string parseSwimTime cannot read back. The caller counts that as skipped.
 *
 * The parseSwimTime check is defence, not a live branch. It fires only if
 * normalizeResultForStorage emits seconds of '60.00', which needs an input
 * whose seconds land in [59.995, 60) — '1:59.996' and nothing else. Every path
 * into here gates on looksLikeSwimTimeValue first, and that refuses a third
 * fractional digit, so the shape cannot arrive. Kept because it is the one
 * check standing between a rounding artefact and a swim time nobody swam.
 */
function toParsedRow(candidate: Candidate): ParsedRow | null {
  const { context } = candidate
  if (!candidate.stroke || !candidate.result) return null

  const resultDisplay = normalizeResultForStorage(candidate.result)
  if (!resultDisplay) return null

  const resultCentiseconds = parseSwimTime(resultDisplay)
  if (resultCentiseconds === null || resultCentiseconds <= 0) return null

  return {
    key: [
      context.sheetName,
      candidate.rowNumber,
      candidate.subcategory,
      candidate.stroke,
      candidate.distance ?? '-',
      candidate.sourceName,
      resultDisplay,
    ].join('!'),
    sheetName: context.sheetName,
    rowNumber: candidate.rowNumber,
    sourceName: candidate.sourceName,
    sourceTeam: candidate.sourceTeam,
    match: candidate.match,
    category: context.category,
    subcategory: candidate.subcategory,
    stroke: candidate.stroke,
    distanceM: candidate.distance,
    eventDate: context.eventDate,
    eventName: context.eventName,
    resultDisplay,
    resultCentiseconds,
    teammates: candidate.teammates,
  }
}

/**
 * The main walk: one table per header row, one row per swimmer.
 *
 * The EYSL check comes first and is the whole filter — every other club on the
 * sheet is passed over silently, which is right, and was also true of the
 * legacy. What is no longer silent is an EYSL row we cannot attribute: it is
 * counted, carried, and shown.
 */
export function parseMatrixResults(matrix: string[][], context: MatrixContext): MatrixWalk {
  const rows: ParsedRow[] = []
  let eyslRows = 0
  let skippedRows = 0

  const headerMaps = findHeaderMap(matrix)
  const headerRows = headerMaps.length
  if (!headerRows) return { rows, headerRows, eyslRows, skippedRows }

  for (let hi = 0; hi < headerMaps.length; hi++) {
    const hm = headerMaps[hi]
    if (!hm) continue
    // The next header ends this table. Without it the walk would run on into
    // the following event and read its swimmers under this event's columns.
    const nextHeader = headerMaps[hi + 1]?.row ?? matrix.length

    for (let r = hm.row + 1; r < nextHeader; r++) {
      const row = (matrix[r] ?? []).map(normResultText)
      if (!row.some(Boolean)) continue

      const team = normResultText(row[hm.teamCol])
      const name = normResultText(row[hm.nameCol])
      if (!team.toUpperCase().includes(EYSL_RESULT_TEAM)) continue
      eyslRows++

      const ctx = eventContextAbove(matrix, r)
      const eventText = hm.eventCol >= 0 ? normResultText(row[hm.eventCol]) : ctx.text
      const relayType = detectRelayType(eventText) || ctx.relay
      const relay = !!relayType
      const stroke = relayType || detectStroke(eventText) || ctx.stroke
      // A 거리 column wins over anything read out of prose, and `|| 0` is what
      // makes an unreadable one fall through rather than land as NaN.
      const distance =
        (hm.distanceCol >= 0 ? Number(String(row[hm.distanceCol]).replace(/[^\d]/g, '')) : 0) ||
        detectDistance(eventText) ||
        ctx.distance
      const rawResult = normResultText(row[hm.resultCol])
      // Whole-cell shape first: a 기록 cell that merely *contains* digits is not
      // a time, and detectResultTime alone would happily pull one out of a memo.
      const result = looksLikeSwimTimeValue(rawResult) ? detectResultTime(rawResult) : ''
      if (!stroke || !result || !plausibleSwimTime(result, distance, relay)) {
        skippedRows++
        continue
      }

      const parsed = toParsedRow({
        context,
        rowNumber: r + 1,
        sourceName: name,
        sourceTeam: team,
        match: matchRealName(name, context.roster),
        subcategory: relay ? 'relay' : 'personal',
        stroke,
        distance,
        result,
        teammates: relay ? [name] : [],
      })
      if (parsed) rows.push(parsed)
      else skippedRows++
    }
  }

  return { rows, headerRows, eyslRows, skippedRows }
}

/**
 * Relay blocks, which have no header row to hang columns off.
 *
 * A relay is printed as a title (계영 200m), then a band of rows carrying the
 * clubs, their four swimmers and one time. The walk takes the 24 rows below any
 * title, insists the club appears somewhere inside them, and reads the time off
 * the row that names the club — falling back to the best time-shaped cell in
 * the whole block.
 *
 * Two things are worth knowing about the port:
 *
 * 1. `teammates` is genericNamesFromCells over the entire block, so it picks up
 *    two-syllable header words — 순위, 소속, 기록 — alongside the swimmers. That
 *    is the legacy's own output, ported as-is; the review table shows it, so an
 *    admin sees it before it is filed. First thing to fix in a cleanup pass.
 * 2. Where the legacy emitted a row per *matched* member and nothing otherwise,
 *    this emits a row per resolvable name, and — when no name resolved at all —
 *    one unattributed row, so the block is visible instead of vanishing. It
 *    does not emit an unmatched row per unresolved name: the block spans
 *    several clubs, so that would offer other clubs' swimmers as candidates for
 *    an EYSL record.
 */
export function relayCandidatesFromMatrix(matrix: string[][], context: MatrixContext): ParsedRow[] {
  const out: ParsedRow[] = []

  for (let r = 0; r < matrix.length; r++) {
    const title = (matrix[r] ?? []).map(normResultText).join(' ')
    const relayType = detectRelayType(title)
    if (!relayType) continue

    const distance = detectDistance(title)
    const block = matrix
      .slice(r, Math.min(matrix.length, r + 24))
      .map((row) => (row ?? []).map(normResultText))
    const flat = block.flat()
    const text = flat.join(' ')
    if (!text.toUpperCase().includes(EYSL_RESULT_TEAM)) continue

    const allNames = genericNamesFromCells(flat)
    // Fewer than four names is not a relay result, it is a heading that happens
    // to say 계영.
    if (allNames.length < 4) continue

    let result = ''
    for (const row of block) {
      const teamIndex = row.findIndex((v) => String(v).toUpperCase().includes(EYSL_RESULT_TEAM))
      if (teamIndex < 0) continue
      const rowTimes = row
        .filter(looksLikeSwimTimeValue)
        .map(detectResultTime)
        .filter((t) => plausibleSwimTime(t, distance, true))
      const [first] = rowTimes
      if (first) {
        result = first
        break
      }
    }
    if (!result) result = candidateTimeFromCells(flat, distance, true)
    if (!result) continue

    const teammates = allNames.slice(0, 8)
    let attributed = 0
    for (const name of allNames) {
      const match = matchRealName(name, context.roster)
      if (match.kind === 'unmatched') continue
      const parsed = toParsedRow({
        context,
        rowNumber: r + 1,
        sourceName: name,
        sourceTeam: EYSL_RESULT_TEAM,
        match,
        subcategory: 'relay',
        stroke: relayType,
        distance,
        result,
        teammates,
      })
      if (parsed) {
        out.push(parsed)
        attributed++
      }
    }

    if (attributed === 0) {
      const parsed = toParsedRow({
        context,
        rowNumber: r + 1,
        sourceName: '',
        sourceTeam: EYSL_RESULT_TEAM,
        match: { kind: 'unmatched' },
        subcategory: 'relay',
        stroke: relayType,
        distance,
        result,
        teammates,
      })
      if (parsed) out.push(parsed)
    }
  }

  return out
}

/**
 * Collapses readings of the same swim, ported from index.html:3154-3174.
 *
 * The sort is the legacy's `.00` rule again: a sheet often prints a rounded
 * official time beside the timed one, and the reading with real hundredths is
 * the one to keep. After normalizeResultForStorage every display string ends in
 * two decimals, so in practice this sort no longer separates anything — ported
 * anyway, because deciding it is dead is a cleanup, not a port.
 *
 * The legacy keyed on the source *file*; this keys on nothing file-shaped,
 * which is the same thing since one call only ever sees one file. Rows whose
 * member is still unresolved are keyed by printed name, so two different
 * unmatched swimmers never collapse into one.
 */
export function dedupeParsedRows(rows: ParsedRow[]): ParsedRow[] {
  const groups = new Map<string, ParsedRow[]>()

  for (const row of rows) {
    const identity = row.match.kind === 'matched' ? row.match.memberId : `name:${row.sourceName}`
    const key = [
      identity,
      row.subcategory,
      row.stroke,
      Number(row.distanceM || 0),
      row.eventDate,
      row.eventName,
    ].join('|')
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }

  const out: ParsedRow[] = []
  for (const group of groups.values()) {
    group.sort((a, b) => {
      const aPrec = /\.\d{2}$/.test(a.resultDisplay) ? 0 : 1
      const bPrec = /\.\d{2}$/.test(b.resultDisplay) ? 0 : 1
      return aPrec - bPrec
    })
    const [best] = group
    if (best) out.push(best)
  }
  return out
}
