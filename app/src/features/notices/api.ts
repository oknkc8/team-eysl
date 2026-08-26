import { supabase } from '../../lib/supabase'
import type { Json } from '../../types/database'

// Attachment rows store a path inside this bucket, never a URL, so the bucket
// can be renamed or made private without rewriting rows.
const ATTACHMENT_BUCKET = 'team-files'

export type NoticeSummary = {
  id: string
  title: string
  created_at: string
  comment_count: number
  attachment_count: number
}

export type Notice = {
  id: string
  title: string
  body: string
  created_at: string
  updated_at: string
  created_by: string | null
}

export type NoticeAttachment = {
  id: string
  file_name: string
  mime_type: string
  storage_path: string
  sort_order: number
}

export type NoticeComment = {
  id: string
  body: string
  created_at: string
  member_id: string
  nickname: string
}

const NOTICE_COLUMNS = 'id, title, body, created_at, updated_at, created_by'

// Counts come back as embedded aggregates rather than one query per notice.
export async function listNotices(): Promise<NoticeSummary[]> {
  const { data, error } = await supabase
    .from('notices')
    .select('id, title, created_at, notice_comments(count), notice_attachments(count)')
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) throw error

  return (data ?? []).map((row) => ({
    id: row.id,
    title: row.title,
    created_at: row.created_at,
    comment_count: row.notice_comments[0]?.count ?? 0,
    attachment_count: row.notice_attachments[0]?.count ?? 0,
  }))
}

/**
 * The newest notice, for the home screen's hero card.
 *
 * Not `listNotices()[0]`: that query leaves `body` out on purpose — a hundred
 * notice bodies is a lot to send a phone for a list that prints none of them —
 * and the hero shows the first line of the body under the title, the way his
 * renderHome does (upstream:2470). One row with its body is cheaper than a
 * hundred without.
 *
 * Null rather than a throw when the club has never posted: an empty notices
 * table is a state the hero draws, not a failure.
 */
export async function getLatestNotice(): Promise<Notice | null> {
  const { data, error } = await supabase
    .from('notices')
    .select(NOTICE_COLUMNS)
    .order('created_at', { ascending: false })
    // Tiebreak, for the same reason listComments has one: two notices posted in
    // the same second would otherwise swap places between refetches and the
    // hero would flicker between them.
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data
}

export async function getNotice(noticeId: string): Promise<Notice> {
  const { data, error } = await supabase
    .from('notices')
    .select(NOTICE_COLUMNS)
    .eq('id', noticeId)
    .single()
  if (error) throw error
  return data
}

// Staff-only, enforced by the notices_write RLS policy — this module does not
// re-check the role, because a check here would only decide what to render.
export async function createNotice(input: { title: string; body: string }): Promise<Notice> {
  // Asked of the server rather than threaded down from the session, so no caller
  // can pass the wrong id by accident. RLS does not constrain created_by, so
  // this is authorship bookkeeping, not enforcement.
  const { data: memberId, error: memberError } = await supabase.rpc('current_member_id')
  if (memberError) throw memberError

  const { data, error } = await supabase
    .from('notices')
    .insert({ title: input.title.trim(), body: input.body, created_by: memberId })
    .select(NOTICE_COLUMNS)
    .single()
  if (error) throw error
  return data
}

export async function updateNotice(input: {
  noticeId: string
  title: string
  body: string
}): Promise<Notice> {
  const { data, error } = await supabase
    .from('notices')
    .update({
      title: input.title.trim(),
      body: input.body,
      // Set explicitly: the column defaults to now() on insert but no trigger
      // touches it on update, so it would otherwise freeze at creation time.
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.noticeId)
    .select(NOTICE_COLUMNS)
    .single()
  if (error) throw error
  return data
}

export async function deleteNotice(noticeId: string): Promise<void> {
  const { error } = await supabase.from('notices').delete().eq('id', noticeId)
  if (error) throw error
}

export async function listAttachments(noticeId: string): Promise<NoticeAttachment[]> {
  const { data, error } = await supabase
    .from('notice_attachments')
    .select('id, file_name, mime_type, storage_path, sort_order')
    .eq('notice_id', noticeId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) throw error
  return data ?? []
}

// Signed on demand and short-lived, so a link copied out of the page stops
// working quickly.
export async function getAttachmentUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from(ATTACHMENT_BUCKET)
    .createSignedUrl(storagePath, 60)
  if (error) throw error
  return data.signedUrl
}

// The nickname is read through member_public_v, not members: the members_read
// policy only lets someone see their own row, so embedding members directly
// would blank out every other author's name for a non-staff reader.
export async function listComments(noticeId: string): Promise<NoticeComment[]> {
  const { data, error } = await supabase
    .from('notice_comments')
    .select('id, body, created_at, member_id, member_public_v(nickname)')
    .eq('notice_id', noticeId)
    .order('created_at', { ascending: true })
    // Tiebreak so two comments written in the same second keep a stable order
    // instead of swapping places between refetches.
    .order('id', { ascending: true })
  if (error) throw error

  return (data ?? []).map((row) => ({
    id: row.id,
    body: row.body,
    created_at: row.created_at,
    member_id: row.member_id,
    nickname: row.member_public_v?.nickname ?? '알 수 없는 회원',
  }))
}

