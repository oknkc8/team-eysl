import type { PostgrestError } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase'

/**
 * 자유게시판.
 *
 * Reads go straight at the table — board_posts_read (0033) admits any approved
 * member — and every write goes through an RPC, because 0033 gives the table no
 * INSERT, UPDATE or DELETE policy at all. That is not belt and braces: with RLS
 * enabled and no permissive policy for a command, PostgreSQL refuses the insert
 * outright and quietly matches zero rows for the other two. Both were checked
 * against the dev database rather than assumed.
 *
 * His client sends the author with the row (`insert({author_id:
 * currentUser.memberId, …})`, upstream:2660), which is a browser naming who
 * wrote a post. Ours cannot: create_board_post_v1 derives the author from
 * auth.uid(), so there is no field to fill in wrongly.
 */

/** His input attributes (upstream:1289-1290), and 0033's check constraints. */
export const TITLE_MAX = 120
export const BODY_MAX = 10000

/**
 * The author of a post whose member row member_public_v will not show us.
 *
 * The view is filtered to `status = 'approved'`, and members are blocked rather
 * than deleted, so a post outlives its author's access to the club. Same
 * sentence listComments uses for the same situation (notices/api.ts:181); his
 * app says 팀원 instead, which reads as a fact about the person rather than
 * about what we can see.
 */
const UNKNOWN_AUTHOR = '알 수 없는 회원'

export type BoardPostSummary = {
  id: string
  title: string
  created_at: string
  author_nickname: string
}

export type BoardPost = {
  id: string
  author_id: string
  title: string
  body: string
  created_at: string
  updated_at: string
  author_nickname: string
}

/**
 * The nickname is read through member_public_v rather than members, for the
 * reason listComments spells out: members_read only shows a non-staff caller
 * their own row, so embedding members directly would blank every other author's
 * name for exactly the members who most need to read them.
 */
const SUMMARY_COLUMNS = 'id, title, created_at, member_public_v(nickname)'
const POST_COLUMNS = 'id, author_id, title, body, created_at, updated_at, member_public_v(nickname)'

/**
 * Deliberately without `body`.
 *
 * His loadBoardPosts selects it (upstream:2595) and his detail screen then reads
 * the post out of that in-memory array rather than fetching it. A body is capped
 * at 10,000 characters, so a hundred of them is a megabyte sent to a phone for a
 * list that prints none of it — the same reason listNotices leaves body out. The
 * detail screen asks for its own row instead.
 */
export async function listBoardPosts(): Promise<BoardPostSummary[]> {
  const { data, error } = await supabase
    .from('board_posts')
    .select(SUMMARY_COLUMNS)
    .order('created_at', { ascending: false })
    // The tiebreak board_posts_created_at_idx is built for. Two posts written in
    // the same second would otherwise swap places between refetches.
    .order('id', { ascending: false })
    .limit(100)
  if (error) throw error

  return (data ?? []).map((row) => ({
    id: row.id,
    title: row.title,
    created_at: row.created_at,
    author_nickname: row.member_public_v?.nickname ?? UNKNOWN_AUTHOR,
  }))
}

export async function getBoardPost(postId: string): Promise<BoardPost> {
  const { data, error } = await supabase
    .from('board_posts')
    .select(POST_COLUMNS)
    .eq('id', postId)
    .single()
  if (error) throw error

  return {
    id: data.id,
    author_id: data.author_id,
    title: data.title,
    body: data.body,
    created_at: data.created_at,
    updated_at: data.updated_at,
    author_nickname: data.member_public_v?.nickname ?? UNKNOWN_AUTHOR,
  }
}

/**
 * A refusal from one of the three RPCs, turned into the sentence the screen
 * shows.
 *
 * Every function in 0033 raises rather than returning nothing, so a refusal
 * arrives here as an error with the SQLSTATE in `code` — which is the whole
 * reason this can say *why*. deleteNotice (notices/api.ts:136-139) is the shape
 * this avoids: it never looks at what it changed, so a policy refusal arrives as
 * a resolved promise and the screen reports success.
 *
 * `refused` is passed in because 42501 means two different things depending on
 * which function raised it — "not an approved member" on create, "not your post"
 * on update and delete — and only the caller knows which it asked for.
 */
/** The version of a post that a save was refused in favour of. */
export type BoardPostVersion = { title: string; body: string; updated_at: string }

