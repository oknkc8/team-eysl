// Time reading and sanity checking, ported from index.html:2809-2818
// (detectResultTime), 2952-2976 (looksLikeSwimTimeValue, plausibleSwimTime),
// 3021-3034 (candidateTimeFromCells) and 3361-3382 (normalizeResultForStorage,
// recordSeconds — renamed resultSeconds here, since `record` means a filed row
// everywhere else in this app).
//
// The plausibility windows are the load-bearing part of the whole port. They
// are what stops a lane number, a rank, a body-length count or a fee column
// from being filed as somebody's personal best. Ported number for number.

import { normResultText } from './fields'

/**
 * Pulls the first thing shaped like a time out of a string.
 *
 * The third pattern (33초08) only ever fired on the PDF path, which is not
 * ported — every Excel caller gates on looksLikeSwimTimeValue first, and that
 * rejects the 초 spelling. Kept anyway: dropping a branch is a behaviour change,
 * and this one costs nothing.
 */
export function detectResultTime(text: unknown): string {
  const s = String(text ?? '').replace(/,/g, '.')
  const patterns = [
    /\b\d{1,2}:\d{2}(?:\.\d{1,3})?\b/,
    /\b\d{1,3}\.\d{1,3}\b/,
    /\b\d{1,3}초\s*\d{1,3}\b/,
  ]
  for (const p of patterns) {
    const m = s.match(p)
    if (m) return m[0].replace('초', '.')
  }
  return ''
}

/**
 * Whether a whole cell *is* a time, as opposed to containing one.
 *
 * Anchored on purpose, and stricter than detectResultTime: '3' and '27' are
 * refused because a bare integer on a meet sheet is a rank or a lane, and
 * '7.5' is refused because a real swim is written with two seconds digits.
 */
export function looksLikeSwimTimeValue(v: unknown): boolean {
  const s = normResultText(v).replace(/,/g, '.')
  if (!s) return false
  if (/^\d{1,2}:\d{2}(?:\.\d{1,2})?$/.test(s)) return true
  if (/^\d{2,3}\.\d{1,2}$/.test(s)) return true
  return false
}

/**
 * Seconds from any of the spellings above, or null.
 *
 * The last branch is a deliberate catch-all: strip everything but digits and a
 * dot, then take the number. It is why '05.10' reads as 5.1 seconds and is then
 * refused by the 50m window rather than filed as a five-second fifty.
 */
export function resultSeconds(v: unknown): number | null {
  if (v == null) return null
  const s = String(v).trim().replace(/,/g, '.')
  if (!s) return null
  let m = s.match(/^(\d+):(\d{1,2})(?:\.(\d{1,3}))?$/)
  if (m) {
    const min = Number(m[1])
    const sec = Number(m[2])
    const frac = m[3] ? Number(`0.${m[3]}`) : 0
    return Number.isFinite(min) && Number.isFinite(sec) ? min * 60 + sec + frac : null
  }
  m = s.match(/^(\d{1,4})초\s*(\d{1,3})?$/)
  if (m) {
    const sec = Number(m[1])
    const frac = m[2] ? Number(`0.${m[2]}`) : 0
    return sec + frac
  }
  const n = Number(s.replace(/[^\d.]/g, ''))
  return Number.isFinite(n) ? n : null
}

/**
 * The one spelling a parsed time is written in: '33.08' under a minute,
 * '1:05.32' over one. '' when the input is not a time at all.
 *
 * This is what records.result_display gets, and parseSwimTime() in ../time.ts
 * turns the same string into the centiseconds every comparison actually reads.
 */
export function normalizeResultForStorage(v: unknown): string {
  const sec = resultSeconds(v)
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return ''
  return sec < 60
    ? sec.toFixed(2)
    : `${Math.floor(sec / 60)}:${(sec % 60).toFixed(2).padStart(5, '0')}`
}

/**
 * Whether a time is a possible swim of this distance.
 *
 * Per-distance windows, wide enough for a beginner and narrow enough to refuse
 * a number that came from the wrong column. A relay leg is checked far more
 * loosely because the block walk cannot always tell which distance it is
 * looking at; an unknown distance falls through to 10s–30min, which catches
 * almost nothing and is why the caller also insists on a stroke.
 */
export function plausibleSwimTime(
  result: string,
  distance: number | null = 0,
  relay = false,
): boolean {
  const sec = resultSeconds(result)
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return false
  const d = Number(distance || 0)
  if (relay) {
    if (d >= 100 && sec < 20) return false
    if (d >= 200 && sec < 40) return false
    return sec < 1800
  }
  if (d === 25) return sec >= 7 && sec < 120
  if (d === 50) return sec >= 15 && sec < 180
  if (d === 100) return sec >= 30 && sec < 360
  if (d === 200) return sec >= 60 && sec < 720
  if (d === 400) return sec >= 120 && sec < 1400
  if (d === 800) return sec >= 240 && sec < 2400
  if (d === 1500) return sec >= 420 && sec < 4200
  return sec >= 10 && sec < 1800
}

/**
 * The best time-shaped cell in a group, when there is no 기록 column to read.
 *
 * The sort is the whole point: a time ending .00 is usually the sheet's rounded
 * "official" column sitting beside the timed one, so a reading with real
 * hundredths wins. The legacy learned this after filing 33.00 for a 33.08 swim.
 */
export function candidateTimeFromCells(
  cells: string[],
  distance: number | null = 0,
  relay = false,
): string {
  const found: string[] = []
  for (const cell of cells) {
    const v = normResultText(cell)
    if (!looksLikeSwimTimeValue(v)) continue
    const t = detectResultTime(v)
    if (t && plausibleSwimTime(t, distance, relay)) found.push(t)
  }
  found.sort((a, b) => {
    const ap = /\.00$/.test(a) ? 1 : 0
    const bp = /\.00$/.test(b) ? 1 : 0
    return ap - bp
  })
  return found[0] || ''
}
