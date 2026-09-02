import { useEffect, useState } from 'react'
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
import { listNoticeReaders, markNoticeRead } from './api'
import { formatRelative } from './relativeTime'

export function NoticeDetailPage() {
  const { noticeId = '' } = useParams()
  const { user } = useCurrentUser()

  const notice = useQuery({
    queryKey: ['notice', noticeId],
    queryFn: () => getNotice(noticeId),
    enabled: !!noticeId,
  })

  // Marked when the notice has actually LOADED, not when the route mounts.
  //
  // A receipt records that the notice was put in front of somebody, and a
  // button would record something else — that they chose to say so — which is
  // a different fact and one nobody would press. Staff want the first.
  //
  // But "put in front of them" has to be TRUE. Marking on mount recorded it even
  // when getNotice failed, so staff could see a member as having read content
  // that never rendered — a receipt for something that did not happen, which is
  // worse than a missing one. `notice.isSuccess` is what makes the claim true.
  //
  // Deliberately not surfaced to the member in any way: no toast, no error, no
  // state. They came to read a 공지 and the receipt is for somebody else, so a
  // failure here is not theirs to see.
  //
  // NOTHING RECORDS THE FAILURE ANYWHERE EITHER, and that is a gap rather than a
  // decision. A renamed RPC or a permission regression would disable every
  // receipt silently. It is not sent anywhere because this app has no logging
  // channel at all — zero console calls and no error reporter anywhere in src —
  // so there is nothing to send it to, and introducing the first one is a
  // decision that should not ride along inside a notices PR.
  //
  // First open wins server-side, so running again on a remount or under
  // StrictMode is harmless and cannot move read_at.
  const qc = useQueryClient()

  useEffect(() => {
    if (!noticeId || !notice.isSuccess) return
    void markNoticeRead(noticeId)
      // The reader list is fetched beside this, and on a staff member's own
      // first open the list can come back BEFORE this insert commits — so they
      // are missing from their own list, and React Query caches that. Refetch
      // once the row is actually in.
      .then(() => qc.invalidateQueries({ queryKey: ['notice-readers', noticeId] }))
      .catch(() => {})
  }, [noticeId, notice.isSuccess, qc])

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
      {isStaff(user) && <Readers noticeId={noticeId} />}
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

/**
 * Who has opened this notice. Staff only, and mounted only for staff — the
 * function refuses anybody else with 42501, so this is belt and braces rather
 * than the gate.
 *
 * WHAT THIS CANNOT SHOW, stated because the absence is the interesting part:
 * there is no list of who has NOT read it, and no denominator. `0053` returns
 * readers and nothing else, so "3 of 41" would mean joining this against the
 * roster on the client — and the roster a member is allowed to see is not
 * necessarily the roster the count should be over. That needs a decision and a
 * v2 function rather than an arithmetic shortcut here.
 *
 * A reader who is later blocked disappears from this list while their receipt
 * row stays, because the function joins member_public_v (0019 filters to
 * approved). The count dropping with no event to explain it is documented in
 * the migration; it is mentioned again here so the person reading the screen
 * has the same information as the person reading the schema.
 */
function Readers({ noticeId }: { noticeId: string }) {
  const query = useQuery({
    queryKey: ['notice-readers', noticeId],
    queryFn: () => listNoticeReaders(noticeId),
    enabled: !!noticeId,
  })

  return (
    <section className="section">
      <h2>읽은 사람</h2>
      <AsyncSection
        query={query}
        loading={<Shimmer rows={2} />}
        error="열람 기록을 불러오지 못했습니다"
      >
        {(readers) =>
          readers.length === 0 ? (
            <p className="muted">아직 아무도 열어보지 않았습니다.</p>
          ) : (
            <>
              <p className="muted">{readers.length}명이 읽었습니다.</p>
              <ul className="list">
                {readers.map((reader) => (
                  <li key={reader.member_id}>
                    {/* short_name is nullable and the generated types would
                        claim otherwise — see NoticeReader in api.ts. */}
                    <b>{reader.short_name ?? reader.nickname}</b>{' '}
                    <span className="muted">{formatRelative(reader.read_at)}</span>
                  </li>
                ))}
              </ul>
            </>
          )
        }
      </AsyncSection>
    </section>
  )
}
