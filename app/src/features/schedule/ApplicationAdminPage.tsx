import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { supabase } from '../../lib/supabase'
import { viewerKey } from '../../lib/queryKeys'
import { useSession } from '../auth/SessionProvider'
import {
  ACTIVITY_KINDS,
  KIND_LABEL,
  enrolMember,
  listApplicationSummaries,
  listEnrollableMembers,
  unenrolMember,
  type ActivityKind,
  type ApplicantName,
  type ApplicationSummary,
} from './api'
import { explainEnrolFailure } from './enrolment'
import { formatDateLabel, formatTimeRange } from './order'

const CARD = {
  padding: 14,
  border: '1px solid #e1e5ea',
  borderRadius: 18,
  background: '#fff',
} as const

const TAG = {
  display: 'inline-block',
  padding: '3px 9px',
  borderRadius: 999,
  fontSize: 12,
} as const

// 전체 plus his three kinds, in his order (upstream:1216).
type Filter = 'all' | ActivityKind
const FILTERS: readonly Filter[] = ['all', ...ACTIVITY_KINDS]
const FILTER_LABEL: Record<Filter, string> = { all: '전체', ...KIND_LABEL }

export function ApplicationAdminPage() {
  const { session } = useSession()
  const [filter, setFilter] = useState<Filter>('all')

  // Asked of the server rather than read off the session, for the same reason
  // MemberActivityPage asks: applications_read hands a non-staff caller their
  // own applications, so without this the screen would render one member's
  // history as though it were the club's roster. RequireStaff decides what
  // renders; this decides what the page is willing to claim.
  const staff = useQuery({
    // The most identity-bound key on the list: it caches whether THE VIEWER is
    // staff, and this screen decides what to render from it. Answered out of a
    // previous reader's cache, it is the one entry here that could show a
    // member the club's whole application roster.
    queryKey: viewerKey(['is-staff'], session?.user.id),
    queryFn: async () => {
      const { data, error } = await supabase.rpc('is_staff')
      if (error) throw error
      return data === true
    },
  })

  const query = useQuery({
    queryKey: ['application-summaries', filter],
    queryFn: () => listApplicationSummaries(filter === 'all' ? undefined : filter),
    enabled: staff.data === true,
  })

  return (
    <div className="page">
      <Link to="/" className="backLink">
        ← 홈
      </Link>
      <h1 style={{ fontSize: 22, letterSpacing: -0.8, margin: '12px 0 16px' }}>활동 취합본</h1>

      {staff.isPending ? (
        <Shimmer rows={3} />
      ) : staff.data !== true ? (
        <p style={{ ...CARD, fontSize: 13, color: '#6b7178', margin: 0 }}>
          운영진만 신청 현황을 조회할 수 있습니다.
        </p>
      ) : (
        <>
          <div
            role="tablist"
            aria-label="활동 종류"
            style={{ display: 'flex', gap: 7, marginBottom: 14, flexWrap: 'wrap' }}
          >
            {FILTERS.map((value) => (
              <button
                key={value}
                role="tab"
                aria-selected={filter === value}
                onClick={() => setFilter(value)}
                style={{
                  minHeight: 44,
                  padding: '0 16px',
                  borderRadius: 13,
                  fontSize: 13,
                  border: filter === value ? 0 : '1px solid #e1e5ea',
                  background: filter === value ? '#111317' : '#fff',
                  color: filter === value ? '#fff' : '#6b7178',
                }}
              >
                {FILTER_LABEL[value]}
              </button>
            ))}
          </div>

          <AsyncSection
            query={query}
            isEmpty={(rows) => rows.length === 0}
            loading={<Shimmer rows={4} />}
            empty="조건에 맞는 활동이 없습니다"
            error="신청 현황을 불러오지 못했습니다"
          >
            {(rows) => (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 9 }}>
                {rows.map((row) => (
                  <li key={row.activity.id}>
                    <SummaryCard summary={row} />
                  </li>
                ))}
              </ul>
            )}
          </AsyncSection>
        </>
      )}
    </div>
  )
}

function SummaryCard({ summary }: { summary: ApplicationSummary }) {
  const { activity, participants, waitlist, finished } = summary
  const when = [
    formatDateLabel(activity.activity_date),
    formatTimeRange(activity.start_time, activity.end_time),
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <article style={CARD}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <b style={{ fontSize: 15 }}>{activity.title}</b>
          <p style={{ fontSize: 11, color: '#6b7178', margin: '4px 0 0' }}>
            {when} · {KIND_LABEL[activity.kind]}
            {activity.place ? ` · ${activity.place}` : ''}
          </p>
        </div>
        <span
          style={{
            ...TAG,
            flexShrink: 0,
            background: finished ? '#eef0f2' : '#edf7f2',
            color: finished ? '#6b7178' : '#11805b',
          }}
        >
          {finished ? '종료' : KIND_LABEL[activity.kind]}
        </span>
      </div>

      {/* Participants and waitlist are shown apart rather than as one list of
          names. His card merges them (upstream:4119), but our schema keeps the
          distinction and a staffer counting seats needs it — capacity is what
          the split means. */}
      <Group
        label="신청"
        people={participants}
        capacity={activity.capacity}
        emptyText="신청한 회원이 없습니다"
      />
      {waitlist.length > 0 && <Group label="대기" people={waitlist} showOrder />}

      <EnrolPanel activityId={activity.id} />
    </article>
  )
}

