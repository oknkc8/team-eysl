import { Link } from 'react-router'
import { KIND_TITLE, type RankingKind } from './rankings'

// The president's 이벤트 hub is three buttons and nothing else
// (upstream-index.html:1183). It fetches nothing: the rankings load on the
// detail screen, so opening the hub costs no round trip.

const ENTRIES: { kind: RankingKind; desc: string }[] = [
  { kind: 'attendance', desc: '누적·상반기·하반기 출석 순위' },
  { kind: 'late', desc: '누적·상반기·하반기 지각 순위' },
  { kind: 'improve', desc: '영법별 기록 단축 순위' },
]

export function EventHubPage() {
  return (
    <div style={{ padding: 18, background: '#f5f6f8', minHeight: '100vh' }}>
      <h1 style={{ fontSize: 22, letterSpacing: -0.8, margin: 0, color: '#111317' }}>이벤트</h1>
      <nav style={{ display: 'grid', gap: 9, marginTop: 16 }}>
        {ENTRIES.map(({ kind, desc }) => (
          <Link
            key={kind}
            to={`/events/${kind}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              minHeight: 44,
              padding: 16,
              border: '1px solid #e1e5ea',
              borderRadius: 18,
              background: '#fff',
              textDecoration: 'none',
              color: '#111317',
            }}
          >
            <span>
              <b style={{ fontSize: 14 }}>{KIND_TITLE[kind]}</b>
              <span style={{ display: 'block', fontSize: 11, color: '#6b7178', marginTop: 4 }}>
                {desc}
              </span>
            </span>
            <span aria-hidden="true" style={{ fontSize: 16, color: '#6b7178' }}>
              ›
            </span>
          </Link>
        ))}
      </nav>
    </div>
  )
}
