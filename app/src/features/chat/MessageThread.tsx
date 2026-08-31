import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { MemberAvatar } from '../members/MemberAvatar'
import { mediaKind } from '../media/kind'
import type { RosterMember } from '../members/api'
import { getAttachmentUrl } from './api'
import { isPending, type ChatMessage } from './reconcile'

const TIME_FORMAT = new Intl.DateTimeFormat('ko-KR', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

export function MessageThread({
  messages,
  myMemberId,
  roster,
  onRetry,
  onDismiss,
}: {
  messages: ChatMessage[]
  myMemberId: string
  /** Nickname and face by member id. A sender missing from it is one who has left. */
  roster: Map<string, RosterMember>
  onRetry: (message: ChatMessage) => void
  onDismiss: (message: ChatMessage) => void
}) {
  const bottom = useRef<HTMLDivElement>(null)

  // A chat that opens at the top of the history is a chat you have to scroll to
  // read. Keyed on the count rather than the array so a re-render that only
  // reorders does not yank the view.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [messages.length])

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {messages.map((message, index) => (
        <Bubble
          key={message.id}
          message={message}
          mine={message.sender_id === myMemberId}
          sender={roster.get(message.sender_id)}
          // The name and face repeat only when the speaker changes, so a run of
          // messages from one person reads as one turn.
          showSender={messages[index - 1]?.sender_id !== message.sender_id}
          onRetry={onRetry}
          onDismiss={onDismiss}
        />
      ))}
      <div ref={bottom} />
    </div>
  )
}

function Bubble({
  message,
  mine,
  sender,
  showSender,
  onRetry,
  onDismiss,
}: {
  message: ChatMessage
  mine: boolean
  sender: RosterMember | undefined
  showSender: boolean
  onRetry: (message: ChatMessage) => void
  onDismiss: (message: ChatMessage) => void
}) {
  const waiting = isPending(message) && !message.failed

  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        flexDirection: mine ? 'row-reverse' : 'row',
      }}
    >
      {/* The column is held open even when the face is not repeated, so a run of
          messages stays on one line rather than stepping left. */}
      {!mine && (
        <div style={{ width: 34, flexShrink: 0 }}>
          {showSender &&
            (sender ? (
              <MemberAvatar member={sender} size={34} />
            ) : (
              <div
                aria-hidden="true"
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: '50%',
                  background: '#eef0f2',
                  color: '#6b7178',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 13,
                }}
              >
                ?
              </div>
            ))}
        </div>
      )}

      <div style={{ maxWidth: '76%', minWidth: 0 }}>
        {/* A sender the roster does not know is one who has been blocked or
            removed: member_public_v only lists approved members, so their
            messages stay readable while their name does not. */}
        {!mine && showSender && (
          <p style={{ fontSize: 11, color: '#6b7178', margin: '0 0 4px 2px' }}>
            {sender?.nickname ?? '알 수 없는 회원'}
          </p>
        )}

        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            gap: 6,
            flexDirection: mine ? 'row-reverse' : 'row',
          }}
        >
          <div
            style={{
              padding: '9px 12px',
              borderRadius: 18,
              background: message.failed ? '#fff0f0' : mine ? '#111317' : '#fff',
              color: message.failed ? '#a33' : mine ? '#fff' : '#111317',
              border: `1px solid ${message.failed ? '#a33' : mine ? '#111317' : '#e1e5ea'}`,
              fontSize: 14,
              lineHeight: 1.55,
              // Bodies are plain text and are rendered as text. Newlines are
              // preserved here rather than by turning them into markup, which
              // is why nothing on this screen needs dangerouslySetInnerHTML.
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              // A message the server has not acknowledged is drawn as not yet
              // real, rather than identically to one that landed.
              opacity: waiting ? 0.55 : 1,
            }}
          >
            {message.attachment_path ? (
              <Attachment
                path={message.attachment_path}
                type={message.attachment_type}
                name={message.attachment_name}
                caption={message.body}
              />
            ) : (
              message.body
            )}
          </div>

          <span style={{ fontSize: 10, color: '#858b94', flexShrink: 0 }}>
            {waiting ? '보내는 중' : TIME_FORMAT.format(new Date(message.created_at))}
          </span>
        </div>

        {message.failed && (
          <div
            style={{
              display: 'flex',
              gap: 7,
              justifyContent: mine ? 'flex-end' : 'flex-start',
              marginTop: 6,
            }}
          >
            <button onClick={() => onRetry(message)} style={FAILED_BUTTON}>
              다시 보내기
            </button>
            <button onClick={() => onDismiss(message)} style={FAILED_BUTTON}>
              지우기
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

const FAILED_BUTTON = {
  minHeight: 44,
  padding: '0 12px',
  borderRadius: 13,
  border: '1px solid #a33',
  background: '#fff',
  color: '#a33',
  fontSize: 12,
} as const

/**
 * One attachment, signed on demand.
 *
 * Nothing in this app sends one yet — the composer is text only — but the
 * column exists in messages (0004), send_message_v1() accepts it, and the
 * legacy app writes it, so a thread carried over from there has rows this must
 * render. A missing signature shows the file name rather than a broken tile.
 */
function Attachment({
  path,
  type,
  name: sentName,
  caption,
}: {
  path: string
  type: string | null
  /** The sender's own file name (0049), or null on a row written before it. */
  name: string | null
  caption: string | null
}) {
  const url = useQuery({
    queryKey: ['chat-attachment', path],
    queryFn: () => getAttachmentUrl(path),
    staleTime: 30 * 60_000,
  })

  // THE SENDER'S NAME FIRST, then the caption, then the key.
  //
  // The key is last for a reason easy to forget: since 0042 it is an ASCII slug,
  // so 훈련일지.txt reads as file.txt there. It stays as the final fallback
  // because rows written before 0049 carry no name, and a slug beats nothing.
  const name = sentName?.trim() || caption?.trim() || path.split('/').pop() || '첨부파일'
  const kind = mediaKind(type)

  if (url.isPending) return <span style={{ fontSize: 12 }}>첨부파일 불러오는 중…</span>
  if (url.isError || !url.data) return <span style={{ fontSize: 12 }}>📎 {name}</span>

  if (kind === 'image') {
    return (
      <img
        src={url.data}
        alt={name}
        style={{ display: 'block', maxWidth: '100%', borderRadius: 12 }}
      />
    )
  }
  if (kind === 'video') {
    return (
      <video
        src={url.data}
        controls
        playsInline
        preload="metadata"
        style={{ display: 'block', maxWidth: '100%', borderRadius: 12 }}
      />
    )
  }
  return (
    <a
      href={url.data}
      target="_blank"
      rel="noopener noreferrer"
      style={{ color: 'inherit', fontSize: 13 }}
    >
      📎 {name}
    </a>
  )
}
