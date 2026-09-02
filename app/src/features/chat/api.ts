import { supabase } from '../../lib/supabase'
import { chatObjectPath } from '../media/path'
import type { ChatMessage, RoomType } from './reconcile'

/**
 * Reads go straight at the table; the write goes through send_message_v1().
 *
 * That split is not a preference. 0004 gave messages a SELECT policy and no
 * write policy at all, because sends were meant to reach an Edge Function in
 * the president's project — source we cannot read and cannot redeploy. 0012
 * replaces it with a SECURITY DEFINER RPC, so `authenticated` still holds only
 * SELECT on the table and an INSERT from the browser is refused outright
 * (verified: "permission denied for table messages").
 */

const MESSAGE_COLUMNS =
  'id, room_type, sender_id, recipient_id, body, attachment_path, attachment_type, attachment_name, created_at'

// Chat attachments live in the same private bucket as media (0009), so a link
// is a short-lived signed URL rather than a stored URL. An hour, matching
// media: a video is fetched in ranges for as long as somebody watches it.
const CHAT_BUCKET = 'team-files'
const ATTACHMENT_URL_TTL_SECONDS = 3600

// The club is around forty people and the legacy app asked for 200 rows
// (chat_list_v4, index.html:2077). A thread that needed paging would be a
// different screen, and this one already scrolls to the bottom on open.
const THREAD_LIMIT = 200
// Wider, because these rows get collapsed to one per conversation partner: 200
// messages with one chatty partner would otherwise hide every other thread.
const THREAD_PREVIEW_LIMIT = 400

type MessageRow = {
  id: string
  room_type: string
  sender_id: string
  recipient_id: string | null
  body: string | null
  attachment_path: string | null
  attachment_type: string | null
  /**
   * The name the sender chose, or null on a row written before 0049.
   *
   * The storage key cannot carry it: 0042 slugs keys to ASCII because Storage
   * refuses Hangul, so 훈련일지.txt becomes file.txt in the path. This column is
   * the only place the readable name survives.
   */
  attachment_name: string | null
  created_at: string
}

/** The newest message of one conversation, for the 1:1 list. */
export type DmThread = {
  /** The other person — never the viewer. */
  memberId: string
  last: ChatMessage
}

// ---------------------------------------------------------------- narrowing

// The CHECK on messages.room_type allows exactly two values, but the generated
// types widen it to `string`. Leaning to 'dm' for anything unreadable is the
// least privileged answer, the same way members' toRole leans to 'member': a
// token this client does not understand must never widen a row's audience to
// the whole club, and a 'dm' row only ever renders inside the thread whose two
// participants it names.
function toRoomType(value: string): RoomType {
  return value === 'group' ? 'group' : 'dm'
}

function toMessage(row: MessageRow): ChatMessage {
  return { ...row, room_type: toRoomType(row.room_type) }
}

/**
 * A message off the Realtime socket, or null.
 *
 * Validated rather than cast. A select answers with the columns we asked for;
 * a websocket frame is whatever arrived, and a malformed payload should drop
 * one message rather than crash the screen watching the thread.
 */
function parseRealtimeRow(value: unknown): ChatMessage | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Partial<MessageRow>
  if (
    typeof row.id !== 'string' ||
    typeof row.room_type !== 'string' ||
    typeof row.sender_id !== 'string' ||
    typeof row.created_at !== 'string'
  ) {
    return null
  }
  return {
    id: row.id,
    room_type: toRoomType(row.room_type),
    sender_id: row.sender_id,
    recipient_id: typeof row.recipient_id === 'string' ? row.recipient_id : null,
    body: typeof row.body === 'string' ? row.body : null,
    attachment_path: typeof row.attachment_path === 'string' ? row.attachment_path : null,
    attachment_type: typeof row.attachment_type === 'string' ? row.attachment_type : null,
    attachment_name: typeof row.attachment_name === 'string' ? row.attachment_name : null,
    created_at: row.created_at,
  }
}

// PostgREST's `or` filter is a string, so an id from a route parameter is
// interpolated into query syntax. Refusing anything that is not a uuid is what
// keeps a crafted /chat/dm/:memberId from rewriting the filter around it.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function assertMemberId(value: string): string {
  if (!UUID.test(value)) throw new Error('회원을 찾을 수 없습니다')
  return value
}

