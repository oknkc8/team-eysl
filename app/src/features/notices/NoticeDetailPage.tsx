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
import { formatRelative } from './relativeTime'

const CARD = {
  padding: 14,
  border: '1px solid #e1e5ea',
  borderRadius: 18,
  background: '#fff',
} as const

const SECTION_TITLE = { fontSize: 13, color: '#6b7178', margin: '20px 0 8px' } as const

const SR_ONLY = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const

export function NoticeDetailPage() {
  const { noticeId = '' } = useParams()
  const { user } = useCurrentUser()

  const notice = useQuery({
    queryKey: ['notice', noticeId],
    queryFn: () => getNotice(noticeId),
    enabled: !!noticeId,
  })

  return (
    <div style={{ padding: 18, background: '#f5f6f8', minHeight: '100vh' }}>
      <Link to="/notices" style={{ fontSize: 12, color: '#6b7178', textDecoration: 'none' }}>
        ← 공지사항
      </Link>

      <div style={{ marginTop: 12 }}>
        <AsyncSection
          query={notice}
          loading={<Shimmer rows={2} />}
          error="공지를 불러오지 못했습니다"
        >
          {(data) => (
            <article style={CARD}>
              <h1 style={{ fontSize: 20, letterSpacing: -0.6, margin: 0, lineHeight: 1.4 }}>
                {data.title}
              </h1>
              <p style={{ fontSize: 11, color: '#6b7178', margin: '6px 0 0' }}>
                {formatRelative(data.created_at)}
                {data.updated_at !== data.created_at && ' · 수정됨'}
              </p>
              {/* Plain text, escaped by React. Newlines are a CSS concern —
                  the legacy screen injected the body as HTML instead. */}
              <p
                style={{
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontSize: 14,
                  lineHeight: 1.7,
                  color: '#111317',
                  margin: '14px 0 0',
                }}
              >
                {data.body}
              </p>
              {isStaff(user) && (
                <Link
                  to={`/notices/${noticeId}/edit`}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    minHeight: 44,
                    marginTop: 14,
                    padding: '0 16px',
                    borderRadius: 13,
                    border: '1px solid #e1e5ea',
                    color: '#111317',
                    fontSize: 13,
                    textDecoration: 'none',
                  }}
                >
                  수정
                </Link>
              )}
            </article>
          )}
        </AsyncSection>
      </div>

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
      <h2 style={SECTION_TITLE}>첨부파일</h2>
      <AsyncSection
        query={query}
        loading={<Shimmer rows={1} />}
        error="첨부파일을 불러오지 못했습니다"
      >
        {(rows) => (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 9 }}>
            {rows.map((attachment) => (
              <li key={attachment.id}>
                <button
                  onClick={() => void open(attachment)}
                  style={{
                    ...CARD,
                    width: '100%',
                    minHeight: 44,
                    textAlign: 'left',
                    fontSize: 13,
                    color: '#111317',
                  }}
                >
                  {attachment.file_name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </AsyncSection>
      {openError && (
        <p role="alert" style={{ fontSize: 12, color: '#a33', margin: '8px 0 0' }}>
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
      <h2 style={SECTION_TITLE}>댓글</h2>

      <AsyncSection
        query={query}
        isEmpty={(rows) => rows.length === 0}
        loading={<Shimmer rows={2} />}
        empty="아직 댓글이 없습니다"
        error="댓글을 불러오지 못했습니다"
      >
        {(rows) => (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 9 }}>
            {rows.map((comment) => (
              <li key={comment.id} style={CARD}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <b style={{ fontSize: 13 }}>{comment.nickname}</b>
                  <span style={{ fontSize: 11, color: '#6b7178' }}>
                    {formatRelative(comment.created_at)}
                  </span>
                </div>
                <p
                  style={{
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontSize: 13,
                    lineHeight: 1.6,
                    margin: '6px 0 0',
                  }}
                >
                  {comment.body}
                </p>
              </li>
            ))}
          </ul>
        )}
      </AsyncSection>

      <div style={{ ...CARD, marginTop: 9 }}>
        <label htmlFor="notice-comment" style={SR_ONLY}>
          댓글 입력
        </label>
        <textarea
          id="notice-comment"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            if (saveState !== 'idle') setSaveState('idle')
          }}
          placeholder="댓글을 입력하세요"
          rows={3}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: 10,
            borderRadius: 13,
            border: '1px solid #e1e5ea',
            fontSize: 14,
            fontFamily: 'inherit',
            resize: 'vertical',
          }}
        />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 9,
            marginTop: 10,
          }}
        >
          <SaveState state={saveState} onRetry={body ? submit : undefined} />
          <button
            onClick={submit}
            disabled={!canSubmit}
            style={{
              minHeight: 44,
              minWidth: 88,
              padding: '0 18px',
              borderRadius: 13,
              border: 'none',
              background: canSubmit ? '#111317' : '#e1e5ea',
              color: canSubmit ? '#fff' : '#6b7178',
              fontSize: 13,
            }}
          >
            등록
          </button>
        </div>
      </div>
    </section>
  )
}
