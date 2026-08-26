import { useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { SaveState } from '../../components/ui/SaveState'
import {
  deleteNotice,
  getNotice,
  listAttachments,
  saveNotice,
  type Notice,
  type NoticeAttachment,
} from './api'

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
const MUTED = { fontSize: 11, color: '#6b7178' } as const

const rowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: 10,
  borderRadius: 13,
  background: '#f6f8fa',
} as const

const removeStyle = {
  minHeight: 36,
  padding: '0 12px',
  borderRadius: 11,
  border: '1px solid #e1e5ea',
  background: '#fff',
  color: '#6b7178',
  fontSize: 12,
} as const

// Matches the cap in save_notice_v1. Restated rather than shared because the
// server's limit is the real one; this only decides when to stop offering the
// picker, so a drift makes the button unhelpful rather than the save wrong.
const MAX_ATTACHMENTS = 10

/**
 * The two fields this screen actually uses from an attachment: one to show and
 * one to send back. Narrower than NoticeAttachment on purpose — save_notice_v1
 * returns no sort_order, and widening the type would mean inventing one here
 * just to satisfy it. A row is identified by its id and nothing else.
 */
type KeptAttachment = Pick<NoticeAttachment, 'id' | 'file_name'>

/** Sizes come from the File object, never from the server. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

// Both routes sit under RequireStaff, so neither this component nor the form
// re-checks the role — the route tree decides who gets here, and
// save_notice_v1 checks is_staff() itself for anyone who calls it directly.
export function NoticeEditPage() {
  const { noticeId } = useParams()

  // Fetching first and passing the notice down means the form seeds its state
  // from a prop exactly once, with no effect syncing a late-arriving row.
  if (!noticeId) return <NoticeForm />
  return <EditExisting noticeId={noticeId} />
}

function EditExisting({ noticeId }: { noticeId: string }) {
  // Both in one useQueries so the form is seeded once, with the notice and its
  // attachments already agreeing. Two separate queries would let the form mount
  // with a title and no attachments and then have them appear underneath the
  // person editing.
  const [noticeQuery, attachmentsQuery] = useQueries({
    queries: [
      { queryKey: ['notice', noticeId], queryFn: () => getNotice(noticeId) },
      { queryKey: ['notice-attachments', noticeId], queryFn: () => listAttachments(noticeId) },
    ],
  })

  return (
    <Page title="공지 수정">
      <AsyncSection
        query={noticeQuery}
        loading={<Shimmer rows={2} />}
        error="공지를 불러오지 못했습니다"
      >
        {(notice) =>
          attachmentsQuery.isPending ? (
            <Shimmer rows={2} />
          ) : (
            <NoticeForm notice={notice} initialAttachments={attachmentsQuery.data ?? []} />
          )
        }
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

function NoticeForm({
  notice,
  initialAttachments,
}: {
  notice?: Notice
  initialAttachments?: NoticeAttachment[]
}) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [title, setTitle] = useState(notice?.title ?? '')
  const [body, setBody] = useState(notice?.body ?? '')
  // Existing rows the save will keep. Removing one here deletes nothing until
  // 저장 — save_notice_v1 takes the desired final set, so an attachment left
  // out of it is what triggers the delete and the object queue.
  const [kept, setKept] = useState<KeptAttachment[]>(initialAttachments ?? [])
  const [files, setFiles] = useState<File[]>([])
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  // Rows whose object never arrived. Shown rather than swallowed; see below.
  const [uploadFailures, setUploadFailures] = useState<string[]>([])
  const pickerRef = useRef<HTMLInputElement>(null)

  const total = kept.length + files.length

  const save = useMutation({
    mutationFn: () =>
      saveNotice({
        noticeId: notice?.id,
        title: title.trim(),
        body,
        keepAttachmentIds: kept.map((row) => row.id),
        files,
      }),
    onMutate: () => {
      setUploadFailures([])
      setSaveState('saving')
    },
    onSuccess: async (result) => {
      await qc.invalidateQueries({ queryKey: ['notices'] })
      await qc.invalidateQueries({ queryKey: ['notice', result.notice.id] })
      await qc.invalidateQueries({ queryKey: ['notice-attachments', result.notice.id] })

      // THE ACCEPTED FAILURE, MADE VISIBLE. The notice and its attachment rows
      // are saved either way — that half is a transaction — but an object may
      // not have arrived. Navigating away here would leave somebody with an
      // attachment that opens to nothing and no idea it happened, so the screen
      // stays put, names the files, and offers 저장 again.
      if (result.uploadFailures.length > 0) {
        setUploadFailures(result.uploadFailures)
        setSaveState('error')
        // The rows now exist, so a retry must not create them a second time:
        // adopt what came back as the kept set and clear the pending files.
        setKept(result.attachments.map((row) => ({ id: row.id, file_name: row.file_name })))
        setFiles([])
        return
      }

      setSaveState('saved')
      void navigate(`/notices/${result.notice.id}`, { replace: true })
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
    save.mutate()
  }

  function pick(list: FileList | null) {
    if (!list) return
    const room = MAX_ATTACHMENTS - total
    setFiles((current) => [...current, ...Array.from(list).slice(0, Math.max(room, 0))])
    if (saveState !== 'saving') setSaveState('idle')
    // Cleared so picking the same file twice in a row still fires onChange.
    if (pickerRef.current) pickerRef.current.value = ''
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

      <div style={{ ...CARD, marginTop: 14 }}>
        <span style={LABEL}>첨부파일</span>

        {total === 0 && (
          <p style={{ ...MUTED, margin: '0 0 10px', lineHeight: 1.6 }}>
            공지와 함께 저장됩니다. 저장한 뒤에 다시 들어와서 올릴 필요는 없습니다.
          </p>
        )}

        {total > 0 && (
          <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 10px', display: 'grid', gap: 7 }}>
            {/* Both lists render the file name as a TEXT CHILD and nothing else.
                No href, no download attribute, no title — the name is
                member-supplied, and the president's app had an XSS here
                (final86) from interpolating exactly these fields into markup.
                React escapes a text child; it would not save us from an
                attribute we built by hand, so we do not build one. Opening a
                file goes through a signed URL keyed on storage_path, which the
                RPC derives and the client never composes. */}
            {kept.map((row) => (
              <li key={row.id} style={rowStyle}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, wordBreak: 'break-all' }}>
                  {row.file_name}
                </span>
                <button
                  onClick={() => setKept((current) => current.filter((a) => a.id !== row.id))}
                  disabled={saveState === 'saving'}
                  style={removeStyle}
                >
                  제거
                </button>
              </li>
            ))}
            {files.map((file, index) => (
              <li key={`${file.name}-${index}`} style={{ ...rowStyle, background: '#edf7f2' }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, wordBreak: 'break-all' }}>
                  {file.name}
                  <span style={{ ...MUTED, marginLeft: 6 }}>{formatSize(file.size)} · 새 파일</span>
                </span>
                <button
                  onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}
                  disabled={saveState === 'saving'}
                  style={removeStyle}
                >
                  제거
                </button>
              </li>
            ))}
          </ul>
        )}

        <input
          ref={pickerRef}
          id="notice-files"
          type="file"
          multiple
          onChange={(e) => pick(e.target.files)}
          disabled={saveState === 'saving' || total >= MAX_ATTACHMENTS}
          style={{ fontSize: 12 }}
        />
        <p style={{ ...MUTED, margin: '8px 0 0' }}>
          {total >= MAX_ATTACHMENTS
            ? `첨부파일은 ${MAX_ATTACHMENTS}개까지 올릴 수 있습니다.`
            : `${total}/${MAX_ATTACHMENTS}개`}
        </p>
      </div>

      {uploadFailures.length > 0 && (
        <div
          style={{
            ...CARD,
            marginTop: 14,
            background: '#fff0f0',
            borderColor: '#fff0f0',
            color: '#a33',
            fontSize: 13,
            lineHeight: 1.6,
          }}
        >
          공지는 저장됐지만 아래 파일은 올라가지 않았습니다. 목록에서 제거하고 다시 올려주세요.
          <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            {uploadFailures.map((name) => (
              <li key={name} style={{ wordBreak: 'break-all' }}>
                {name}
              </li>
            ))}
          </ul>
        </div>
      )}

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