// ------------------------------------------------------------------- reads

/**
 * The group room, oldest message last.
 *
 * Ordered descending and reversed, because the interesting 200 messages are the
 * newest ones — `ascending: true` with a limit would pin the screen to the day
 * the club started chatting. created_at is not unique under a busy second, so
 * id breaks the tie and the order stays stable across refetches.
 */
export async function listGroupMessages(): Promise<ChatMessage[]> {
  const { data, error } = await supabase
    .from('messages')
    .select(MESSAGE_COLUMNS)
    .eq('room_type', 'group')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(THREAD_LIMIT)
  if (error) throw error

  return (data ?? []).map(toMessage).reverse()
}

/**
 * One 1:1 conversation.
 *
 * The filter only names the other person. It does not also name the viewer,
 * because messages_read (0005) has already done that: every dm row this query
 * can see has the viewer as sender or recipient. Adding `and(sender.eq.me…)`
 * would restate a rule the database already enforces and quietly break the day
 * the policy changed shape.
 */
export async function listDmMessages(otherMemberId: string): Promise<ChatMessage[]> {
  const other = assertMemberId(otherMemberId)

  const { data, error } = await supabase
    .from('messages')
    .select(MESSAGE_COLUMNS)
    .eq('room_type', 'dm')
    .or(`sender_id.eq.${other},recipient_id.eq.${other}`)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(THREAD_LIMIT)
  if (error) throw error

  return (data ?? []).map(toMessage).reverse()
}

/**
 * Every conversation the viewer has, newest first, one row each.
 *
 * Collapsed here rather than in SQL: a DISTINCT ON over "the other participant"
 * needs a CASE on which side the viewer is, and the club is small enough that
 * reading the recent rows and grouping them costs less than a view nobody else
 * would use. Rows arrive newest first, so the first one seen for a partner is
 * their latest message.
 */
export async function listDmThreads(myMemberId: string): Promise<DmThread[]> {
  const me = assertMemberId(myMemberId)

  const { data, error } = await supabase
    .from('messages')
    .select(MESSAGE_COLUMNS)
    .eq('room_type', 'dm')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(THREAD_PREVIEW_LIMIT)
  if (error) throw error

  const threads: DmThread[] = []
  const seen = new Set<string>()
  for (const row of data ?? []) {
    const message = toMessage(row)
    const other = message.sender_id === me ? message.recipient_id : message.sender_id
    if (!other || seen.has(other)) continue
    seen.add(other)
    threads.push({ memberId: other, last: message })
  }
  return threads
}

/** A signed URL for one chat attachment. */
export async function getAttachmentUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from(CHAT_BUCKET)
    .createSignedUrl(storagePath, ATTACHMENT_URL_TTL_SECONDS)
  if (error) throw error
  return data.signedUrl
}

// ------------------------------------------------------------------ writes

/**
 * Send one message.
 *
 * No sender_id argument exists to pass, which is the point: send_message_v1()
 * reads it from the session, so a client has no field to lie in. Verified
 * against the dev database — the row came back with the caller's member id
 * while the call named nobody.
 *
 * p_recipient_id is omitted rather than sent as null for a group message: the
 * generated Args type declares it `string | undefined`, the same shape
 * set_member_team_role_v1 has, because plpgsql signatures cannot say "nullable
 * uuid". Omitting it lets the DEFAULT null apply.
 */
export type SendMessageResult = {
  message: ChatMessage
  /**
   * True when the row was written but its object never reached the bucket.
   *
   * The claim gate (0021) requires the row before the object, so those are the
   * only two orders available and this is the survivable one: the message exists
   * and its attachment does not open yet. It is RECOVERABLE — the row goes on
   * claiming the path, so re-uploading to that same path makes the attachment
   * work for everyone holding the row, because the URL is signed on open.
   *
   * Deleting the message instead would be worse, and 0047 records why: the
   * realtime subscription listens for INSERT only, so the recipient would keep a
   * message that no longer exists in the database until they refreshed.
   */
  uploadFailed: boolean
}

