import { useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { SaveState } from '../../components/ui/SaveState'
import { useCurrentUser } from '../auth/useCurrentUser'
import {
  BODY_MAX,
  createBoardPost,
  getBoardPost,
  TITLE_MAX,
  updateBoardPost,
  type BoardPost,
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

  const save = useMutation({
    mutationFn: (input: { title: string; body: string }) =>
      post ? updateBoardPost({ postId: post.id, ...input }) : createBoardPost(input),
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
    // member to retype what they wrote.
    onError: (error) => {
      setSaveState('error')
      setSaveError(error instanceof Error ? error.message : '게시글을 저장하지 못했습니다.')
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

      {/* The reason, under the status. "저장 실패" says a write did not land;
          this says whether it was the length, the authority, or a post somebody
          else had already deleted. */}
      {saveError && (
        <p role="alert" className="authMsg error">
          {saveError}
        </p>
      )}
    </>
  )
}
