// CLI: club workbook in, idempotent SQL out.
//
//   node scripts/import/run.ts <workbook.xlsx> [--year=2026] [--summary]
//
// SQL goes to stdout so it can be piped into psql; the summary and every
// warning go to stderr so the two never mix. --summary parses and reports
// without emitting SQL, which is the safe way to look at what a workbook holds.
//
// Run through scripts/import-club-workbook.sh rather than by hand: that wrapper
// sources _env.sh, whose project allowlist is what keeps club data out of the
// president's live database.
//
// Nothing here writes a file. The generated SQL carries real names and birth
// dates, and this repository is public — so it exists only as a pipe.

import { readFileSync } from 'node:fs'
import { parseClubWorkbook } from './parse.ts'
import { dedupeRecords, toSql } from './toSql.ts'

function main(argv: string[]): number {
  const args = argv.slice(2)
  const path = args.find((a) => !a.startsWith('--'))
  if (!path) {
    process.stderr.write(
      'usage: node scripts/import/run.ts <workbook.xlsx> [--year=2026] [--summary]\n',
    )
    return 2
  }

  const yearArg = args.find((a) => a.startsWith('--year='))
  const attendanceYear = yearArg ? Number(yearArg.slice('--year='.length)) : undefined
  if (attendanceYear !== undefined && !Number.isInteger(attendanceYear)) {
    process.stderr.write(`--year must be a whole number, got ${JSON.stringify(yearArg)}\n`)
    return 2
  }

  const file = readFileSync(path)
  // Hand XLSX its own bytes rather than the pooled Node Buffer: readFileSync can
  // return a view into a shared ArrayBuffer, and passing that whole buffer would
  // give the reader bytes belonging to somebody else's allocation.
  const bytes = new Uint8Array(file.byteLength)
  bytes.set(file)

  const data = parseClubWorkbook(
    bytes,
    attendanceYear === undefined ? {} : { attendanceYear },
  )

  const present = data.attendance.filter((a) => a.status === 'present').length
  const late = data.attendance.length - present
  const { rows, dropped } = dedupeRecords(data.records)

  const byCategory = new Map<string, number>()
  for (const r of rows) byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + 1)

  const lines = [
    '',
    '== parsed ==',
    `members      ${data.members.length}`,
    `trainings    ${data.trainings.length}`,
    `attendance   ${data.attendance.length}  (present ${present}, late ${late})`,
    `meets        ${data.meets.length}`,
    `records      ${rows.length}` +
      (dropped.length > 0 ? `  (${dropped.length} collapsed on records_dedup_uq)` : ''),
    ...[...byCategory].sort().map(([category, n]) => `  ${category}: ${n}`),
    // Parsed and deliberately not loaded — see the note on ClubData.relays.
    `relays       ${data.relays.length}  (parsed, NOT loaded: records.member_id is NOT NULL,`,
    '                          the 단체전 block names no swimmers)',
  ]

  if (data.warnings.length > 0) {
    lines.push('', `== ${data.warnings.length} warning(s) ==`)
    for (const w of data.warnings) lines.push(`  ${w}`)
  }
  lines.push('', '')
  process.stderr.write(lines.join('\n'))

  if (!args.includes('--summary')) {
    process.stdout.write(toSql(data, { sourceLabel: path.split('/').pop() ?? path }))
  }

  return 0
}

process.exitCode = main(process.argv)
