// Field heuristics, ported from the legacy single-file app: index.html:2786-2787
// (normalisation), 2788-2795 (date), 2796-2808 (stroke, distance), 2839-2846
// (relay type), 2977-2989 (meet name), 3013-3020 (names).
//
// These are copied across as literally as TypeScript allows. Every regex here
// was tuned against real Korean meet sheets over many iterations, so a quirk
// that looks wrong probably encodes a sheet that broke the parser once. Nothing
// in this file is "improved" on the way over — a rewrite would silently change
// which sheets parse, and a mis-parsed time is worse than a missing one.

/** Collapses runs of whitespace and trims. Every cell passes through this. */
export function normResultText(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Header-cell identity: case-folded with punctuation and spacing removed. */
export function normalizedKey(value: unknown): string {
  return normResultText(value)
    .toLowerCase()
    .replace(/[\s_\-./()[\]{}]/g, '')
}

/**
 * The meet date, read out of whatever text was handed over.
 *
 * Two shapes: 2026.05.17 / 2026-05-17 / 2026년 5월 17 and the bare 20260517 a
 * file name usually carries. Falls back to the caller's fallback and finally to
 * today, which is what the legacy did — a sheet with no readable date still
 * files its results rather than dropping them.
 */
export function parseResultDate(text: string, fallback = ''): string {
  const s = String(text || '')
  let m = s.match(/(20\d{2})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/)
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`
  m = s.match(/(20\d{2})(\d{2})(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  return fallback || new Date().toISOString().slice(0, 10)
}

/** '' when no stroke is named — the caller treats that as "do not file this row". */
export function detectStroke(text: unknown): string {
  const s = String(text ?? '').replace(/\s/g, '')
  if (/자유형|freestyle|free/i.test(s)) return '자유형'
  if (/배영|backstroke|back/i.test(s)) return '배영'
  if (/평영|breaststroke|breast/i.test(s)) return '평영'
  if (/접영|butterfly|fly/i.test(s)) return '접영'
  return ''
}

/**
 * A pool distance, or null.
 *
 * Deliberately a closed set: any other number on the row is a lane, a rank or a
 * bib, and treating one of those as a distance would put the row through the
 * wrong plausibility window in swimTime.ts.
 */
export function detectDistance(text: unknown): number | null {
  const s = String(text ?? '')
  const m = s.match(/(?:^|\D)(25|50|100|200|400|800|1500)\s*(?:m|M|미터)?(?:\D|$)/)
  return m ? Number(m[1]) : null
}

/** Longest label first, so 혼성혼계영 is not read as 계영. */
export function detectRelayType(text: unknown): string {
  const s = String(text ?? '').replace(/\s/g, '')
  if (/혼성혼계영|mixedmedleyrelay/i.test(s)) return '혼성혼계영'
  if (/혼성계영|mixedfreestylerelay/i.test(s)) return '혼성계영'
  if (/혼계영|medleyrelay/i.test(s)) return '혼계영'
  if (/계영|freestylerelay|relay/i.test(s)) return '계영'
  return ''
}

/**
 * The meet's name: the file name if it carries one, otherwise a line of the
 * sheet that reads like a title.
 *
 * The replacements are a list of things real uploads have had stuck to them —
 * KakaoTalk's TalkFile_ prefix, a (결과집계) suffix, a trailing 결과지/기록지.
 */
export function inferMeetName(documentText: string, fileName: string, sheetName = ''): string {
  const raw = String(fileName || '').replace(/\.(xlsx?|pdf)$/i, '')
  const cleaned = raw
    .replace(/^TalkFile_?/i, '')
    .replace(/\(결과집계\)/g, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s*(경기\s*기록|최종\s*결과|최종|기록지|결과지|결과)\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length >= 4) return cleaned
  const text = String(documentText || '')
  const candidates = text
    .split(/\s{2,}|\n/)
    .map((x) => x.trim())
    .filter((x) => /대회|배|선수권|챔피언십/i.test(x) && x.length < 100)
  return candidates[0] || sheetName || '수영대회'
}

/**
 * Cells that look like a person's name: two to four Hangul syllables, minus a
 * blacklist of division words that have the same shape.
 *
 * Note what the blacklist does not cover: 순위, 소속 and 기록 are two-syllable
 * header words and this returns them as names too. That wart is ported as-is —
 * see the note on relay teammates in matrix.ts.
 */
export function genericNamesFromCells(cells: string[]): string[] {
  const names: string[] = []
  for (const c of cells) {
    const s = normResultText(c)
    if (/^[가-힣]{2,4}$/.test(s) && !/^(성인|남자|여자|일반|초등|중등|고등|대학|계영|혼계영)$/.test(s))
      names.push(s)
  }
  return [...new Set(names)]
}
