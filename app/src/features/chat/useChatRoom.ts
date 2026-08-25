import { useCallback, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { AsyncQuery } from '../../components/ui/AsyncSection'
import {
  listDmMessages,
  listGroupMessages,
  sendMessage,
  subscribeToMessages,
  type ChannelStatus,
} from './api'
import {
  appendPending,
  dropMessage,
  markFailed,
  mergeFetched,
  newPendingId,
  reconcile,
  type ChatMessage,
} from './reconcile'

/** Which conversation a screen is showing. */
export type Room = { kind: 'group' } | { kind: 'dm'; otherMemberId: string }

export type ChatRoom = {
  /** For AsyncSection — the loading, empty and failed branches of the first fetch. */
  query: AsyncQuery<ChatMessage[]>
  /** Whether new messages are actually arriving, so the screen can admit it when they are not. */
  status: ChannelStatus
  saveState: 'idle' | 'saving' | 'saved' | 'error'
  send: (body: string) => void
  /** Re-send a message whose first attempt failed, replacing the failed bubble. */
  retry: (message: ChatMessage) => void
  /** Give up on a failed message and take it off the screen. */
  dismiss: (message: ChatMessage) => void
}

/**
 * One chat room: the messages in it, the socket telling it about new ones, and
 * sending.
 *
 * The fetched rows and the live ones are folded into a single list here rather
 * than in the query cache, because that list also holds messages the server has
 * not seen yet. Every arrival — first fetch, refetch, socket, or the send's own
 * response — goes through reconcile.ts, which is where the duplicate-bubble
 * problem is actually solved.
 */
export function useChatRoom(input: { room: Room; myMemberId: string }): ChatRoom {
  const { room, myMemberId } = input
  const otherMemberId = room.kind === 'dm' ? room.otherMemberId : null

  const query = useQuery({
    queryKey: otherMemberId ? ['chat', 'dm', otherMemberId] : ['chat', 'group'],
    queryFn: () => (otherMemberId ? listDmMessages(otherMemberId) : listGroupMessages()),
    // A room is a conversation people watch, not a cached page — the socket
    // keeps it current and a refocus should not repaint it from scratch.
    staleTime: 60_000,
  })

  const [thread, setThread] = useState<ChatMessage[]>([])
  const [status, setStatus] = useState<ChannelStatus>('connecting')
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  const fetched = query.data
  useEffect(() => {
    if (!fetched) return
    // mergeFetched keeps anything still in flight; a refetch cannot know about
    // a message the server has not accepted yet.
    setThread((current) => mergeFetched(current, fetched))
  }, [fetched])

  // Whether a row off the socket belongs on this screen. The subscription is
  // unfiltered because a postgres_changes filter is one column comparison and
  // "this dm" is a disjunction over two — RLS decides what arrives, this
  // decides which room it goes in.
  const belongsHere = useCallback(
    (message: ChatMessage) => {
      if (!otherMemberId) return message.room_type === 'group'
      if (message.room_type !== 'dm') return false
      const pair = [message.sender_id, message.recipient_id]
      return pair.includes(otherMemberId) && pair.includes(myMemberId)
    },
    [otherMemberId, myMemberId],
  )

  useEffect(() => {
    return subscribeToMessages({
      channelKey: otherMemberId ? `dm-${otherMemberId}` : 'group',
      onStatus: setStatus,
      onMessage: (message) => {
        if (!belongsHere(message)) return
        setThread((current) => reconcile(current, message))
      },
    })
  }, [otherMemberId, belongsHere])

  const mutation = useMutation({
    mutationFn: (vars: { pendingId: string; body: string }) =>
      sendMessage({ roomType: room.kind, body: vars.body, recipientId: otherMemberId }),
    onMutate: () => setSaveState('saving'),
    onSuccess: (row, vars) => {
      // Drop the optimistic copy by its own id and merge the server row by its
      // id. If the socket echo already claimed the pending bubble, the drop
      // finds nothing and reconcile replaces the row in place — one bubble
      // either way, whichever arrived first.
      setThread((current) => reconcile(dropMessage(current, vars.pendingId), row))
      setSaveState('saved')
    },
    onError: (_error, vars) => {
      setThread((current) => markFailed(current, vars.pendingId))
      setSaveState('error')
    },
  })

  const submit = useCallback(
    (body: string) => {
      const trimmed = body.trim()
      // send_message_v1() refuses an empty body, so this is the same rule said
      // early enough to cost no round trip.
      if (trimmed === '') return

      const pendingId = newPendingId()
      setThread((current) =>
        appendPending(current, {
          id: pendingId,
          room_type: otherMemberId ? 'dm' : 'group',
          sender_id: myMemberId,
          recipient_id: otherMemberId,
          body: trimmed,
          attachment_path: null,
          attachment_type: null,
          created_at: new Date().toISOString(),
        }),
      )
      mutation.mutate({ pendingId, body: trimmed })
    },
    [mutation, myMemberId, otherMemberId],
  )

  const retry = useCallback(
    (message: ChatMessage) => {
      setThread((current) => dropMessage(current, message.id))
      submit(message.body ?? '')
    },
    [submit],
  )

  const dismiss = useCallback((message: ChatMessage) => {
    setThread((current) => dropMessage(current, message.id))
    setSaveState('idle')
  }, [])

  const asyncQuery = useMemo<AsyncQuery<ChatMessage[]>>(
    () => ({
      // Until the first fetch settles there is nothing to show but the
      // skeleton, even though `thread` is an array from the first render.
      data: query.isPending ? undefined : thread,
      isPending: query.isPending,
      isError: query.isError,
      refetch: () => void query.refetch(),
    }),
    [query, thread],
  )

  return { query: asyncQuery, status, saveState, send: submit, retry, dismiss }
}
