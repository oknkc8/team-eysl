// What the upload screen is allowed to know about the parser: a file goes in,
// candidate rows come out, and a name that could not be resolved is a state on
// a row rather than a row that was thrown away.
//
// The heuristics themselves stay behind this barrel. They are ported from a
// single-file app and tuned against sheets nobody in this repo has, so the
// fewer callers reach past this line, the fewer places have to be re-checked
// when one of them turns out to be wrong.

export { parseResultFile, parseWorkbook, sheetToMatrix, type ParseOptions } from './workbook'
export { matchRealName, type MatchState, type RosterEntry } from './roster'
export { EYSL_RESULT_TEAM } from './matrix'
export type { ParseProgress, ParseResult, ParsedRow, SheetReport } from './types'
