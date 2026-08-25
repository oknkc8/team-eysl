// The SheetJS entry point, ported from index.html:3038-3082
// (extractExcelResults) and 3197-3212 (parseAndImportResultFile).
//
// PDF is not ported. index.html:3083-3153 read result sheets out of pdfjs-dist
// by grouping text runs into lines by y-coordinate and then guessing columns
// from the words on each line — the most fragile path in the legacy parser, and
// the one with no header row to anchor anything to. Every sheet the club
// actually receives is Excel.
//
// Everything here runs in the browser. The file is never uploaded in order to
// parse it: a mis-parse should cost the admin a glance at a table, not leave a
// copy of a meet sheet on a server.

import * as XLSX from 'xlsx'
import type { RecordCategory } from '../api'
import { inferMeetName, parseResultDate } from './fields'
import {
  dedupeParsedRows,
  parseMatrixResults,
  relayCandidatesFromMatrix,
  type MatrixContext,
} from './matrix'
import type { RosterEntry } from './roster'
import type { ParseProgress, ParseResult, ParsedRow, SheetReport } from './types'

export type ParseOptions = {
  fileName: string
  /** Chosen by the admin before the file is picked; every row of the file gets it. */
  category: RecordCategory
  roster: RosterEntry[]
  onProgress?: (progress: ParseProgress) => void
}

const EXCEL_EXTENSIONS = ['xlsx', 'xls']

/** Same spelling as normalizeResultForStorage, kept here on the raw number. */
function secondsToDisplay(sec: number): string {
  return sec < 60
    ? sec.toFixed(2)
    : `${Math.floor(sec / 60)}:${(sec % 60).toFixed(2).padStart(5, '0')}`
}

/**
 * One worksheet as plain text cells.
 *
 * Three passes, and the order matters:
 *
 * 1. The formatted read (`raw: false`) gives what a person sees in each cell.
 * 2. Merged ranges are filled down and right from their top-left value. Excel
 *    stores a merged block as one value plus an empty rectangle, so an event
 *    heading spanning the four rows beneath it would otherwise belong only to
 *    the first of them — and eventContextAbove would attribute the other three
 *    to whatever heading came before.
 * 3. The raw read (`raw: true`) puts times back. Excel stores a time as a
 *    fraction of a day, and the formatted read renders that through the cell's
 *    number format — which on a real meet sheet is often a *date* format, so
 *    33.08 seconds reads as "1/0/00". Both spellings are recovered here: a
 *    genuine Date cell (SheetJS builds those in UTC, so getUTC* is the right
 *    reader) and a bare fraction under 1. An hour or more is not a swim and is
 *    left alone.
 */
export function sheetToMatrix(worksheet: XLSX.WorkSheet): string[][] {
  const formatted = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
    header: 1,
    raw: false,
    defval: '',
  })
  const raw = XLSX.utils.sheet_to_json<unknown[]>(worksheet, { header: 1, raw: true, defval: '' })

  const matrix: string[][] = formatted.map((row) => (row ?? []).map((cell) => String(cell ?? '')))

  for (const merge of worksheet['!merges'] ?? []) {
    const top = String(formatted[merge.s.r]?.[merge.s.c] ?? '')
    for (let rr = merge.s.r; rr <= merge.e.r; rr++) {
      let target = matrix[rr]
      if (!target) {
        target = []
        matrix[rr] = target
      }
      // Only into cells the merge left empty — a value that survived the
      // formatted read is the sheet's own and outranks the block heading.
      for (let cc = merge.s.c; cc <= merge.e.c; cc++) if (!target[cc]) target[cc] = top
    }
  }

  const height = Math.max(matrix.length, raw.length)
  for (let r = 0; r < height; r++) {
    let target = matrix[r]
    if (!target) {
      target = []
      matrix[r] = target
    }
    const rawRow = raw[r]
    const width = Math.max(target.length, rawRow?.length ?? 0)
    for (let c = 0; c < width; c++) {
      const rawVal = rawRow?.[c]
      if (rawVal instanceof Date) {
        const sec =
          rawVal.getUTCHours() * 3600 +
          rawVal.getUTCMinutes() * 60 +
          rawVal.getUTCSeconds() +
          rawVal.getUTCMilliseconds() / 1000
        if (sec > 0 && sec < 3600) target[c] = secondsToDisplay(sec)
      } else if (typeof rawVal === 'number' && Number.isFinite(rawVal) && rawVal > 0 && rawVal < 1) {
        const sec = rawVal * 86400
        if (sec > 0 && sec < 3600) target[c] = secondsToDisplay(sec)
      }
      // Assigning past the end of a row leaves holes. Every reader coerces
      // undefined to '' already, but a dense matrix is what the type promises,
      // and flat() silently drops holes rather than yielding them.
      if (target[c] === undefined) target[c] = ''
    }
  }

  return matrix
}

