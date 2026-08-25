const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// Anything older than a week reads better as a plain date than as "37일 전".
const RELATIVE_WINDOW = 7 * DAY

/**
 * "방금 전" / "12분 전" / "3시간 전" / "5일 전", falling back to 2026.08.25.
 * `now` is injectable so the behaviour is testable without freezing the clock.
 */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const then = new Date(iso)
  const ts = then.getTime()
  if (Number.isNaN(ts)) return ''

  // A timestamp in the future means the two clocks disagree, not that something
  // happened later; "방금 전" is the least wrong thing to say.
  const elapsed = Math.max(0, now.getTime() - ts)

  if (elapsed < MINUTE) return '방금 전'
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}분 전`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}시간 전`
  if (elapsed < RELATIVE_WINDOW) return `${Math.floor(elapsed / DAY)}일 전`

  const pad = (n: number) => String(n).padStart(2, '0')
  return `${then.getFullYear()}.${pad(then.getMonth() + 1)}.${pad(then.getDate())}`
}
