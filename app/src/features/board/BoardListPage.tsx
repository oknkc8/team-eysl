import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
// A date helper that happens to live under notices; HomePage already reaches
// across features this way for notices/api and schedule/api.
import { formatRelative } from '../notices/relativeTime'
import { listBoardPosts, type BoardPostSummary } from './api'

/**
 * 자유게시판 — his #freeBoard (upstream:1278-1281).
 *
 * The ＋ that opens 글 작성 is unconditional markup in his app (upstream:1279)
 * and applyRole() never touches a board control, so there is no role behind it:
 * any approved member writes here. Unlike 새 공지 on the notice list, this
 * button is therefore not wrapped in an isStaff() check — and there is no
 * RequireStaff above /board/new for it to be a preview of.
 */
export function BoardListPage() {
  const query = useQuery({ queryKey: ['board'], queryFn: listBoardPosts })

  return (
    <div className="page">
      <div className="titleRow">
        <h1 className="title">자유게시판</h1>
        <Link to="/board/new" className="btn primary">
          글 작성
        </Link>
      </div>

      <AsyncSection
        query={query}
        isEmpty={(rows) => rows.length === 0}
        loading={<Shimmer rows={4} />}
        empty="아직 작성된 게시글이 없습니다"
        error="게시글을 불러오지 못했습니다"
      >
        {(rows) => (
          <ul className="list">
            {rows.map((post) => (
              <li key={post.id}>
                <BoardCard post={post} />
              </li>
            ))}
          </ul>
        )}
      </AsyncSection>
    </div>
  )
}

function BoardCard({ post }: { post: BoardPostSummary }) {
  return (
    <Link to={`/board/${post.id}`} className="row">
      <div className="grow">
        <b>{post.title}</b>
        {/* His row reads 작성자 · 날짜 (upstream:2608). The date is relative
            here rather than his full toLocaleString, matching the notice list —
            a list is scanned, and "3시간 전" is scanned faster than a timestamp.
            The detail screen prints the exact time. */}
        <p>
          {post.author_nickname} · {formatRelative(post.created_at)}
        </p>
      </div>
    </Link>
  )
}
