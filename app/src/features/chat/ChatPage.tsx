import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { AsyncSection, Shimmer, type AsyncQuery } from '../../components/ui/AsyncSection'
import { useCurrentUser } from '../auth/useCurrentUser'
import { MemberAvatar } from '../members/MemberAvatar'
import { listRoster, type RosterMember } from '../members/api'
import { Composer, ConnectionNotice } from './Composer'
import { MessageThread } from './MessageThread'
import { listDmThreads, type DmThread } from './api'
import { useChatRoom } from './useChatRoom'

const CARD = {
  padding: 14,
  border: '1px solid #e1e5ea',
  borderRadius: 18,
  background: '#fff',
} as const

const DATE_FORMAT = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric' })

type Tab = 'group' | 'dm'

/**
 * 채팅 — the group room and the list of 1:1 conversations.
 *
 * Two tabs on one route rather than two routes, matching the legacy app, where
 * both live on the `chat` page and only one dm thread gets a screen of its own
 * (index.html: `chat` with its `dmView`, then `dmChat`).
 */
export function ChatPage() {
  const { user } = useCurrentUser()
  const [tab, setTab] = useState<Tab>('group')

  // RequireAuth holds this screen until the member row has loaded, so this is
  // unreachable — it exists so the id below is a string rather than a cast.
  if (!user) return null

  return (
    <div className="page">
      <h1 style={{ fontSize: 26, letterSpacing: -1.2, margin: 0 }}>채팅</h1>

      <div style={{ display: 'flex', gap: 8, margin: '14px 0 16px' }}>
        <TabButton active={tab === 'group'} onClick={() => setTab('group')}>
          단체 채팅
        </TabButton>
        <TabButton active={tab === 'dm'} onClick={() => setTab('dm')}>
          1:1 대화
        </TabButton>
      </div>

      {/* Mounted one at a time on purpose: each room owns a Realtime channel,
          and a channel for a thread nobody is looking at is a subscription
          paid for and thrown away. */}
      {tab === 'group' ? <GroupRoom myMemberId={user.id} /> : <DmList myMemberId={user.id} />}
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      style={{
        minHeight: 44,
        padding: '0 16px',
        borderRadius: 13,
        border: `1px solid ${active ? '#111317' : '#e1e5ea'}`,
        background: active ? '#111317' : '#fff',
        color: active ? '#fff' : '#6b7178',
        fontSize: 13,
      }}
    >
      {children}
    </button>
  )
}

function GroupRoom({ myMemberId }: { myMemberId: string }) {
  const room = useChatRoom({ room: { kind: 'group' }, myMemberId })

  // Not awaited before the thread renders. MessageThread falls back to
  // 알 수 없는 회원 for a sender it cannot name, so the conversation appears
  // immediately and the faces fill in — rather than the whole room waiting on
  // forty signed avatar URLs.
  const roster = useRosterById()

  return (
    <div>
      <ConnectionNotice status={room.status} onRefresh={room.query.refetch} />

      <div style={{ ...CARD, minHeight: 240 }}>
        <AsyncSection
          query={room.query}
          isEmpty={(messages) => messages.length === 0}
          loading={<Shimmer rows={4} />}
          empty="아직 메시지가 없습니다. 먼저 인사를 건네보세요."
          error="메시지를 불러오지 못했습니다"
        >
          {(messages) => (
            <MessageThread
              messages={messages}
              myMemberId={myMemberId}
              roster={roster}
              onRetry={room.retry}
              onDismiss={room.dismiss}
            />
          )}
        </AsyncSection>
      </div>

      <div style={{ marginTop: 12 }}>
        <Composer
          onSend={room.send}
          saveState={room.saveState}
          placeholder="단체 채팅에 메시지 보내기"
        />
      </div>
    </div>
  )
}

/** One row of the 1:1 list: a member, and the last thing either of you said. */
type DmEntry = {
  member: RosterMember
  last: DmThread['last'] | null
}

function DmList({ myMemberId }: { myMemberId: string }) {
  const rosterQuery = useQuery({ queryKey: ['roster'], queryFn: listRoster })
  const threadsQuery = useQuery({
    queryKey: ['chat', 'dm-threads', myMemberId],
    queryFn: () => listDmThreads(myMemberId),
  })

  // Both halves are needed to draw a row, so they are presented to AsyncSection
  // as one query — otherwise the screen shows a skeleton, then a list, then a
  // second skeleton when the previews arrive.
  const query = useMemo<AsyncQuery<DmEntry[]>>(() => {
    const roster = rosterQuery.data
    const threads = threadsQuery.data
    return {
      data: roster && threads ? combine(roster, threads, myMemberId) : undefined,
      isPending: rosterQuery.isPending || threadsQuery.isPending,
      isError: rosterQuery.isError || threadsQuery.isError,
      refetch: () => {
        void rosterQuery.refetch()
        void threadsQuery.refetch()
      },
    }
  }, [rosterQuery, threadsQuery, myMemberId])

  return (
    <AsyncSection
      query={query}
      isEmpty={(entries) => entries.length === 0}
      loading={<Shimmer rows={4} />}
      empty="대화할 수 있는 다른 회원이 없습니다"
      error="회원 목록을 불러오지 못했습니다"
    >
      {(entries) => (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 9 }}>
          {entries.map((entry) => (
            <li key={entry.member.id}>
              <Link
                to={`/chat/dm/${entry.member.id}`}
                style={{
                  ...CARD,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 11,
                  minHeight: 44,
                  textDecoration: 'none',
                  color: '#111317',
                }}
              >
                <MemberAvatar member={entry.member} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <b style={{ fontSize: 14 }}>{entry.member.nickname}</b>
                  <span
                    style={{
                      display: 'block',
                      fontSize: 11,
                      color: '#6b7178',
                      margin: '3px 0 0',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {preview(entry.last)}
                  </span>
                </span>
                {entry.last && (
                  <span style={{ fontSize: 10, color: '#858b94', flexShrink: 0 }}>
                    {DATE_FORMAT.format(new Date(entry.last.created_at))}
                  </span>
                )}
                <span aria-hidden="true" style={{ color: '#858b94' }}>
                  ›
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </AsyncSection>
  )
}

/**
 * Every member you could talk to, the ones you already have talked to first.
 *
 * The roster is the source of who exists — the same choice the legacy app makes
 * (index.html:2245) — so a member you have never messaged is still reachable.
 * Ordering by last message puts live conversations at the top and leaves the
 * rest alphabetical, which is the order listRoster already returns.
 */
function combine(roster: RosterMember[], threads: DmThread[], myMemberId: string): DmEntry[] {
  const lastByMember = new Map(threads.map((thread) => [thread.memberId, thread.last]))

  return roster
    .filter((member) => member.id !== myMemberId)
    .map((member) => ({ member, last: lastByMember.get(member.id) ?? null }))
    .sort((a, b) => {
      if (a.last && b.last) return a.last.created_at < b.last.created_at ? 1 : -1
      if (a.last) return -1
      if (b.last) return 1
      return 0
    })
}

function preview(last: DmThread['last'] | null): string {
  if (!last) return '아직 대화가 없습니다'
  return last.body ?? '첨부파일'
}

/** The roster as a lookup, for naming the sender of a message. */
export function useRosterById(): Map<string, RosterMember> {
  const query = useQuery({ queryKey: ['roster'], queryFn: listRoster })
  return useMemo(
    () => new Map((query.data ?? []).map((member) => [member.id, member])),
    [query.data],
  )
}
