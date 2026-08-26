import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { useCurrentUser } from '../auth/useCurrentUser'
import { isStaff } from '../auth/schema'
import { deleteBoardPost, getBoardPost, type BoardPost } from './api'

/** His boardDate (upstream:2589-2592), as the Intl constant this app uses elsewhere. */
const POSTED_FORMAT = new Intl.DateTimeFormat('ko-KR', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

/**
 * 게시글 — his #boardDetail (upstream:1283-1285, renderBoardDetail at 2618).
 *
 * Who may do what is his, read out of his file rather than assumed:
 *   수정 — the author, and nobody else. editBoardPost refuses a non-author
 *          (upstream:2639) and he made no admin case for it.
 *   삭제 — the author or staff, `own || isAdminUser()` (upstream:2668).
 *
 * Both are presentation. update_board_post_v1 and delete_board_post_v1 decide it
 * again in the database, so hiding a button is not what keeps anyone out — and
 * a member who reaches the edit screen by URL meets the same sentence there.
 */
export function BoardDetailPage() {
  const { postId = '' } = useParams()

  const query = useQuery({
    queryKey: ['board-post', postId],
    queryFn: () => getBoardPost(postId),
    enabled: !!postId,
  })

  return (
    <div className="page">
      <Link to="/board" className="backLink">
        ← 자유게시판
      </Link>

      <AsyncSection query={query} loading={<Shimmer rows={2} />} error="게시글을 불러오지 못했습니다">
        {(post) => <Article post={post} />}
      </AsyncSection>
    </div>
  )
}

function Article({ post }: { post: BoardPost }) {
  const { user } = useCurrentUser()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [removeError, setRemoveError] = useState<string | null>(null)

  const own = !!user && user.id === post.author_id
  const canDelete = own || isStaff(user)

  const remove = useMutation({
    mutationFn: () => deleteBoardPost(post.id),
    onMutate: () => setRemoveError(null),
    onSuccess: async () => {
      // Invalidated before navigating, so the list we land on is the server's
      // copy rather than the one still holding the row we just removed.
      await qc.invalidateQueries({ queryKey: ['board'] })
      qc.removeQueries({ queryKey: ['board-post', post.id] })
      void navigate('/board', { replace: true })
    },
    // The RPC says why it refused — 작성자만, or 이미 삭제된 글 — and that
    // sentence is worth more than a generic failure, so it is shown verbatim
    // rather than collapsed into "삭제하지 못했습니다".
    onError: (error) =>
      setRemoveError(error instanceof Error ? error.message : '게시글을 삭제하지 못했습니다.'),
  })

  return (
    <article className="article">
      <p className="meta">
        {post.author_nickname} · {POSTED_FORMAT.format(new Date(post.created_at))}
        {post.updated_at !== post.created_at && ' · 수정됨'}
      </p>
      <h1>{post.title}</h1>
      {/* Plain text, escaped by React; the line breaks are .article .body's
          white-space: pre-wrap. His renderBoardDetail sets the same thing
          inline (upstream:2627) after escaping by hand. */}
      <p className="body">{post.body}</p>

      {canDelete && (
        <div className="actions">
          {own && (
            <Link to={`/board/${post.id}/edit`} className="btn outline">
              수정
            </Link>
          )}
          <button
            onClick={() => {
              if (window.confirm('이 게시글을 삭제할까요?')) remove.mutate()
            }}
            disabled={remove.isPending}
            className="btn amber"
          >
            삭제
          </button>
        </div>
      )}

      {removeError && (
        <p role="alert" className="authMsg error">
          {removeError}
        </p>
      )}
    </article>
  )
}
