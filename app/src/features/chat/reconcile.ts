/**
 * Merging one message into a thread without ever showing it twice.
 *
 * A send has two sources of truth racing each other: send_message_v1() returns
 * the row it inserted, and the Realtime INSERT subscription delivers the same
 * row to the same client. Either can arrive first. Appending on both is the
 * duplicate the legacy app avoided by ignoring every echo whose sender_id was
 * its own (index.html:2122) — which also means a message sent from the member's
 * phone never reaches the same member's laptop until a reload.
 *
 * So reconciliation happens here instead, on the server-assigned id, and every
 * arrival goes through one function no matter which path brought it.
 */

export type RoomType = 'group' | 'dm'

export type ChatMessage = {
  id: string
  room_type: RoomType
  sender_id: string
  recipient_id: string | null
  body: string | null
  attachment_path: string | null
  attachment_type: string | null
  created_at: string
  /**
   * Written but not yet acknowledged. Never true for a row that came back from
   * the database, so `pending` is also what tells a confirmed message from the
   * optimistic copy standing in for it.
   */
  pending?: boolean
  /** The send failed; the bubble offers a retry rather than lying about it. */
  failed?: boolean
}

const PENDING_PREFIX = 'pending:'

/** An id no server row can collide with — `messages.id` is always a uuid. */
export function newPendingId(nonce = Math.random().toString(36).slice(2)): string {
  return `${PENDING_PREFIX}${nonce}`
}

export function isPending(message: ChatMessage): boolean {
  return message.id.startsWith(PENDING_PREFIX)
}

/**
 * Add a message the member has just written, before the server has seen it.
 *
 * Always at the tail: it is the newest thing this person did, whatever their
 * clock says relative to the server's.
 */
export function appendPending(list: readonly ChatMessage[], message: ChatMessage): ChatMessage[] {
  return [...list, { ...message, pending: true }]
}

/**
 * Merge one confirmed row.
 *
 * Three cases, in order:
 *  1. The id is already here — replace it. This is what makes a Realtime echo
 *     of a row the RPC already returned a no-op instead of a second bubble.
 *  2. It is ours and an unconfirmed copy of it is on screen — that pending copy
 *     becomes this row, so the bubble stays put and simply stops being pending.
 *     Matched on content rather than id because a pending message has no server
 *     id to match on; that is the whole problem being solved. Two identical
 *     pending messages resolve in the order they were sent, which is the order
 *     the user sees them in — promoting either is indistinguishable.
 *  3. Somebody else's message, or our own from another device — insert it in
 *     time order among the confirmed messages, ahead of any pending tail.
 */
export function reconcile(list: readonly ChatMessage[], incoming: ChatMessage): ChatMessage[] {
  const confirmed: ChatMessage = { ...incoming, pending: false, failed: false }

  const existing = list.findIndex((m) => m.id === confirmed.id)
  if (existing !== -1) return replaceAt(list, existing, confirmed)

  const claimed = list.findIndex((m) => isPending(m) && sameMessage(m, confirmed))
  if (claimed !== -1) return replaceAt(list, claimed, confirmed)

  return insertByTime(list, confirmed)
}

/** Mark one pending message failed, so its bubble can offer a retry. */
export function markFailed(list: readonly ChatMessage[], pendingId: string): ChatMessage[] {
  const at = list.findIndex((m) => m.id === pendingId)
  if (at === -1) return [...list]
  const message = list[at]
  if (!message) return [...list]
  return replaceAt(list, at, { ...message, failed: true })
}

/** Drop one message by id — a failed send the member gave up on, or retried. */
export function dropMessage(list: readonly ChatMessage[], id: string): ChatMessage[] {
  return list.filter((m) => m.id !== id)
}

/**
 * Replace the whole confirmed set from a refetch while keeping pending messages.
 *
 * A refetch answers with what the server has, which by definition excludes
 * anything still in flight. Dropping the pending tail would make a message the
 * member is watching vanish and then reappear.
 */
export function mergeFetched(
  list: readonly ChatMessage[],
  fetched: readonly ChatMessage[],
): ChatMessage[] {
  const stillPending = list.filter((m) => isPending(m) && !fetched.some((f) => sameMessage(m, f)))
  return [...fetched.map((m) => ({ ...m, pending: false, failed: false })), ...stillPending]
}

// The body is compared trimmed because send_message_v1() trims before storing,
// so the row that comes back is not byte-identical to what was typed.
function sameMessage(a: ChatMessage, b: ChatMessage): boolean {
  return (
    a.sender_id === b.sender_id &&
    a.room_type === b.room_type &&
    a.recipient_id === b.recipient_id &&
    (a.body ?? '').trim() === (b.body ?? '').trim() &&
    a.attachment_path === b.attachment_path
  )
}

function replaceAt(
  list: readonly ChatMessage[],
  index: number,
  message: ChatMessage,
): ChatMessage[] {
  const next = [...list]
  next[index] = message
  return next
}

function insertByTime(list: readonly ChatMessage[], incoming: ChatMessage): ChatMessage[] {
  const next = [...list]
  let at = next.length
  while (at > 0) {
    const previous = next[at - 1]
    if (!previous) break
    // Walk back over the pending tail first, then over anything the server
    // timestamped later than this row — a message can arrive out of order when
    // two clients write in the same instant.
    if (isPending(previous) || previous.created_at > incoming.created_at) {
      at -= 1
      continue
    }
    break
  }
  next.splice(at, 0, incoming)
  return next
}
