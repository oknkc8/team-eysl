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
    <div className="page">
      <div className="titleRow">
        <h1 className="title">일정</h1>
        {/* Presentation only, as before: activities_member_event_insert is what
            refuses a member's 훈련, and the label just avoids offering one. */}
        {kinds.length > 0 && (
          <Link to="/schedule/new" className="btn primary">
            {soleKind ? `${KIND_LABEL[soleKind]} 등록` : '새 일정'}
          </Link>
        )}
      </div>

      <div className="filters" role="group" aria-label="일정 종류">
        {FILTERS.map((option) => (
          <button
            key={option.value}
            onClick={() => setFilter(option.value)}
            aria-pressed={filter === option.value}
          >
            {option.label}
          </button>
        ))}
      </div>

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
  )
}

function ScheduleList({ rows }: { rows: ScheduleEntry[] }) {
  // Computed once per render rather than per row, so a list that happens to be
  // on screen at midnight cannot split its own sections inconsistently.
  const today = todayKey()

  return (
    <ul className="list">
      {rows.map((entry, index) => {
        const isPast = entry.activity.activity_date < today
        const previous = rows[index - 1]
        // sortUpcomingFirst() guarantees every past row follows every upcoming
        // one, so the first past row is where the divider belongs.
        const opensPast = isPast && (!previous || previous.activity.activity_date >= today)

        return (
          <li key={entry.activity.id}>
            {opensPast && <h2 className="listDivider">지난 일정</h2>}
            <ActivityCard entry={entry} dimmed={isPast} />
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Reads the viewer's own row, never the counts beside it. Whether they hold a
 * seat was decided by apply_to_activity() under a row lock; recomputing it here
 * from participant_count against capacity is exactly the legacy defect.
 *
 * Returns the tag's modifier class rather than a colour pair, so the palette
 * lives in one place and this function decides only which state is true.
 */
function myStatusTag(mine: ScheduleEntry['mine']): { label: string; tone: string } | null {
  if (!mine) return null

  if (mine.offer_status === 'offered' && msUntil(mine.offer_expires_at) > 0)
    return { label: '자리 났어요', tone: 'offer' }

  if (mine.application_type === 'participant') return { label: '참가확정', tone: 'ok' }

  return {
    label: mine.wait_order === null ? '대기 중' : `대기 ${mine.wait_order}번째`,
    tone: 'wait',
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
      className={`card activityCard${dimmed ? ' isPast' : ''}`}
    >
      <div className="activityHead">
        <span className="tag idle">{KIND_LABEL[activity.kind]}</span>
        <b className="grow">{activity.title}</b>
        {tag && <span className={`tag ${tag.tone}`}>{tag.label}</span>}
      </div>

      <p className="activityMeta">
        <span>{formatDateLabel(activity.activity_date)}</span>
        {time && <span>{time}</span>}
        {activity.place && <span>{activity.place}</span>}
        <span aria-hidden="true">·</span>
        <span>{seats}</span>
        {entry.waitlist_count > 0 && <span>대기 {entry.waitlist_count}</span>}
      </p>
    </Link>
  )
}
