import type { ReactNode } from 'react'

// Loading, empty and failed used to be hand-rolled in every screen, and the
// legacy app printed the same sentence for all three — a first-time visitor read
// "등록된 공지가 없습니다" while the fetch was still in flight and again when it
// failed. Here the three branches are structurally different, not just worded
// differently: shimmer, icon+text, icon+text+retry.

// A structural subset of UseQueryResult, so callers are not forced to hand over
// the full object and a test can pass a plain literal.
export type AsyncQuery<T> = {
  data: T | undefined
  isPending: boolean
  isError: boolean
  refetch: () => void
}

type Props<T> = {
  query: AsyncQuery<T>
  children: (data: T) => ReactNode
  /** Data arrived but there is nothing to show — a different state from "still loading". */
  isEmpty?: (data: T) => boolean
  /** Replaces the default shimmer, e.g. `<Shimmer rows={5} />`. */
  loading?: ReactNode
  empty?: ReactNode
  error?: ReactNode
}

export function AsyncSection<T>({
  query,
  children,
  isEmpty,
  loading,
  empty = '내용이 없습니다',
  error = '불러오지 못했습니다',
}: Props<T>) {
  if (query.isPending) return <>{loading ?? <Shimmer />}</>

  // `data === undefined` outside the pending state means the query settled with
  // nothing usable; treat it as a failure rather than silently as "empty".
  if (query.isError || query.data === undefined)
    return <ErrorState message={error} onRetry={() => query.refetch()} />

  if (isEmpty?.(query.data)) return <EmptyState message={empty} />

  return <>{children(query.data)}</>
}

// The shimmer's keyframes used to live in a <style> tag here, because inline
// styles cannot express @keyframes or prefers-reduced-motion. Now that the app
// has a stylesheet, both rules sit in components.css with everything else and
// this file carries no CSS at all.
export function Shimmer({ rows = 3 }: { rows?: number }) {
  return (
    <div className="shimmer" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="card">
          <div className="shimmer-bar" style={{ width: '44%' }} />
          <div className="shimmer-bar" style={{ width: '72%' }} />
        </div>
      ))}
      <span className="sr-only">불러오는 중</span>
    </div>
  )
}

function EmptyState({ message }: { message: ReactNode }) {
  return (
    <div className="empty">
      <EmptyIcon />
      <p>{message}</p>
    </div>
  )
}

function ErrorState({ message, onRetry }: { message: ReactNode; onRetry: () => void }) {
  return (
    <div className="errorState" role="alert">
      <ErrorIcon />
      <p>{message}</p>
      <button onClick={onRetry} className="btn">
        다시 시도
      </button>
    </div>
  )
}

// Both icons stroke themselves in currentColor, so each one takes the tone of
// the state it sits in — grey inside .empty, danger red inside .errorState —
// and there is no second place to update when either colour moves.
function EmptyIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="3" width="16" height="18" rx="3" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M8 9h8M8 13h8M8 17h5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  )
}

function ErrorIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 7v6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="16.4" r="1.1" fill="currentColor" />
    </svg>
  )
}
