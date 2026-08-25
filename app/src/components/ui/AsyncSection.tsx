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

const CARD = {
  padding: 14,
  border: '1px solid #e1e5ea',
  borderRadius: 18,
  background: '#fff',
} as const

// Keyframes and prefers-reduced-motion cannot be expressed as inline styles, so
// this one rule set lives in a <style> tag. React 19 hoists it and dedupes by
// href, so rendering several sections at once still yields a single element.
const SHIMMER_CSS = `
@keyframes eysl-shimmer { from { background-position: 100% 50% } to { background-position: 0 50% } }
.eysl-shimmer-bar {
  height: 12px;
  border-radius: 999px;
  background: linear-gradient(90deg, #eef0f2 25%, #f7f8f9 37%, #eef0f2 63%);
  background-size: 400% 100%;
  animation: eysl-shimmer 1.4s ease infinite;
}
@media (prefers-reduced-motion: reduce) { .eysl-shimmer-bar { animation: none } }
`

export function Shimmer({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-busy="true" style={{ display: 'grid', gap: 9 }}>
      <style href="eysl-shimmer" precedence="default">
        {SHIMMER_CSS}
      </style>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} style={CARD}>
          <div className="eysl-shimmer-bar" style={{ width: '44%' }} />
          <div className="eysl-shimmer-bar" style={{ width: '72%', marginTop: 10 }} />
        </div>
      ))}
      <span style={SR_ONLY}>불러오는 중</span>
    </div>
  )
}

function EmptyState({ message }: { message: ReactNode }) {
  return (
    <div style={{ ...CARD, textAlign: 'center', padding: '32px 18px', color: '#6b7178' }}>
      <EmptyIcon />
      <p style={{ margin: '10px 0 0', fontSize: 13 }}>{message}</p>
    </div>
  )
}

function ErrorState({ message, onRetry }: { message: ReactNode; onRetry: () => void }) {
  return (
    <div
      role="alert"
      style={{
        ...CARD,
        textAlign: 'center',
        padding: '32px 18px',
        borderColor: '#a33',
        background: '#fff0f0',
        color: '#a33',
      }}
    >
      <ErrorIcon />
      <p style={{ margin: '10px 0 0', fontSize: 13 }}>{message}</p>
      <button
        onClick={onRetry}
        style={{
          marginTop: 14,
          minHeight: 44,
          minWidth: 108,
          padding: '0 18px',
          borderRadius: 13,
          border: '1px solid #a33',
          background: '#fff',
          color: '#a33',
          fontSize: 13,
        }}
      >
        다시 시도
      </button>
    </div>
  )
}

function EmptyIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="3" width="16" height="18" rx="3" stroke="#c3c9d1" strokeWidth="1.6" />
      <path d="M8 9h8M8 13h8M8 17h5" stroke="#c3c9d1" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function ErrorIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="#a33" strokeWidth="1.6" />
      <path d="M12 7v6" stroke="#a33" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="16.4" r="1.1" fill="#a33" />
    </svg>
  )
}

const SR_ONLY = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const
