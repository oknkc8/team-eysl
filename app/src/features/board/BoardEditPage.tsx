import { useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { SaveState } from '../../components/ui/SaveState'
import { useCurrentUser } from '../auth/useCurrentUser'
import {
  BODY_MAX,
  BoardConflictError,
  createBoardPost,
  getBoardPost,
  TITLE_MAX,
  updateBoardPost,
  type BoardPost,
  type BoardPostVersion,
} from './api'

/**
 * 글 작성 / 글 수정 — his #boardWrite (upstream:1287-1291), one screen for both
 * jobs the way openBoardWrite and editBoardPost share it.
 *
 * Both routes sit under RequireAuth rather than any role guard, because writing
 * here is open to every approved member and editing is open to exactly one — and
 * "the author of the row at this id" is not something a position in the route
 * tree can express. So the screen asks the same question the database asks and
 * prints a Korean refusal, the pattern ActivityEditPage already follows for the
 * same reason.
 */
export function BoardEditPage() {
  const { postId } = useParams()

  // Fetching first and passing the post down means the form seeds its state from
  // a prop exactly once, with no effect syncing a late-arriving row.
  if (!postId) {
    return (
      <Page title="글 작성" backTo="/board">
        <PostForm />
      </Page>
    )
  }
  return <EditExisting postId={postId} />
}

function EditExisting({ postId }: { postId: string }) {
  const { user } = useCurrentUser()
  const query = useQuery({
    queryKey: ['board-post', postId],
    queryFn: () => getBoardPost(postId),
  })

  return (
    // Back to the post rather than the list, matching cancelBoardWrite
    // (upstream:2647): leaving an edit puts you where you started.
    <Page title="글 수정" backTo={`/board/${postId}`}>
      <AsyncSection query={query} loading={<Shimmer rows={2} />} error="게시글을 불러오지 못했습니다">
        {(post) =>
          user && user.id === post.author_id ? (
            <PostForm post={post} />
          ) : (
            // The same sentence update_board_post_v1 raises. Shown instead of a
            // form because a form that cannot save is worse than a refusal.
            <p role="alert" className="authMsg error">
              작성자만 수정할 수 있습니다.
            </p>
          )
        }
      </AsyncSection>
    </Page>
  )
}

function Page({ title, backTo, children }: { title: string; backTo: string; children: ReactNode }) {
  return (
    <div className="page">
      <Link to={backTo} className="backLink">
        ← 자유게시판
      </Link>
      <h1 className="title">{title}</h1>
      {children}
    </div>
  )
}

function PostForm({ post }: { post?: BoardPost }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [title, setTitle] = useState(post?.title ?? '')
  const [body, setBody] = useState(post?.body ?? '')
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  /**
   * Which version of the post this form is editing.
   *
   * Seeded from the row that seeded the fields, and moved forward only when the
   * member has been SHOWN a newer one. That is what makes a second press after a
   * conflict a decision rather than an accident: they have read the other text
   * by then. If the refusal arrived without it, this stays put and the next save
   * conflicts again — which is the right answer, because nothing has been seen.
   */
  const [baseUpdatedAt, setBaseUpdatedAt] = useState(post?.updated_at ?? '')
  const [conflict, setConflict] = useState<{ current: BoardPostVersion | null } | null>(null)

  const save = useMutation({
    mutationFn: (input: { title: string; body: string }) =>
      post
        ? updateBoardPost({ postId: post.id, ...input, expectedUpdatedAt: baseUpdatedAt })
        : createBoardPost(input),
    onMutate: () => {
      setSaveState('saving')
      setSaveError(null)
    },
    onSuccess: async (saved) => {
      setSaveState('saved')
      // Invalidated before navigating, so the detail screen we land on reads the
      // server's copy — which is also where the author's nickname comes from,
      // since the RPC returns the row without one.
      await qc.invalidateQueries({ queryKey: ['board'] })
      await qc.invalidateQueries({ queryKey: ['board-post', saved.id] })
      void navigate(`/board/${saved.id}`, { replace: true })
    },
    // The draft stays in the boxes on failure, so a retry does not ask the
    // member to retype what they wrote. That matters most on a conflict: the
    // member's text and the server's are both on screen, and neither has been
    // thrown away for them.
    onError: (error) => {
      setSaveState('error')
      setSaveError(error instanceof Error ? error.message : '게시글을 저장하지 못했습니다.')
      if (error instanceof BoardConflictError) {
        setConflict({ current: error.current })
        if (error.current) setBaseUpdatedAt(error.current.updated_at)
      } else {
        setConflict(null)
      }
    },
  })

  const trimmedTitle = title.trim()
  const trimmedBody = body.trim()
  const canSubmit = trimmedTitle.length > 0 && trimmedBody.length > 0 && saveState !== 'saving'

  function submit() {
    if (!canSubmit) return
    // Trimmed here as well as in board_post_text, so what the member sees saved
    // is what the database stored rather than a value it quietly changed.
    save.mutate({ title: trimmedTitle, body: trimmedBody })
  }

  return (
    <>
      <div className="card">
        <label htmlFor="board-title" className="field-label">
          제목
        </label>
        <input
          id="board-title"
          className="field"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value)
            if (saveState !== 'saving') setSaveState('idle')
          }}
          // His maxlength attributes (upstream:1289-1290). The real limit is
          // 0033's check constraint; this only keeps a member from typing past
          // it and then being told.
          maxLength={TITLE_MAX}
          placeholder="제목을 입력해주세요"
        />

        <label htmlFor="board-body" className="field-label" style={{ marginTop: 14 }}>
          내용
        </label>
        <textarea
          id="board-body"
          className="field"
          value={body}
          onChange={(e) => {
            setBody(e.target.value)
            if (saveState !== 'saving') setSaveState('idle')
          }}
          maxLength={BODY_MAX}
          placeholder="자유롭게 작성해주세요"
          rows={10}
        />
      </div>

      <div className="actions">
        <SaveState state={saveState} onRetry={canSubmit ? submit : undefined} />
        <button onClick={submit} disabled={!canSubmit} className="btn primary">
          {post ? '수정하기' : '등록하기'}
        </button>
      </div>

      {/* A conflict gets a panel rather than a line, because it is the one
          failure the member has to ACT on: both versions are in front of them
          and they choose. Everything else is a sentence. */}
      {conflict ? (
        <ConflictPanel current={conflict.current} />
      ) : (
        /* The reason, under the status. "저장 실패" says a write did not land;
           this says whether it was the length, the authority, or a post somebody
           else had already deleted. */
        saveError && (
          <p role="alert" className="authMsg error">
            {saveError}
          </p>
        )
      )}
    </>
  )
}

/**
 * What the server holds now, shown beside what the member typed.
 *
 * The draft is never replaced with this and this is never discarded for the
 * draft — picking one silently is the defect 0037 exists to prevent, and doing
 * it in the client would reintroduce it one layer up.
 */
function ConflictPanel({ current }: { current: BoardPostVersion | null }) {
  return (
    <div className="card" role="alert" style={{ marginTop: 14 }}>
      <p className="authMsg error" style={{ marginTop: 0 }}>
        다른 곳에서 먼저 수정됐습니다.
      </p>
      {current ? (
        <>
          <p className="fieldNote">
            지금 저장된 내용입니다. 확인한 뒤 다시 저장하면 아래 내용을 위에 쓴 내용으로 바꿉니다.
          </p>
          <b>{current.title}</b>
          <p className="body" style={{ whiteSpace: 'pre-wrap' }}>
            {current.body}
          </p>
        </>
      ) : (
        // The refusal arrived without the current row, so there is nothing
        // honest to show and the form is still holding a version the server has
        // moved past. Saying so is better than a retry that cannot succeed.
        <p className="fieldNote">
          현재 저장된 내용을 불러오지 못했습니다. 새로고침한 뒤 다시 작성해주세요.
        </p>
      )}
    </div>
  )
}
