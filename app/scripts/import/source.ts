// Where the workbook comes from: a local file, or the published sheet.
//
// parse.ts already takes bytes rather than a path (`parseClubWorkbook(data:
// ArrayBuffer | Uint8Array, …)`), so fetching instead of reading needs nothing
// from the parser. This module is only the part that decides which of the two
// happened, and refuses everything that is neither.
//
// THE SHEET ID IS NOT IN THIS FILE, AND THAT IS DELIBERATE.
//
// The published export URL takes no credentials — anybody holding the id can
// download the workbook, which carries forty real people's names, birth dates
// and phone numbers. So for this repository the id IS the credential, and this
// repository is public. It lives in ./.env beside SUPABASE_DB_PASSWORD, which
// _env.sh already sources, and .env.example documents its shape and nothing
// else. Re-pointing at a new sheet is one line of .env, which is what "no code
// change" was asking for; hardcoding the current id as a default would have
// published the workbook to every reader of the repo instead.
//
// If that trade is ever revisited, revisit it here — one constant, one comment,
// one place to read the reasoning.

/** The .env variable naming the published workbook. */
export const SHEET_ID_ENV = 'EYSL_WORKBOOK_SHEET_ID'

/**
 * Google's file ids are drawn from this alphabet and nothing else.
 *
 * Validated rather than interpolated blind: a value carrying `/`, `?` or `..`
 * re-points the fetch at a different document, and the whole reason the id is
 * configurable is that somebody will one day edit it by hand.
 */
const SHEET_ID_RE = /^[A-Za-z0-9_-]{20,}$/

/** The published-to-web xlsx export of a Google Sheet. */
export function sheetExportUrl(sheetId: string): string {
  if (!SHEET_ID_RE.test(sheetId)) {
    throw new Error(
      `${SHEET_ID_ENV} is not a Google file id: ${JSON.stringify(sheetId)}. ` +
        'Expected 20+ characters of [A-Za-z0-9_-] — the segment between /d/ and ' +
        '/edit in the sheet URL, not the whole URL.',
    )
  }
  return `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=xlsx`
}

export type WorkbookSource =
  /** Read with readFileSync, exactly as before. */
  | { kind: 'file'; path: string; label: string }
  /** Fetched. `label` never carries the id — see the header. */
  | { kind: 'url'; url: string; label: string }

export function isHttpUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://')
}

/**
 * Which workbook this run is about.
 *
 * A positional argument wins, so an ad-hoc file or a one-off URL still works
 * unchanged. With no argument the published sheet named by .env is the source,
 * which is what the scheduled run uses — it has no path to pass.
 */
export function resolveSource(
  arg: string | undefined,
  env: Record<string, string | undefined>,
): WorkbookSource {
  if (arg !== undefined && arg !== '') {
    if (isHttpUrl(arg)) return { kind: 'url', url: arg, label: 'published workbook export' }
    return { kind: 'file', path: arg, label: arg.split('/').pop() ?? arg }
  }

  const sheetId = env[SHEET_ID_ENV]
  if (sheetId === undefined || sheetId === '') {
    throw new Error(
      `no workbook given and ${SHEET_ID_ENV} is not set.\n` +
        `  Pass a path or a URL, or set ${SHEET_ID_ENV} in ./.env (see .env.example)\n` +
        '  and run through scripts/import-club-workbook.sh, which sources it.',
    )
  }
  return {
    kind: 'url',
    url: sheetExportUrl(sheetId),
    // Names what produced the rows without naming the id, because this string
    // is written into the generated SQL's header comment.
    label: `published workbook export (${SHEET_ID_ENV})`,
  }
}

/**
 * Refuses anything that is not a zip, which is what an .xlsx is.
 *
 * A sheet that is not published, or an id that is wrong, answers with an HTML
 * sign-in or error page. Handing that to SheetJS produces a failure deep inside
 * the reader that reads as a corrupt workbook rather than as a wrong URL, so
 * the shape is checked here where the message can say what actually happened.
 *
 * The empty check is first on purpose: a zero-byte body is the one input that
 * makes every later check pass by having nothing to disagree with.
 */
export function assertXlsxBytes(bytes: Uint8Array, origin: string): void {
  if (bytes.byteLength === 0) {
    throw new Error(`${origin} returned an empty body — 0 bytes, nothing to parse.`)
  }
  // PK\x03\x04 is a local file header; \x05\x06 and \x07\x08 are the empty and
  // spanned variants. An .xlsx always has entries, but all three say "zip".
  const zip =
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
      (bytes[2] === 0x05 && bytes[3] === 0x06) ||
      (bytes[2] === 0x07 && bytes[3] === 0x08))
  if (zip) return

  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, 64))
    .trimStart()
    .toLowerCase()
  // Deliberately not echoing the body. It is somebody else's error page, and
  // this is the one place in the importer that could put arbitrary fetched text
  // on a terminal somebody is about to read as if the importer had said it.
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    throw new Error(
      `${origin} returned an HTML page rather than a workbook (${bytes.byteLength} bytes).\n` +
        '  That is what Google answers when the sheet is not published to the web,\n' +
        `  or when ${SHEET_ID_ENV} names a document this machine cannot read.\n` +
        '  File → Share → Publish to web, then retry.',
    )
  }
  throw new Error(
    `${origin} returned ${bytes.byteLength} bytes that are not a zip, so not an .xlsx.`,
  )
}

/**
 * The workbook's bytes, or a message saying why not.
 *
 * Redirects are followed — the export URL is one — and the body is copied into
 * a Uint8Array of its own for the same reason run.ts copies readFileSync's
 * Buffer: the reader must never be handed a view onto anything larger than the
 * file itself.
 */
export async function fetchWorkbook(url: string): Promise<Uint8Array> {
  let res: Response
  try {
    res = await fetch(url, { redirect: 'follow' })
  } catch (cause) {
    throw new Error(`could not reach the workbook URL: ${(cause as Error).message}`, { cause })
  }
  if (!res.ok) {
    throw new Error(
      `the workbook URL answered ${res.status} ${res.statusText}.\n` +
        '  401/403 means the sheet is not published to the web; 404 means the id is wrong.',
    )
  }
  const bytes = new Uint8Array(await res.arrayBuffer())
  assertXlsxBytes(bytes, 'the workbook URL')
  return bytes
}
