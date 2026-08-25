// result_centiseconds is the canonical column and the only thing anything
// compares — personal bests, deltas, and the dedup index in 0004 all read the
// number. result_display is a copy of what the parser (or the person typing)
// saw on the sheet, kept for provenance rather than for arithmetic.
//
// This module is the single place that turns the number back into the string a
// swimmer expects, and the only place that turns a typed string into the
// number. Keeping both directions together is what makes the round trip
// testable as one property instead of two coincidences.

const CS_PER_SECOND = 100
const CS_PER_MINUTE = 60 * CS_PER_SECOND

const pad = (n: number) => String(n).padStart(2, '0')

// Number.isInteger is the whole guard: it refuses NaN, Infinity and 33.5 alike.
// A length or falsy check does not — Number('a') is NaN, not undefined, and a
// helper that only counted characters is how a previous attempt printed
// 'NaN-NaN-NaN' into a record card.
const isCentiseconds = (value: number) => Number.isInteger(value) && value >= 0

/**
 * 3308 → '33.08', 6000 → '1:00.00', 6532 → '1:05.32'.
 *
 * Returns null for anything that is not a whole, non-negative count of
 * centiseconds, so a caller has to decide what to show instead rather than
 * being handed a plausible-looking string built from NaN.
 *
 * Minutes are never carried into hours. A pool time of an hour reads
 * '60:00.00', which is unambiguous, where '1:00:00.00' would collide with the
 * m:ss.cc shape every other row on the screen uses.
 */
export function formatCentiseconds(centiseconds: number): string | null {
  if (!isCentiseconds(centiseconds)) return null

  const minutes = Math.floor(centiseconds / CS_PER_MINUTE)
  const seconds = Math.floor((centiseconds % CS_PER_MINUTE) / CS_PER_SECOND)
  const hundredths = centiseconds % CS_PER_SECOND

  // Under a minute a swimmer writes '33.08', never '0:33.08'. From exactly
  // 60.00s the minute has to appear, or 6000 and 0 would both read '0.00'.
  return minutes === 0
    ? `${seconds}.${pad(hundredths)}`
    : `${minutes}:${pad(seconds)}.${pad(hundredths)}`
}

// Anchored and deliberately narrow: optional minutes, one or two seconds
// digits, and one or two fractional digits.
//
// Three fractional digits are refused rather than rounded. A sheet reading
// '33.081' is a sheet this app has misunderstood, and quietly dropping the last
// digit would file the swim under a time nobody swam — which the dedup index in
// 0004 would then accept as a distinct result.
const SWIM_TIME = /^(?:(\d{1,3}):)?(\d{1,2})(?:\.(\d{1,2}))?$/

/**
 * The inverse of formatCentiseconds: '33.08' → 3308, '1:05.32' → 6532.
 *
 * Returns null for anything unreadable, never NaN. A caller that fed NaN into
 * upsert_record would be stopped by the result_centiseconds > 0 CHECK, but only
 * after a round trip and with a Postgres error where a field-level message
 * belongs.
 */
export function parseSwimTime(input: string): number | null {
  const match = SWIM_TIME.exec(input.trim())
  if (!match) return null

  const [, minutePart, secondPart, fractionPart] = match
  // Guaranteed by the pattern; the check is what tells the compiler so, since a
  // capture group is typed as possibly absent.
  if (secondPart === undefined) return null

  const minutes = minutePart === undefined ? 0 : Number(minutePart)
  const seconds = Number(secondPart)
  // '33.8' is eight tenths, not eight hundredths — pad on the right.
  const hundredths = fractionPart === undefined ? 0 : Number(fractionPart.padEnd(2, '0'))

  // Only meaningful once a minute has actually been written down. '60.00' is a
  // plain sixty seconds and normalises to 1:00.00 on the way back out, but
  // '1:60.00' is a sheet nobody can read a time off.
  if (minutePart !== undefined && seconds >= 60) return null

  return minutes * CS_PER_MINUTE + seconds * CS_PER_SECOND + hundredths
}

/**
 * A signed gap between two swims: -57 → '-0.57', 124 → '+1.24', 0 → '±0.00'.
 *
 * Only the text. The screen colours on the sign of the number the caller
 * already holds, so no colour decision is encoded in this string.
 */
export function formatDelta(centiseconds: number): string | null {
  if (!Number.isInteger(centiseconds)) return null

  const magnitude = formatCentiseconds(Math.abs(centiseconds))
  if (magnitude === null) return null

  if (centiseconds === 0) return `±${magnitude}`
  return `${centiseconds < 0 ? '-' : '+'}${magnitude}`
}
