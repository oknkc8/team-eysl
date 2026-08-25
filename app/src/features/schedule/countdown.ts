const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * Milliseconds left before `iso`, floored at 0.
 *
 * A null or unparseable expiry answers 0 — "already expired". An offer whose
 * deadline cannot be read is not an offer worth acting on, and the opposite
 * default would leave the 수락 button live forever.
 */
export function msUntil(iso: string | null | undefined, now: Date = new Date()): number {
  if (!iso) return 0
  const target = new Date(iso).getTime()
  if (Number.isNaN(target)) return 0
  return Math.max(0, target - now.getTime())
}

/**
 * "11시간 42분 남음" / "4분 09초 남음", or null once it has run out.
 *
 * Null rather than "만료됨" on purpose: the screen has to say more than the
 * clock at that point — the server has not yet been asked whether the offer
 * moved on — so the caller owns that sentence.
 */
export function formatCountdown(msRemaining: number): string | null {
  if (!Number.isFinite(msRemaining) || msRemaining <= 0) return null

  const days = Math.floor(msRemaining / DAY)
  const hours = Math.floor((msRemaining % DAY) / HOUR)
  const minutes = Math.floor((msRemaining % HOUR) / MINUTE)
  const seconds = Math.floor((msRemaining % MINUTE) / SECOND)

  if (days > 0) return `${days}일 ${hours}시간 남음`
  if (hours > 0) return `${hours}시간 ${minutes}분 남음`
  // Seconds are zero-padded only in the last minutes, where the digits change
  // fast enough that a jittering width is distracting.
  if (minutes > 0) return `${minutes}분 ${String(seconds).padStart(2, '0')}초 남음`
  return `${seconds}초 남음`
}
