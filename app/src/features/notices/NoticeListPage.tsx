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
    <div className="page">
      <div className="titleRow">
        <h1 className="title">공지사항</h1>
        {/* Presentation only. /notices/new is guarded by RequireStaff in the
            route tree, so hiding this button is not what keeps others out. */}
        {isStaff(user) && (
          <Link to="/notices/new" className="btn primary">
            새 공지
          </Link>
        )}
      </div>

      <AsyncSection
        query={query}
        isEmpty={(rows) => rows.length === 0}
        loading={<Shimmer rows={4} />}
        empty="등록된 공지가 없습니다"
        error="공지를 불러오지 못했습니다"
      >
        {(rows) => (
          <ul className="list">
            {rows.map((notice) => (
              <li key={notice.id}>
                <NoticeCard notice={notice} />
              </li>
            ))}
          </ul>
        )}
      </AsyncSection>
    </div>
  )
}

function NoticeCard({ notice }: { notice: NoticeSummary }) {
  return (
    <Link to={`/notices/${notice.id}`} className="row noticeRow">
      <div className="grow">
        <b>{notice.title}</b>
        <p className="noticeMeta">
          <span>{formatRelative(notice.created_at)}</span>
          <span aria-hidden="true">·</span>
          <span>댓글 {notice.comment_count}</span>
          {notice.attachment_count > 0 && (
            <span className="tag wait">첨부 {notice.attachment_count}</span>
          )}
        </p>
      </div>
    </Link>
  )
}