export async function sendMessage(input: {
  roomType: RoomType
  body: string
  /** Required for a dm, and refused for a group message. */
  recipientId?: string | null
  /** Optional attachment. The object is uploaded AFTER the row claims its path. */
  file?: File | null
}): Promise<SendMessageResult> {
  let attachmentPath: string | null = null
  if (input.file) {
    // Asked of the server rather than threaded down, for the same reason
    // createNotice did: a caller that names its own member id can name somebody
    // else's, and this string becomes the first path segment.
    const { data: memberId, error: memberError } = await supabase.rpc('current_member_id')
    if (memberError) throw memberError
    if (!memberId) throw new Error('승인된 회원만 파일을 보낼 수 있습니다')
    attachmentPath = chatObjectPath({ memberId, fileName: input.file.name })
  }

  const { data, error } = await supabase.rpc('send_message_v1', {
    p_room_type: input.roomType,
    p_body: input.body,
    ...(input.roomType === 'dm' && input.recipientId
      ? { p_recipient_id: assertMemberId(input.recipientId) }
      : {}),
    ...(attachmentPath && input.file
      ? {
          p_attachment_path: attachmentPath,
          p_attachment_type: input.file.type || 'application/octet-stream',
          // The name as the member chose it, Hangul and all. It travels beside
          // the path rather than inside it, because the path cannot hold it.
          p_attachment_name: input.file.name,
        }
      : {}),
  })
  if (error) throw error
  if (!data) throw new Error('메시지를 보내지 못했습니다')

  // The RPC returns SETOF messages shaped as one row; supabase-js hands back the
  // row itself because the function is not a set-returning one.
  const message = toMessage(data as unknown as MessageRow)

  if (!attachmentPath || !input.file) return { message, uploadFailed: false }

  // NEVER THROWS PAST THIS POINT. The row is committed, so a throw here would
  // report a sent message as unsent and invite a retry that writes a second one
  // — the same shape of defect the notice form hit and fixed.
  const uploadFailed = await uploadChatObject(attachmentPath, input.file)
  return { message, uploadFailed }
}

/** Returns true when the object did not land. Never throws; see sendMessage. */
async function uploadChatObject(path: string, file: File): Promise<boolean> {
  try {
    const { error } = await supabase.storage
      .from(CHAT_BUCKET)
      // upsert so a resend to the same path replaces a partial object rather
      // than failing on a key the message row already claims.
      .upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: true })
    return Boolean(error)
  } catch {
    return true
  }
}

/**
 * Send the object for a message whose row already exists.
 *
 * This is the resend path, and it works because the row never stopped claiming
 * the path: team_files_update admits an upsert while media_object_is_claimed is
 * true, so the attachment starts working for everyone who already received the
 * message.
 */
export async function resendAttachment(message: ChatMessage, file: File): Promise<boolean> {
  if (!message.attachment_path) return false
  return !(await uploadChatObject(message.attachment_path, file))
}

// --------------------------------------------------------------- realtime

/** Whether incoming messages are actually arriving, so a screen can say so. */
export type ChannelStatus = 'connecting' | 'live' | 'error'

/**
 * Watch for new messages.
 *
 * The legacy pattern, ported: one postgres_changes subscription on INSERTs into
 * public.messages (index.html:2120). What it could not do is filter — an INSERT
 * filter takes one column comparison, and "my dms" is a disjunction over two.
 * RLS does the filtering instead: Realtime evaluates messages_read (0005) as
 * the subscriber, so a dm reaches its two participants and nobody else, and the
 * caller drops whatever does not belong to the room it is showing.
 *
 * 0012 is what makes any of this fire. public.messages was in no publication
 * before it, so this subscription would have reported SUBSCRIBED and then
 * delivered nothing at all.
 */
export function subscribeToMessages(input: {
  /** Distinguishes this channel from other rooms' — names must be unique per client. */
  channelKey: string
  onMessage: (message: ChatMessage) => void
  onStatus?: (status: ChannelStatus) => void
}): () => void {
  const channel = supabase
    .channel(`eysl-chat-${input.channelKey}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (payload) => {
      const message = parseRealtimeRow(payload.new)
      if (message) input.onMessage(message)
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') input.onStatus?.('live')
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED')
        input.onStatus?.('error')
      else input.onStatus?.('connecting')
    })

  return () => {
    void supabase.removeChannel(channel)
  }
}
