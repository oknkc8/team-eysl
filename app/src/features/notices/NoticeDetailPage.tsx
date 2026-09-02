import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { SaveState } from '../../components/ui/SaveState'
import { useCurrentUser } from '../auth/useCurrentUser'
import { isStaff } from '../auth/schema'
import {
  appendComment,
  getAttachmentUrl,
  getNotice,
  listAttachments,
  listComments,
  type NoticeAttachment,
} from './api'
import { NoticePoll } from './NoticePoll'
import { formatRelative } from './relativeTime'

export function NoticeDetailPage() {
  const { noticeId = '' } = useParams()
  const { user } = useCurrentUser()

  const notice = useQuery({
    queryKey: ['notice', noticeId],
    queryFn: () => getNotice(noticeId),
    enabled: !!noticeId,
  })

  return (
    <div className="page">
      <Link to="/notices" className="backLink">
        ← 공지사항
      </Link>

      <AsyncSection query={notice} loading={<Shimmer rows={2} />} error="공지를 불러오지 못했습니다">
        {(data) => (
          <article className="article">
            <h1>{data.title}</h1>
            <p className="meta">
              {formatRelative(data.created_at)}
              {data.updated_at !== data.created_at && ' · 수정됨'}
            </p>
            {/* Plain text, escaped by React. Newlines are a CSS concern —
                the legacy screen injected the body as HTML instead. */}
            <p className="body">{data.body}</p>
            {isStaff(user) && (
              <div className="actions">
                <Link to={`/notices/${noticeId}/edit`} className="btn outline">
                  수정
                </Link>
              </div>
            )}
          </article>
        )}
      </AsyncSection>

      {/* Above 첨부파일 and 댓글, where his own client puts it: a poll is
          something to answer, and burying it under the comment thread means it
          is read after people have already stopped scrolling. Renders nothing
          at all when the notice has no poll. */}
      <NoticePoll noticeId={noticeId} />
      <Attachments noticeId={noticeId} />
      <Comments noticeId={noticeId} />
    </div>
  )
}

function Attachments({ noticeId }: { noticeId: string }) {
  const query = useQuery({
    queryKey: ['notice-attachments', noticeId],
    queryFn: () => listAttachments(noticeId),
    enabled: !!noticeId,
  })
  const [openError, setOpenError] = useState<string | null>(null)

  async function open(attachment: NoticeAttachment) {
    setOpenError(null)
    try {
      const url = await getAttachmentUrl(attachment.storage_path)
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch {
      setOpenError('첨부파일을 열지 못했습니다.')
    }
  }

  // No empty state here: a notice without attachments should show nothing
  // rather than an "첨부파일이 없습니다" card on most notices.
  if (!query.isPending && !query.isError && query.data?.length === 0) return null

  return (
    <section>
      <h2 className="listDivider">첨부파일</h2>
      <AsyncSection
        query={query}
        loading={<Shimmer rows={1} />}
        error="첨부파일을 불러오지 못했습니다"
      >
        {(rows) => (
          <ul className="list">
            {rows.map((attachment) => (
              <li key={attachment.id}>
                <button onClick={() => void open(attachment)} className="row">
                  <span className="grow">{attachment.file_name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </AsyncSection>
      {openError && (
        <p role="alert" className="authMsg error">
          {openError}
        </p>
      )}
    </section>
  )
}

function Comments({ noticeId }: { noticeId: string }) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState('')
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  const query = useQuery({
    queryKey: ['notice-comments', noticeId],
    queryFn: () => listComments(noticeId),
    enabled: !!noticeId,
  })

  const add = useMutation({
    mutationFn: appendComment,
    onMutate: () => setSaveState('saving'),
    onSuccess: async () => {
      setDraft('')
      // The list that ends up on screen is the one the server just returned, so
      // a comment someone else wrote in the same second is present too. The
      // legacy screen appended to its own copy and silently dropped the other.
      // "저장됨" waits for that refetch rather than for the write alone.
      await qc.invalidateQueries({ queryKey: ['notice-comments', noticeId] })
      // The list screen's comment count is stale now.
      await qc.invalidateQueries({ queryKey: ['notices'] })
      setSaveState('saved')
    },
    // The draft stays in the box on failure, so a retry does not ask the member
    // to retype what they wrote.
    onError: () => setSaveState('error'),
  })

  const body = draft.trim()
  const canSubmit = body.length > 0 && saveState !== 'saving'

  function submit() {
    if (!canSubmit) return
    add.mutate({ noticeId, body })
  }

  return (
    <section>
      <h2 className="listDivider">댓글</h2>

      <AsyncSection
        query={query}
        isEmpty={(rows) => rows.length === 0}
        loading={<Shimmer rows={2} />}
        empty="아직 댓글이 없습니다"
        error="댓글을 불러오지 못했습니다"
      >
        {(rows) => (
          <ul className="list">
            {rows.map((comment) => (
              <li key={comment.id} className="comment">
                <div className="commentHead">
                  <b>{comment.nickname}</b>
                  <span>{formatRelative(comment.created_at)}</span>
                </div>
                <p className="body">{comment.body}</p>
              </li>
            ))}
          </ul>
        )}
      </AsyncSection>

      <div className="card commentForm">
        <label htmlFor="notice-comment" className="sr-only">
          댓글 입력
        </label>
        <textarea
          id="notice-comment"
          className="field"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            if (saveState !== 'idle') setSaveState('idle')
          }}
          placeholder="댓글을 입력하세요"
          rows={3}
        />
        <div className="commentFormActions">
          <SaveState state={saveState} onRetry={body ? submit : undefined} />
          <button onClick={submit} disabled={!canSubmit} className="btn primary">
            등록
          </button>
        </div>
      </div>
    </section>
  )
}
