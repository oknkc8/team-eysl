import { useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { SaveState } from '../../components/ui/SaveState'
import { createNotice, deleteNotice, getNotice, updateNotice, type Notice } from './api'

const CARD = {
  padding: 14,
  border: '1px solid #e1e5ea',
  borderRadius: 18,
  background: '#fff',
} as const

const FIELD = {
  width: '100%',
  boxSizing: 'border-box',
  padding: 12,
  borderRadius: 13,
  border: '1px solid #e1e5ea',
  fontSize: 14,
  fontFamily: 'inherit',
} as const

const LABEL = { display: 'block', fontSize: 12, color: '#6b7178', marginBottom: 6 } as const

// Both routes sit under RequireStaff, so neither this component nor the form
// re-checks the role — the route tree is what decides who gets here.
export function NoticeEditPage() {
  const { noticeId } = useParams()

  // Fetching first and passing the notice down means the form seeds its state
  // from a prop exactly once, with no effect syncing a late-arriving row.
  if (!noticeId) return <NoticeForm />
  return <EditExisting noticeId={noticeId} />
}

function EditExisting({ noticeId }: { noticeId: string }) {
  const query = useQuery({
    queryKey: ['notice', noticeId],
    queryFn: () => getNotice(noticeId),
  })

  return (
    <Page title="공지 수정">
      <AsyncSection query={query} loading={<Shimmer rows={2} />} error="공지를 불러오지 못했습니다">
        {(notice) => <NoticeForm notice={notice} />}
      </AsyncSection>
    </Page>
  )
}

function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="page">
      <Link to="/notices" className="backLink">
        ← 공지사항
      </Link>
      <h1 style={{ fontSize: 22, letterSpacing: -0.8, margin: '12px 0 16px' }}>{title}</h1>
      {children}
    </div>
  )
}

function NoticeForm({ notice }: { notice?: Notice }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [title, setTitle] = useState(notice?.title ?? '')
  const [body, setBody] = useState(notice?.body ?? '')
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  const save = useMutation({
    mutationFn: (input: { title: string; body: string }) =>
      notice ? updateNotice({ noticeId: notice.id, ...input }) : createNotice(input),
    onMutate: () => setSaveState('saving'),
    onSuccess: async (saved) => {
      setSaveState('saved')
      // Invalidated before navigating, so the detail screen we land on reads the
      // server's copy rather than the pre-edit one still sitting in the cache.
      await qc.invalidateQueries({ queryKey: ['notices'] })
      await qc.invalidateQueries({ queryKey: ['notice', saved.id] })
      void navigate(`/notices/${saved.id}`, { replace: true })
    },
    onError: () => setSaveState('error'),
  })

  const remove = useMutation({
    mutationFn: deleteNotice,
    onMutate: () => setSaveState('saving'),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['notices'] })
      void navigate('/notices', { replace: true })
    },
    onError: () => setSaveState('error'),
  })

  const trimmedTitle = title.trim()
  const trimmedBody = body.trim()
  const canSubmit = trimmedTitle.length > 0 && trimmedBody.length > 0 && saveState !== 'saving'

  function submit() {
    if (!canSubmit) return
    save.mutate({ title: trimmedTitle, body })
  }

  const form = (
    <>
      <div style={CARD}>
        <label htmlFor="notice-title" style={LABEL}>
          제목
        </label>
        <input
          id="notice-title"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value)
            if (saveState !== 'saving') setSaveState('idle')
          }}
          placeholder="공지 제목"
          style={{ ...FIELD, minHeight: 44 }}
        />

        <label htmlFor="notice-body" style={{ ...LABEL, marginTop: 14 }}>
          내용
        </label>
        {/* Stored and rendered as plain text; the detail screen keeps the line
            breaks with white-space: pre-wrap instead of accepting markup. */}
        <textarea
          id="notice-body"
          value={body}
          onChange={(e) => {
            setBody(e.target.value)
            if (saveState !== 'saving') setSaveState('idle')
          }}
          placeholder="공지 내용"
          rows={10}
          style={{ ...FIELD, lineHeight: 1.7, resize: 'vertical' }}
        />
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 9,
          marginTop: 14,
        }}
      >
        <SaveState state={saveState} onRetry={canSubmit ? submit : undefined} />
        <button
          onClick={submit}
          disabled={!canSubmit}
          style={{
            minHeight: 44,
            minWidth: 96,
            padding: '0 18px',
            borderRadius: 13,
            border: 'none',
            background: canSubmit ? '#111317' : '#e1e5ea',
            color: canSubmit ? '#fff' : '#6b7178',
            fontSize: 13,
          }}
        >
          {notice ? '수정' : '등록'}
        </button>
      </div>

      {notice && (
        <button
          onClick={() => {
            if (window.confirm('이 공지를 삭제할까요? 댓글과 첨부파일도 함께 사라집니다.')) {
              remove.mutate(notice.id)
            }
          }}
          disabled={saveState === 'saving'}
          style={{
            minHeight: 44,
            width: '100%',
            marginTop: 24,
            borderRadius: 13,
            border: '1px solid #a33',
            background: '#fff0f0',
            color: '#a33',
            fontSize: 13,
          }}
        >
          공지 삭제
        </button>
      )}
    </>
  )

  // In edit mode the page chrome is already rendered by EditExisting.
  return notice ? form : <Page title="새 공지">{form}</Page>
}
