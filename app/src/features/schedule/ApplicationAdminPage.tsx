import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { supabase } from '../../lib/supabase'
import { viewerKey } from '../../lib/queryKeys'
import { useSession } from '../auth/SessionProvider'
import {
  ACTIVITY_KINDS,
  KIND_LABEL,
  listApplicationSummaries,
  type ActivityKind,
  type ApplicantName,
  type ApplicationSummary,
} from './api'
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
    </article>
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