/**
 * The save was refused because the post changed underneath it (0037, PT409).
 *
 * Its own class rather than a message, because the screen has to do something
 * with it that no other failure calls for: show what is on the server now,
 * beside what the member typed, so they can reconcile the two themselves. The
 * alternative every version of this bug takes is to pick one silently.
 *
 * `current` is nullable and the screen must cope: it is parsed out of the
 * error's DETAIL, and a refusal that arrives without one is still a refusal.
 */
export class BoardConflictError extends Error {
  readonly current: BoardPostVersion | null

  constructor(current: BoardPostVersion | null) {
    super('다른 곳에서 먼저 수정됐습니다.')
    this.name = 'BoardConflictError'
    this.current = current
  }
}

/**
 * 0037 puts the row it refused in favour of into the exception's DETAIL as
 * JSON, which PostgREST hands back as `error.details`.
 *
 * Every field is checked rather than trusted. This is a string that crossed a
 * database, a REST layer and a network to get here, and the screen renders what
 * comes out of it — so a malformed detail has to degrade to "no current text"
 * rather than to a crash inside an error handler.
 */
function parseConflictDetail(details: string | null): BoardPostVersion | null {
  if (!details) return null
  try {
    const parsed: unknown = JSON.parse(details)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { title, body, updated_at: updatedAt } = parsed as Record<string, unknown>
    if (typeof title !== 'string' || typeof body !== 'string' || typeof updatedAt !== 'string') {
      return null
    }
    return { title, body, updated_at: updatedAt }
  } catch {
    return null
  }
}

function boardError(error: PostgrestError, refused: string): Error {
  switch (error.code) {
    case '42501':
      return new Error(refused)
    case '42704':
      // Somebody else deleted it while this screen was showing it. Deliberately
      // a different answer from the conflict below: this one says stop typing,
      // that one says reconcile. 0037 gives them separate SQLSTATEs for exactly
      // this reason.
      return new Error('이미 삭제된 글입니다.')
    case 'PT409':
      return new BoardConflictError(parseConflictDetail(error.details))
    case '22023':
      return new Error('제목과 내용을 모두 입력해주세요.')
    case '22001':
      return new Error(`제목은 ${TITLE_MAX}자, 내용은 ${BODY_MAX}자를 넘을 수 없습니다.`)
    default:
      return new Error('글을 저장하지 못했습니다.')
  }
}

export async function createBoardPost(input: { title: string; body: string }): Promise<BoardPost> {
  const { data, error } = await supabase.rpc('create_board_post_v1', {
    p_title: input.title,
    p_body: input.body,
  })
  if (error) throw boardError(error, '승인된 회원만 글을 쓸 수 있습니다.')

  // The RPC returns the row it wrote but knows nothing about nicknames, and the
  // author is the person reading the screen — so the detail page it lands on
  // refetches rather than trusting this name. Filled in for the type's sake.
  return { ...data, author_nickname: UNKNOWN_AUTHOR }
}

/**
 * `expectedUpdatedAt` is the `updated_at` of the version being edited, and it is
 * required — 0037 refuses a null rather than treating it as "skip the check".
 *
 * It MUST be passed through as the opaque string PostgREST returned. Postgres
 * stores microseconds and renders all six digits; a JavaScript Date holds only
 * milliseconds, so `new Date(post.updated_at).toISOString()` would silently
 * round 08:03:00.571693 to 08:03:00.571 and the comparison in the database
 * would then fail against the post's own current version — every save would
 * report a conflict with itself. Nothing on this path may construct a Date.
 */
export async function updateBoardPost(input: {
  postId: string
  title: string
  body: string
  expectedUpdatedAt: string
}): Promise<BoardPost> {
  const { data, error } = await supabase.rpc('update_board_post_v1', {
    p_post_id: input.postId,
    p_title: input.title,
    p_body: input.body,
    p_expected_updated_at: input.expectedUpdatedAt,
  })
  // Author only. Staff are deliberately not an exception here — his
  // editBoardPost refuses a non-author outright (upstream:2639) and he made no
  // admin case for it, unlike delete.
  if (error) throw boardError(error, '작성자만 수정할 수 있습니다.')

  return { ...data, author_nickname: UNKNOWN_AUTHOR }
}

/** Returns the id the database actually removed, never a bare success. */
export async function deleteBoardPost(postId: string): Promise<string> {
  const { data, error } = await supabase.rpc('delete_board_post_v1', {
    p_post_id: postId,
  })
  if (error) throw boardError(error, '삭제 권한이 없습니다.')

  return data
}