/** Lets the browser paint between sheets; a large workbook takes real seconds. */
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Every sheet of a workbook, walked twice — once for the per-swimmer tables and
 * once for relay blocks — and deduped at the end.
 *
 * The date and the meet name are read per sheet from that sheet's own text,
 * falling back to the file name, exactly as the legacy did. The result carries
 * the first sheet's reading, which is what the screen shows above the table.
 */
export async function parseWorkbook(
  data: ArrayBuffer,
  options: ParseOptions,
): Promise<ParseResult> {
  const workbook = XLSX.read(data, { type: 'array', cellDates: true })

  const sheets: SheetReport[] = []
  const all: ParsedRow[] = []
  const fromFileName = parseResultDate(options.fileName)
  let eventDate = fromFileName
  let eventName = inferMeetName('', options.fileName)

  for (let i = 0; i < workbook.SheetNames.length; i++) {
    const sheetName = workbook.SheetNames[i]
    if (!sheetName) continue
    options.onProgress?.({
      phase: 'parsing',
      sheetIndex: i + 1,
      sheetCount: workbook.SheetNames.length,
      sheetName,
    })
    await yieldToBrowser()

    const worksheet = workbook.Sheets[sheetName]
    if (!worksheet) continue

    const matrix = sheetToMatrix(worksheet)
    const documentText = matrix.flat().join(' ')
    const context: MatrixContext = {
      sheetName,
      eventDate: parseResultDate(documentText, fromFileName),
      eventName: inferMeetName(documentText, options.fileName, sheetName),
      category: options.category,
      roster: options.roster,
    }
    if (i === 0) {
      eventDate = context.eventDate
      eventName = context.eventName
    }

    const walk = parseMatrixResults(matrix, context)
    const relays = relayCandidatesFromMatrix(matrix, context)
    all.push(...walk.rows, ...relays)

    sheets.push({
      sheetName,
      headerRows: walk.headerRows,
      eyslRows: walk.eyslRows,
      parsedRows: walk.rows.length + relays.length,
      skippedRows: walk.skippedRows,
    })
  }

  options.onProgress?.({
    phase: 'done',
    sheetIndex: workbook.SheetNames.length,
    sheetCount: workbook.SheetNames.length,
    sheetName: '',
  })

  return { fileName: options.fileName, eventDate, eventName, sheets, rows: dedupeParsedRows(all) }
}

/**
 * What the screen calls: an Excel file in, candidate rows out.
 *
 * The extension check is the legacy's, minus its PDF branch. A file this cannot
 * read fails loudly here rather than parsing to zero rows, which would read as
 * "no EYSL swimmers in this meet".
 */
export async function parseResultFile(
  file: File,
  options: Omit<ParseOptions, 'fileName'>,
): Promise<ParseResult> {
  const ext = (file.name.split('.').pop() || '').toLowerCase()
  if (!EXCEL_EXTENSIONS.includes(ext)) throw new Error('엑셀 파일(.xlsx, .xls)만 읽을 수 있습니다.')

  options.onProgress?.({ phase: 'reading', sheetIndex: 0, sheetCount: 0, sheetName: '' })
  const data = await file.arrayBuffer()
  return parseWorkbook(data, { ...options, fileName: file.name })
}