// Goes through the RPC, never a direct insert into notice_comments: the function
// derives the author from the session, so a client cannot post as someone else,
// and each comment is its own row rather than an element rewritten into a shared
// jsonb array. There is no INSERT policy on the table, so a direct insert fails.
//
// Returns nothing on purpose. The caller refetches for the canonical list rather
// than appending the new row to a local copy — that local append is how the
// legacy screen lost comments written at the same time by someone else.
export async function appendComment(input: { noticeId: string; body: string }): Promise<void> {
  const { error } = await supabase.rpc('append_notice_comment', {
    p_notice_id: input.noticeId,
    p_body: input.body,
  })
  if (error) throw error
}

// ------------------------------------------------------------ 공지 첨부파일
// The write half. Reading was already built — listAttachments, getAttachmentUrl
// and the attachment_count on the list — but nothing could create one, so every
// notice showed 첨부 0.

/** One row as save_notice_v1 hands it back. */
export type SavedAttachment = {
  id: string
  storage_path: string
  file_name: string
  mime_type: string
  /** True for rows this call created, which are exactly the ones to upload. */
  is_new: boolean
}

export type SaveNoticeResult = {
  notice: Notice
  attachments: SavedAttachment[]
  /**
   * Names of files whose ROW was created but whose OBJECT never arrived.
   *
   * This is the accepted failure, not an oversight — the same one
   * uploadMediaFiles lives with. The claim gate (0021) requires the row before
   * the object, so the only two orders available are "row with no object" and
   * "object with no row", and the first is far better: it shows up on the
   * screen as an attachment the uploader can see and delete, while the second
   * is debris nobody can reach. The caller surfaces these names rather than
   * swallowing them.
   */
  uploadFailures: string[]
}

// The generated Args type declares p_attachments as Json, so the payload is
// built as a plain array and cast once here rather than at three call sites.
type AttachmentPayload = { id: string } | { file_name: string; mime_type: string }

function toSavedAttachment(value: unknown): SavedAttachment | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const id = typeof row.id === 'string' ? row.id : null
  const path = typeof row.storage_path === 'string' ? row.storage_path : null
  if (!id || !path) return null
  return {
    id,
    storage_path: path,
    file_name: typeof row.file_name === 'string' ? row.file_name : '파일',
    mime_type: typeof row.mime_type === 'string' ? row.mime_type : 'application/octet-stream',
    is_new: row.is_new === true,
  }
}

/**
 * Save a notice and its attachment list in one transaction, then upload.
 *
 * `keepAttachmentIds` plus `files` is the DESIRED FINAL SET, not a delta:
 * anything already on the notice and not named in `keepAttachmentIds` is
 * deleted by the RPC, which routes its object into the deletion queue through
 * the trigger rather than through anything this function has to remember.
 *
 * THE CLIENT NEVER CHOOSES A PATH. It sends names and types; save_notice_v1
 * derives `<caller member id>/notices/<uuid>` and returns it. That is why the
 * member-supplied file name cannot reach the object path — there is no
 * parameter for it to arrive in — and why no sanitising rule here has to be
 * right about `../`, a null byte, or a name that is entirely dots.
 */
export async function saveNotice(input: {
  noticeId?: string
  title: string
  body: string
  keepAttachmentIds: string[]
  files: File[]
}): Promise<SaveNoticeResult> {
  const payload: AttachmentPayload[] = [
    ...input.keepAttachmentIds.map((id) => ({ id })),
    ...input.files.map((file) => ({
      file_name: file.name,
      // A browser leaves `type` empty for extensions it does not know; the RPC
      // defaults the same way, but sending it explicitly keeps the two ends
      // agreeing rather than relying on both defaults staying in step.
      mime_type: file.type || 'application/octet-stream',
    })),
  ]

  const { data, error } = await supabase.rpc('save_notice_v1', {
    // null, not undefined. p_notice_id has no DEFAULT, so undefined would omit
    // the parameter and PostgREST would fail to resolve the signature — whereas
    // null is what the function reads as "create rather than update".
    p_notice_id: input.noticeId ?? null,
    p_title: input.title,
    p_body: input.body,
    p_attachments: payload as unknown as Json,
  })
  if (error) throw error

  const result = (data ?? {}) as Record<string, unknown>
  const notice = result.notice as Notice
  const attachments = Array.isArray(result.attachments)
    ? result.attachments.flatMap((row) => {
        const parsed = toSavedAttachment(row)
        return parsed ? [parsed] : []
      })
    : []

  // The RPC walks p_attachments in order and returns in the same order, so the
  // new rows line up with `files` positionally. Zipping by index rather than by
  // name because two files picked in one go can share a name.
  const fresh = attachments.filter((row) => row.is_new)
  const uploadFailures: string[] = []

  for (let i = 0; i < fresh.length; i += 1) {
    const target = fresh[i]
    const file = input.files[i]
    if (!target || !file) continue
    const upload = await supabase.storage
      .from(ATTACHMENT_BUCKET)
      .upload(target.storage_path, file, { contentType: target.mime_type, upsert: true })
    if (upload.error) uploadFailures.push(target.file_name)
  }

  return { notice, attachments, uploadFailures }
}