/**
 * 명단 추가 — the club's 36 members who have never had an account.
 *
 * Collapsed by default and fetched only when opened. This page lists up to 200
 * activities and the list is per-activity, so eager loading would be 200 round
 * trips for a panel almost nobody expands on any given card.
 *
 * Being inside the panel is also what marks who cannot be reached: everybody
 * shown here is somebody who will not get a push and cannot answer a waitlist
 * offer, and the ones with 명단에 있음 are the ones already on this activity.
 */
function EnrolPanel({ activityId }: { activityId: string }) {
  const [open, setOpen] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const qc = useQueryClient()

  const query = useQuery({
    queryKey: ['enrollable-members', activityId],
    queryFn: () => listEnrollableMembers(activityId),
    enabled: open,
  })

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['enrollable-members', activityId] })
    void qc.invalidateQueries({ queryKey: ['application-summaries'] })
  }

  const add = useMutation({
    mutationFn: (memberId: string) => enrolMember(activityId, memberId),
    onMutate: () => setFailure(null),
    onSuccess: refresh,
    onError: (error) => setFailure(explainEnrolFailure(error)),
  })

  const remove = useMutation({
    mutationFn: (memberId: string) => unenrolMember(activityId, memberId),
    onMutate: () => setFailure(null),
    onSuccess: refresh,
    onError: (error) => setFailure(explainEnrolFailure(error)),
  })

  const busy = add.isPending || remove.isPending

  return (
    <section style={{ marginTop: 12, borderTop: '1px solid #f0f2f4', paddingTop: 10 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          minHeight: 44,
          padding: '0 14px',
          borderRadius: 13,
          border: '1px solid #e1e5ea',
          background: '#fff',
          color: '#111317',
          fontSize: 13,
        }}
      >
        {open ? '명단 추가 닫기' : '명단 추가'}
      </button>

      {open && (
        <>
          <p style={{ fontSize: 11, color: '#6b7178', margin: '9px 0 0' }}>
            앱에 가입한 적이 없어 스스로 신청할 수 없는 회원입니다. 알림을 받지 못하고 대기 순번
            제안에도 응답할 수 없습니다.
          </p>

          {failure && (
            <p role="alert" style={{ fontSize: 12, color: '#b3261e', margin: '7px 0 0' }}>
              {failure}
            </p>
          )}

          <AsyncSection
            query={query}
            isEmpty={(rows) => rows.length === 0}
            loading={<Shimmer rows={2} />}
            empty="추가할 수 있는 회원이 없습니다"
            error="회원 목록을 불러오지 못했습니다"
          >
            {(rows) => (
              <ul
                style={{
                  listStyle: 'none',
                  padding: 0,
                  margin: '9px 0 0',
                  display: 'grid',
                  gap: 6,
                }}
              >
                {rows.map((person) => (
                  <li
                    key={person.memberId}
                    style={{ display: 'flex', alignItems: 'center', gap: 9 }}
                  >
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13 }}>{person.nickname}</span>
                    {person.alreadyEnrolled && (
                      <span style={{ ...TAG, background: '#edf7f2', color: '#11805b' }}>
                        명단에 있음
                      </span>
                    )}
                    <button
                      disabled={busy}
                      onClick={() =>
                        person.alreadyEnrolled
                          ? remove.mutate(person.memberId)
                          : add.mutate(person.memberId)
                      }
                      style={{
                        minHeight: 44,
                        minWidth: 64,
                        borderRadius: 13,
                        border: '1px solid #e1e5ea',
                        background: '#fff',
                        color: person.alreadyEnrolled ? '#b3261e' : '#111317',
                        fontSize: 13,
                        opacity: busy ? 0.5 : 1,
                      }}
                    >
                      {person.alreadyEnrolled ? '빼기' : '추가'}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </AsyncSection>
        </>
      )}
    </section>
  )
}

function Group({
  label,
  people,
  capacity,
  emptyText,
  showOrder = false,
}: {
  label: string
  people: ApplicantName[]
  capacity?: number | null
  emptyText?: string
  showOrder?: boolean
}) {
  return (
    <section style={{ marginTop: 12 }}>
      <h3 style={{ fontSize: 12, color: '#6b7178', fontWeight: 400, margin: '0 0 7px' }}>
        {label} {people.length}명{capacity ? ` / 정원 ${capacity}명` : ''}
      </h3>

      {people.length === 0 ? (
        <p style={{ fontSize: 12, color: '#6b7178', margin: 0 }}>{emptyText}</p>
      ) : (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {people.map((person) => (
            <span key={person.memberId} style={{ ...TAG, background: '#f5f6f8', color: '#111317' }}>
              {showOrder && person.wait_order ? `${person.wait_order}. ` : ''}
              {person.nickname}
            </span>
          ))}
        </div>
      )}
    </section>
  )
}
