// Everything in source.ts that can be decided without a network.
//
// fetchWorkbook itself is not tested here: mocking global fetch would assert
// that our mock returns what we told it to. What it actually does with a
// response — refuse a non-200, refuse HTML, refuse an empty body — is
// assertXlsxBytes, and that is tested directly on bytes.

import { describe, expect, it } from 'vitest'
import { assertXlsxBytes, isHttpUrl, resolveSource, sheetExportUrl, SHEET_ID_ENV } from './source.ts'

// INVENTED, and it has to stay invented. The real id is a download link to
// forty people's names and birth dates, requiring no authentication — so it
// lives in .env and nowhere in this repository, tests included. The shape is
// what the code cares about: Google's alphabet, 20+ characters.
const VALID_ID = 'EXAMPLEsheetID0000000000000000000000000000AA'

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values)
}

/** A minimal zip local file header, which is what an .xlsx starts with. */
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00)

describe('sheetExportUrl', () => {
  it('builds the published xlsx export', () => {
    expect(sheetExportUrl(VALID_ID)).toBe(
      `https://docs.google.com/spreadsheets/d/${VALID_ID}/export?format=xlsx`,
    )
  })

  // The reason the id is validated rather than interpolated: these all reach a
  // different document, and the id is edited by hand in .env.
  it.each([
    ['a whole URL', `https://docs.google.com/spreadsheets/d/${VALID_ID}/edit`],
    ['a path escape', '../../../etc/passwd'],
    ['a query appended', `${VALID_ID}?gid=1`],
    ['a second path segment', `${VALID_ID}/export`],
    ['too short', 'abc'],
    ['empty', ''],
  ])('refuses %s', (_label, value) => {
    expect(() => sheetExportUrl(value)).toThrow(/not a Google file id/)
  })
})

describe('resolveSource', () => {
  it('reads a local path when one is given', () => {
    expect(resolveSource('/tmp/club.xlsx', {})).toEqual({
      kind: 'file',
      path: '/tmp/club.xlsx',
      label: 'club.xlsx',
    })
  })

  it.each(['http://example.test/w.xlsx', 'https://example.test/w.xlsx'])(
    'treats %s as a URL',
    (url) => {
      expect(resolveSource(url, {})).toEqual({
        kind: 'url',
        url,
        label: 'published workbook export',
      })
    },
  )

  it('falls back to the sheet id in the environment', () => {
    const source = resolveSource(undefined, { [SHEET_ID_ENV]: VALID_ID })
    expect(source.kind).toBe('url')
    expect(source).toMatchObject({ url: sheetExportUrl(VALID_ID) })
  })

  // The label is written into the generated SQL's header comment, and the id is
  // the credential — so it must not travel there.
  it('never puts the sheet id in the label', () => {
    const source = resolveSource(undefined, { [SHEET_ID_ENV]: VALID_ID })
    expect(source.label).not.toContain(VALID_ID)
  })

  it('prefers an explicit argument over the environment', () => {
    const source = resolveSource('/tmp/club.xlsx', { [SHEET_ID_ENV]: VALID_ID })
    expect(source).toMatchObject({ kind: 'file', path: '/tmp/club.xlsx' })
  })

  it.each([
    ['unset', {}],
    ['empty', { [SHEET_ID_ENV]: '' }],
  ])('explains itself when nothing is given and the id is %s', (_label, env) => {
    expect(() => resolveSource(undefined, env)).toThrow(
      new RegExp(`no workbook given and ${SHEET_ID_ENV} is not set`),
    )
  })
})

describe('assertXlsxBytes', () => {
  it('accepts a zip', () => {
    expect(() => assertXlsxBytes(ZIP, 'the workbook URL')).not.toThrow()
  })

  // An INSERT that matches nothing and a fetch that returns nothing look
  // identical to every later check, so the size is asserted before the shape.
  it('refuses an empty body by size, not by shape', () => {
    expect(() => assertXlsxBytes(new Uint8Array(0), 'the workbook URL')).toThrow(
      /empty body — 0 bytes/,
    )
  })

  it.each([
    ['<!DOCTYPE html><html>…', 'an HTML error page'],
    ['<html><head><title>Sign in', 'a sign-in page'],
    ['  \n<!doctype HTML>', 'HTML behind leading whitespace'],
  ])('refuses %s and says the sheet may not be published', (body) => {
    const html = new TextEncoder().encode(body)
    expect(() => assertXlsxBytes(html, 'the workbook URL')).toThrow(/HTML page rather than a workbook/)
  })

  it('does not echo the fetched body back to the terminal', () => {
    const html = new TextEncoder().encode('<!doctype html><p>SECRET-MARKER</p>')
    expect(() => assertXlsxBytes(html, 'the workbook URL')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('SECRET-MARKER') }),
    )
  })

  it('refuses bytes that are neither zip nor HTML', () => {
    expect(() => assertXlsxBytes(bytes(0x00, 0x01, 0x02, 0x03), 'the workbook URL')).toThrow(
      /are not a zip/,
    )
  })

  // A four-byte prefix check on a three-byte body must not read undefined as a
  // match, which is what noUncheckedIndexedAccess is guarding in source.ts.
  it('refuses a body shorter than the magic number', () => {
    expect(() => assertXlsxBytes(bytes(0x50, 0x4b, 0x03), 'the workbook URL')).toThrow(
      /are not a zip/,
    )
  })
})

describe('isHttpUrl', () => {
  it.each([
    ['https://x.test', true],
    ['http://x.test', true],
    ['/tmp/x.xlsx', false],
    ['x.xlsx', false],
    ['ftp://x.test', false],
  ])('%s -> %s', (value, expected) => {
    expect(isHttpUrl(value)).toBe(expected)
  })
})
