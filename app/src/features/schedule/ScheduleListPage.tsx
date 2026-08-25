import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { useCurrentUser } from '../auth/useCurrentUser'
import { creatableKinds } from './permissions'
import { msUntil } from './countdown'
import { formatDateLabel, formatTimeRange, todayKey } from './order'
import {
  ACTIVITY_KINDS,
  KIND_LABEL,
  listSchedule,
  type ActivityKind,
  type ScheduleEntry,
} from './api'

type Filter = ActivityKind | 'all'

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: '전체' },
  ...ACTIVITY_KINDS.map((kind) => ({ value: kind, label: KIND_LABEL[kind] })),
]

const CARD = {
  padding: 14,
  border: '1px solid #e1e5ea',
  borderRadius: 18,
  background: '#fff',
} as const

export function ScheduleListPage() {
  const { user } = useCurrentUser()
  const [filter, setFilter] = useState<Filter>('all')
  // Since 0015 every approved member may file a 기타, so this button is no longer
  // staff-only — what changes with the role is how many kinds the form offers.
  const kinds = creatableKinds(user)
  // A member gets one kind and the button names it; staff get three and the
  // button stays generic, because the form is where they pick.
  const soleKind = kinds.length === 1 ? kinds[0] : undefined

  const query = useQuery({
    queryKey: ['schedule', filter],
    queryFn: () => listSchedule(filter === 'all' ? undefined : filter),
  })

  return (
    <div style={{ padding: 18, background: '#f5f6f8', minHeight: '100vh' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 style={{ fontSize: 22, letterSpacing: -0.8, margin: 0 }}>일정</h1>
        {/* Presentation only, as before: activities_member_event_insert is what
            refuses a member's 훈련, and the label just avoids offering one. */}
        {kinds.length > 0 && (
          <Link
            to="/schedule/new"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              minHeight: 44,
              padding: '0 16px',
              borderRadius: 13,
              background: '#111317',
              color: '#fff',
              fontSize: 13,
              textDecoration: 'none',
            }}
          >
            {soleKind ? `${KIND_LABEL[soleKind]} 등록` : '새 일정'}
          </Link>
        )}
      </header>

      <div
        role="group"
        aria-label="일정 종류"
        style={{ display: 'flex', gap: 7, flexWrap: 'wrap', margin: '14px 0 0' }}
      >
        {FILTERS.map((option) => {
          const selected = filter === option.value
          return (
            <button
              key={option.value}
              onClick={() => setFilter(option.value)}
              aria-pressed={selected}
              style={{
                minHeight: 44,
                minWidth: 64,
                padding: '0 16px',
                borderRadius: 999,
                border: selected ? '1px solid #111317' : '1px solid #e1e5ea',
                background: selected ? '#111317' : '#fff',
                color: selected ? '#fff' : '#111317',
                fontSize: 13,
              }}
            >
              {option.label}
            </button>
          )
        })}
      </div>

      <div style={{ marginTop: 16 }}>
        <AsyncSection
          query={query}
          isEmpty={(rows) => rows.length === 0}
          loading={<Shimmer rows={4} />}
          empty="등록된 일정이 없습니다"
          error="일정을 불러오지 못했습니다"
        >
          {(rows) => <ScheduleList rows={rows} />}
        </AsyncSection>
      </div>
    </div>
  )
}

function ScheduleList({ rows }: { rows: ScheduleEntry[] }) {
  // Computed once per render rather than per row, so a list that happens to be
  // on screen at midnight cannot split its own sections inconsistently.
  const today = todayKey()

  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 9 }}>
      {rows.map((entry, index) => {
        const isPast = entry.activity.activity_date < today
        const previous = rows[index - 1]
        // sortUpcomingFirst() guarantees every past row follows every upcoming
        // one, so the first past row is where the divider belongs.
        const opensPast = isPast && (!previous || previous.activity.activity_date >= today)

        return (
          <li key={entry.activity.id}>
            {opensPast && (
              <h2 style={{ fontSize: 13, color: '#6b7178', fontWeight: 400, margin: '14px 0 9px' }}>
                지난 일정
              </h2>
            )}
            <ActivityCard entry={entry} dimmed={isPast} />
          </li>
        )
      })}
    </ul>
  )
}

type Tag = { label: string; background: string; color: string }

// Reads the viewer's own row, never the counts beside it. Whether they hold a
// seat was decided by apply_to_activity() under a row lock; recomputing it here
// from participant_count against capacity is exactly the legacy defect.
function myStatusTag(mine: ScheduleEntry['mine']): Tag | null {
  if (!mine) return null

  if (mine.offer_status === 'offered' && msUntil(mine.offer_expires_at) > 0)
    return { label: '자리 났어요', background: '#925900', color: '#fff' }

  if (mine.application_type === 'participant')
    return { label: '참가확정', background: '#edf7f2', color: '#11805b' }

  return {
    label: mine.wait_order === null ? '대기 중' : `대기 ${mine.wait_order}번째`,
    background: '#fff0d6',
    color: '#925900',
  }
}

function ActivityCard({ entry, dimmed }: { entry: ScheduleEntry; dimmed: boolean }) {
  const { activity } = entry
  const tag = myStatusTag(entry.mine)
  const time = formatTimeRange(activity.start_time, activity.end_time)

  // A null capacity means the activity is uncapped, not that it holds zero.
  const seats =
    activity.capacity === null
      ? `신청 ${entry.participant_count}명`
      : `신청 ${entry.participant_count}/${activity.capacity}`

  return (
    <Link
      to={`/schedule/${activity.id}`}
      style={{
        ...CARD,
        display: 'block',
        textDecoration: 'none',
        color: '#111317',
        opacity: dimmed ? 0.62 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span
          style={{
            padding: '2px 8px',
            borderRadius: 999,
            background: '#eef0f2',
            color: '#6b7178',
            fontSize: 11,
          }}
        >
          {KIND_LABEL[activity.kind]}
        </span>
        <b style={{ fontSize: 14, lineHeight: 1.4, flex: 1 }}>{activity.title}</b>
        {tag && (
          <span
            style={{
              padding: '2px 8px',
              borderRadius: 999,
              background: tag.background,
              color: tag.color,
              fontSize: 11,
            }}
          >
            {tag.label}
          </span>
        )}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          margin: '8px 0 0',
          fontSize: 11,
          color: '#6b7178',
        }}
      >
        <span>{formatDateLabel(activity.activity_date)}</span>
        {time && <span>{time}</span>}
        {activity.place && <span>{activity.place}</span>}
        <span aria-hidden="true">·</span>
        <span>{seats}</span>
        {entry.waitlist_count > 0 && <span>대기 {entry.waitlist_count}</span>}
      </div>
    </Link>
  )
}
