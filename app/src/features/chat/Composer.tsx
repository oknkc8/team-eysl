import { useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import { SaveState } from '../../components/ui/SaveState'
import type { ChannelStatus } from './api'

/**
 * Says out loud whether new messages are actually arriving.
 *
 * A chat whose socket has dropped looks exactly like a quiet one, which is the
 * worst version of this failure: the member concludes nobody is talking. The
 * thread is still readable and still sendable while this shows — only the live
 * updates are gone — so it reads as a notice rather than an error.
 */
export function ConnectionNotice({
  status,
  onRefresh,
}: {
  status: ChannelStatus
  onRefresh: () => void
}) {
  if (status === 'live') return null

  if (status === 'connecting') {
    return <p style={{ ...NOTICE, background: '#eef0f2', color: '#6b7178' }}>실시간 연결 중…</p>
  }

  return (
    <p style={{ ...NOTICE, background: '#fff0d6', color: '#925900' }}>
      실시간 연결이 끊겼습니다. 새 메시지가 바로 보이지 않을 수 있어요.
      <button onClick={onRefresh} style={REFRESH_BUTTON}>
        새로고침
      </button>
    </p>
  )
}

const NOTICE = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
  margin: '0 0 10px',
  padding: '8px 12px',
  borderRadius: 13,
  fontSize: 12,
  lineHeight: 1.5,
} as const

const REFRESH_BUTTON = {
  minHeight: 32,
  padding: '0 10px',
  borderRadius: 10,
  border: '1px solid #925900',
  background: '#fff',
  color: '#925900',
  fontSize: 12,
} as const

/**
 * The message box.
 *
 * A textarea rather than an input, because messages here wrap — the legacy app
 * used a single-line field, so a two-line message scrolled sideways inside it.
 */
export function Composer({
  onSend,
  saveState,
  placeholder,
}: {
  onSend: (body: string, file: File | null) => void
  saveState: 'idle' | 'saving' | 'saved' | 'error'
  placeholder: string
}) {
  const [draft, setDraft] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const pickerRef = useRef<HTMLInputElement>(null)

  // send_message_v1 accepts text OR an attachment, so a photo with no caption is
  // a real message and the button has to allow it.
  const canSend = draft.trim() !== '' || file !== null

  function pick(event: ChangeEvent<HTMLInputElement>) {
    // Read before clearing the input: `files` is the input's LIVE FileList, and
    // resetting value below empties it in place rather than handing back a copy.
    const chosen = event.target.files?.[0] ?? null
    setFile(chosen)
    // Cleared so choosing the same file twice in a row still fires onChange.
    if (pickerRef.current) pickerRef.current.value = ''
  }

  function submit() {
    if (!canSend) return
    onSend(draft, file)
    setDraft('')
    setFile(null)
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey) return
    // A Korean keyboard fires Enter to commit the syllable being composed.
    // Sending on that key would cut 안녕하세 off mid-word and post it.
    // isComposing is what distinguishes committing a character from finishing a
    // message.
    if (event.nativeEvent.isComposing) return
    event.preventDefault()
    submit()
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: 8,
        padding: 12,
        border: '1px solid #e1e5ea',
        borderRadius: 18,
        background: '#fff',
      }}
    >
      <input
        ref={pickerRef}
        type="file"
        onChange={pick}
        style={{ display: 'none' }}
        aria-hidden="true"
        tabIndex={-1}
      />
      <button
        type="button"
        onClick={() => pickerRef.current?.click()}
        aria-label="파일 첨부"
        style={{
          minHeight: 44,
          minWidth: 44,
          borderRadius: 13,
          border: '1px solid #e1e5ea',
          background: '#fff',
          color: '#6b7178',
          fontSize: 18,
          lineHeight: 1,
        }}
      >
        +
      </button>

      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        rows={1}
        aria-label="메시지 입력"
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 44,
          maxHeight: 132,
          padding: '11px 12px',
          borderRadius: 13,
          border: '1px solid #e1e5ea',
          fontSize: 14,
          fontFamily: 'inherit',
          lineHeight: 1.5,
          resize: 'none',
        }}
      />

      {file && (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            maxWidth: 160,
            padding: '6px 10px',
            borderRadius: 11,
            background: '#eef0f2',
            color: '#111317',
            fontSize: 12,
          }}
        >
          <span
            style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title={file.name}
          >
            {file.name}
          </span>
          <button
            type="button"
            onClick={() => setFile(null)}
            aria-label="첨부 취소"
            style={{
              border: 'none',
              background: 'none',
              color: '#6b7178',
              fontSize: 14,
              lineHeight: 1,
              padding: 0,
            }}
          >
            ×
          </button>
        </span>
      )}

      <div style={{ display: 'grid', gap: 6, justifyItems: 'end' }}>
        {/* Sending is a write, so it reports like every other one here: 저장 중…,
            저장됨, 저장 실패. The failed bubble in the thread carries the retry,
            because retrying from here would re-send whatever is in the box now
            rather than the message that failed. */}
        <SaveState state={saveState} />
        <button
          onClick={submit}
          disabled={!canSend}
          style={{
            minHeight: 44,
            minWidth: 60,
            padding: '0 16px',
            borderRadius: 13,
            border: 'none',
            background: canSend ? '#111317' : '#e1e5ea',
            color: canSend ? '#fff' : '#6b7178',
            fontSize: 13,
          }}
        >
          보내기
        </button>
      </div>
    </div>
  )
}
