// The shape a parsed sheet hands to the review screen.
//
// Everything from `category` down mirrors what upsert_record() takes, so saving
// a row is a field-for-field pass-through with no second interpretation step —
// the parser decides once and the screen shows exactly what will be written.
// The fields above it are provenance and match state: what the sheet actually
// said, and whether we know who swam it.

// Type-only imports, erased at compile time, so nothing here pulls the Supabase
// client into a parser that must stay runnable without one.
import type { RecordCategory, RecordSubcategory } from '../api'
import type { MatchState } from './roster'

export type ParsedRow = {
  /**
   * Stable across re-parses of the same file: sheet, row and printed name.
   * Used as the React key and as the identity the include/override maps are
   * keyed by, so a re-render never re-associates an admin's choice with a
   * different swimmer.
   */
  key: string
  /** Which sheet of the workbook, for an admin looking for the row. */
  sheetName: string
  /** 1-based, the number Excel shows in the margin — not the array index. */
  rowNumber: number
  /** 실명 exactly as printed. Empty for a relay block with no attributable name. */
  sourceName: string
  /** The 소속 cell that matched EYSL, kept so a near-miss is visible. */
  sourceTeam: string
  match: MatchState

  category: RecordCategory
  subcategory: RecordSubcategory
  stroke: string
  /**
   * null when the sheet never said. Such a row is shown but cannot be saved:
   * records.distance_m is `int not null check (distance_m > 0)` (0004:73), and
   * guessing a distance is exactly how a 50m time becomes a 100m record.
   */
  distanceM: number | null
  eventDate: string
  eventName: string
  /** '33.08' / '1:05.32' — normalizeResultForStorage's one spelling. */
  resultDisplay: string
  /** The canonical number. Everything compares this, never the string. */
  resultCentiseconds: number
  teammates: string[]
}

/** What one sheet of the workbook yielded, and what it passed over. */
export type SheetReport = {
  sheetName: string
  /** Header rows carrying 이름 + 소속 + 기록. Zero means "not a meet sheet". */
  headerRows: number
  /** Rows whose 소속 named EYSL. The denominator for everything below. */
  eyslRows: number
  parsedRows: number
  /** EYSL rows that named no stroke, or no readable, plausible time. */
  skippedRows: number
}

export type ParseResult = {
  fileName: string
  /** The date every row is filed under, read once from the whole document. */
  eventDate: string
  eventName: string
  sheets: SheetReport[]
  /** Deduped, across every sheet. */
  rows: ParsedRow[]
}

export type ParseProgress = {
  phase: 'reading' | 'parsing' | 'done'
  /** 1-based, only meaningful while parsing. */
  sheetIndex: number
  sheetCount: number
  sheetName: string
}
