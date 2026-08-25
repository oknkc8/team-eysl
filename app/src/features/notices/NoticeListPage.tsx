import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { useCurrentUser } from '../auth/useCurrentUser'
import { isStaff } from '../auth/schema'
import { listNotices, type NoticeSummary } from './api'
import { formatRelative } from './relativeTime'

export function NoticeListPage() {
  const { user } = useCurrentUser()
  const query = useQuery({ queryKey: ['notices'], queryFn: listNotices })

  return (
    <div style={{ padding: 18, background: '#f5f6f8', minHeight: '100vh' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 style={{ fontSize: 22, letterSpacing: -0.8, margin: 0 }}>공지사항</h1>
        {/* Presentation only. /notices/new is guarded by RequireStaff in the
            route tree, so hiding this button is not what keeps others out. */}
        {isStaff(user) && (
          <Link
            to="/notices/new"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              minHeight: 44,
              padding: '0 16px',
              borderRadius: 13,
              background: '#111317',
              color: '#fff',
              fontSize: 13,
              textDecoration: 'none',
            }}
          >
            새 공지
          </Link>
        )}
      </header>

      <div style={{ marginTop: 16 }}>
        <AsyncSection
          query={query}
          isEmpty={(rows) => rows.length === 0}
          loading={<Shimmer rows={4} />}
          empty="등록된 공지가 없습니다"
          error="공지를 불러오지 못했습니다"
        >
          {(rows) => (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 9 }}>
              {rows.map((notice) => (
                <li key={notice.id}>
                  <NoticeCard notice={notice} />
                </li>
              ))}
            </ul>
          )}
        </AsyncSection>
      </div>
    </div>
  )
}

function NoticeCard({ notice }: { notice: NoticeSummary }) {
  return (
    <Link
      to={`/notices/${notice.id}`}
      style={{
        display: 'block',
        padding: 14,
        border: '1px solid #e1e5ea',
        borderRadius: 18,
        background: '#fff',
        textDecoration: 'none',
        color: '#111317',
      }}
    >
      <b style={{ fontSize: 14, lineHeight: 1.4 }}>{notice.title}</b>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          margin: '6px 0 0',
          fontSize: 11,
          color: '#6b7178',
        }}
      >
        <span>{formatRelative(notice.created_at)}</span>
        <span aria-hidden="true">·</span>
        <span>댓글 {notice.comment_count}</span>
        {notice.attachment_count > 0 && (
          <span
            style={{
              padding: '2px 8px',
              borderRadius: 999,
              background: '#fff0d6',
              color: '#925900',
            }}
          >
            첨부 {notice.attachment_count}
          </span>
        )}
      </div>
    </Link>
  )
}
