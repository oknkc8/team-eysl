import { describe, it, expect } from 'vitest'
import {
  appendPending,
  dropMessage,
  markFailed,
  mergeFetched,
  newPendingId,
  reconcile,
  type ChatMessage,
} from './reconcile'

const ME = '00000000-0000-4000-8000-00000000000a'
const OTHER = '00000000-0000-4000-8000-00000000000b'

function message(overrides: Partial<ChatMessage> & Pick<ChatMessage, 'id'>): ChatMessage {
  return {
    room_type: 'group',
    sender_id: ME,
    recipient_id: null,
    body: '안녕하세요',
    attachment_path: null,
    attachment_type: null,
    created_at: '2026-08-25T09:30:00.000+00:00',
    ...overrides,
  }
}

describe('the send/echo race', () => {
  // Both orderings have to end in one bubble. This is the defect the whole
  // module exists for: the RPC returns the inserted row and Realtime delivers
  // the same row, so whichever arrives second must not append.
  it('collapses when the RPC answers first and the echo follows', () => {
    const pendingId = newPendingId('one')
    const server = message({ id: 'srv-1' })

    let list = appendPending([], message({ id: pendingId }))
    list = reconcile(list, server) // RPC response
    list = reconcile(list, server) // Realtime echo of the same row

    expect(list).toHaveLength(1)
    expect(list[0]?.id).toBe('srv-1')
    expect(list[0]?.pending).toBe(false)
  })

  it('collapses when the echo arrives before the RPC answers', () => {
    const pendingId = newPendingId('two')
    const server = message({ id: 'srv-2' })

    let list = appendPending([], message({ id: pendingId }))
    list = reconcile(list, server) // Realtime echo, first
    list = reconcile(list, server) // RPC response, second

    expect(list).toHaveLength(1)
    expect(list[0]?.id).toBe('srv-2')
  })

  // Nothing else on screen may be disturbed while that happens.
  it('leaves other people’s messages alone', () => {
    const theirs = message({
      id: 'srv-0',
      sender_id: OTHER,
      created_at: '2026-08-25T09:00:00.000+00:00',
    })
    const mine = message({ id: 'srv-3', created_at: '2026-08-25T09:31:00.000+00:00' })

    let list = reconcile([], theirs)
    list = appendPending(list, message({ id: newPendingId('three') }))
    list = reconcile(list, mine)

    expect(list.map((m) => m.id)).toEqual(['srv-0', 'srv-3'])
  })

  // Two identical messages sent in a row is the case content-matching could get
  // wrong. It must resolve one per confirmation, never both at once.
  it('resolves two identical pending messages one at a time', () => {
    const first = message({ id: 'srv-4', created_at: '2026-08-25T09:30:01.000+00:00' })
    const second = message({ id: 'srv-5', created_at: '2026-08-25T09:30:02.000+00:00' })

    let list = appendPending([], message({ id: newPendingId('a') }))
    list = appendPending(list, message({ id: newPendingId('b') }))
    expect(list).toHaveLength(2)

    list = reconcile(list, first)
    expect(list).toHaveLength(2)
    expect(list.filter((m) => m.pending)).toHaveLength(1)

    list = reconcile(list, second)
    expect(list.map((m) => m.id)).toEqual(['srv-4', 'srv-5'])
    expect(list.some((m) => m.pending)).toBe(false)
  })

  // send_message_v1() trims before storing, so the row that comes back is not
  // byte-identical to what was typed.
  it('matches a pending message whose body the server trimmed', () => {
    const pendingId = newPendingId('trim')
    let list = appendPending([], message({ id: pendingId, body: '  안녕하세요  ' }))
    list = reconcile(list, message({ id: 'srv-6', body: '안녕하세요' }))

    expect(list).toHaveLength(1)
    expect(list[0]?.body).toBe('안녕하세요')
  })

  // A message with the same text from the other side of a DM is not our echo.
  it('does not let someone else’s identical text claim our pending bubble', () => {
    const list = appendPending(
      [],
      message({ id: newPendingId('dm'), room_type: 'dm', recipient_id: OTHER }),
    )
    const theirs = message({
      id: 'srv-7',
      room_type: 'dm',
      sender_id: OTHER,
      recipient_id: ME,
    })

    expect(reconcile(list, theirs)).toHaveLength(2)
  })
})

describe('ordering', () => {
  it('puts a late-arriving older message in its place, not at the end', () => {
    let list = reconcile([], message({ id: 'b', created_at: '2026-08-25T09:02:00.000+00:00' }))
    list = reconcile(list, message({ id: 'c', created_at: '2026-08-25T09:03:00.000+00:00' }))
    list = reconcile(list, message({ id: 'a', created_at: '2026-08-25T09:01:00.000+00:00' }))

    expect(list.map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  // A phone whose clock is minutes ahead would otherwise sink its own unsent
  // message into the middle of the thread.
  it('keeps pending messages at the tail whatever the client clock says', () => {
    let list = appendPending(
      [],
      message({ id: newPendingId('late'), created_at: '2000-01-01T00:00:00.000+00:00' }),
    )
    list = reconcile(list, message({ id: 'srv-8', sender_id: OTHER, body: '다른 사람' }))

    expect(list.map((m) => m.pending ?? false)).toEqual([false, true])
  })
})

describe('failure and refetch', () => {
  it('marks a pending message failed and can drop it', () => {
    const pendingId = newPendingId('fail')
    let list = appendPending([], message({ id: pendingId }))

    list = markFailed(list, pendingId)
    expect(list[0]?.failed).toBe(true)

    list = dropMessage(list, pendingId)
    expect(list).toHaveLength(0)
  })

  it('ignores a failure for a message that is already gone', () => {
    expect(markFailed([], 'pending:missing')).toEqual([])
  })

  // A refetch is the server's whole answer, so it replaces the confirmed set —
  // but a message still in flight is not in that answer and must survive it.
  it('keeps an in-flight message across a refetch', () => {
    const pendingId = newPendingId('inflight')
    const list = appendPending(
      [message({ id: 'srv-9', body: '이전 메시지' })],
      message({ id: pendingId }),
    )

    const merged = mergeFetched(list, [message({ id: 'srv-9', body: '이전 메시지' })])

    expect(merged.map((m) => m.id)).toEqual(['srv-9', pendingId])
  })

  it('drops a pending copy the refetch already contains', () => {
    const pendingId = newPendingId('landed')
    const list = appendPending([], message({ id: pendingId, body: '도착함' }))

    const merged = mergeFetched(list, [message({ id: 'srv-10', body: '도착함' })])

    expect(merged.map((m) => m.id)).toEqual(['srv-10'])
  })
})
