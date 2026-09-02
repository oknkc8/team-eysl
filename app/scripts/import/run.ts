// CLI: club workbook in, idempotent SQL out.
//
//   node scripts/import/run.ts [<workbook.xlsx>|<url>] [--year=2026] [--summary]
//
// With no argument the source is the published sheet named by
// EYSL_WORKBOOK_SHEET_ID in ./.env — see source.ts for why the id lives there
// and not in this repository.
//
// SQL goes to stdout so it can be piped into psql; the summary and every
// warning go to stderr so the two never mix. --summary parses and reports
// without emitting SQL, which is the safe way to look at what a workbook holds.
//
// Run through scripts/import-club-workbook.sh rather than by hand: that wrapper
// sources _env.sh, whose project allowlist is what keeps club data out of the
// president's live database, and whose .env supplies the sheet id.
//
// Nothing here writes a file. The generated SQL carries real names and birth
// dates, and this repository is public — so it exists only as a pipe.

import { readFileSync } from 'node:fs'
import { parseClubWorkbook } from './parse.ts'
import { fetchWorkbook, resolveSource } from './source.ts'
import { dedupeRecords, toSql } from './toSql.ts'

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2)
  const positional = args.find((a) => !a.startsWith('--'))

  let source
  try {
    source = resolveSource(positional, process.env)
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`)
    process.stderr.write(
      'usage: node scripts/import/run.ts [<workbook.xlsx>|<url>] [--year=2026] [--summary]\n',
    )
    return 2
  }

  const yearArg = args.find((a) => a.startsWith('--year='))
  const attendanceYear = yearArg ? Number(yearArg.slice('--year='.length)) : undefined
  if (attendanceYear !== undefined && !Number.isInteger(attendanceYear)) {
    process.stderr.write(`--year must be a whole number, got ${JSON.stringify(yearArg)}\n`)
    return 2
  }

  let bytes: Uint8Array
  if (source.kind === 'url') {
    // fetchWorkbook already copies, and refuses a non-200 or a body that is not
    // a zip — a Google error page is HTML, and SheetJS given HTML fails as
    // "corrupt workbook" rather than as "wrong URL".
    process.stderr.write(`fetching ${source.label}…\n`)
    bytes = await fetchWorkbook(source.url)
  } else {
    const file = readFileSync(source.path)
    // Hand XLSX its own bytes rather than the pooled Node Buffer: readFileSync can
    // return a view into a shared ArrayBuffer, and passing that whole buffer would
    // give the reader bytes belonging to somebody else's allocation.
    bytes = new Uint8Array(file.byteLength)
    bytes.set(file)
  }

  const data = parseClubWorkbook(
    bytes,
    attendanceYear === undefined ? {} : { attendanceYear },
  )

  const present = data.attendance.filter((a) => a.status === 'present').length
  const late = data.attendance.length - present
  // Throws rather than returning drops now: a collision that survives the
  // post-0031 key means the same swim appears twice, which somebody has to look
  // at. See DuplicateRecordError.
  const { rows } = dedupeRecords(data.records)

  const byCategory = new Map<string, number>()
  for (const r of rows) byCategory.set(r.category, (byCategory.get(r.category) ?? 0) + 1)

  const lines = [
    '',
    '== parsed ==',
    `members      ${data.members.length}`,
    `trainings    ${data.trainings.length}`,
    `attendance   ${data.attendance.length}  (present ${present}, late ${late})`,
    `meets        ${data.meets.length}`,
    // Raw as well as stored. Reporting only the stored figure is what let a
    // cross-category collision look like a clean import: a count of rows that
    // arrived says nothing about rows that should have.
    `records      ${rows.length} stored, ${data.records.length} parsed` +
      (data.records.length === rows.length ? '' : '  <- MISMATCH, investigate'),
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
    process.stdout.write(toSql(data, { sourceLabel: source.label }))
  }

  return 0
}

// Top-level await rather than .then(): a throw inside main — DuplicateRecordError,
// a refused fetch — has to keep reaching stderr as a stack and a non-zero exit,
// and a rejected promise assigned to process.exitCode would exit 0 with the
// SQL half-written.
process.exitCode = await main(process.argv)
