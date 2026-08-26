import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { useCurrentUser } from '../auth/useCurrentUser'
import { creatableKinds } from './permissions'
import { ActivityCard } from './ActivityCard'
import { hasFinished, todayKey } from './order'
import { viewerKey } from '../../lib/queryKeys'
import { useSession } from '../auth/SessionProvider'
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
  const { session } = useSession()
  const [filter, setFilter] = useState<Filter>('all')
  // Since 0015 every approved member may file a 기타, so this button is no longer
  // staff-only — what changes with the role is how many kinds the form offers.
  const kinds = creatableKinds(user)
  // A member gets one kind and the button names it; staff get three and the
  // button stays generic, because the form is where they pick.
  const soleKind = kinds.length === 1 ? kinds[0] : undefined

  const query = useQuery({
    // Carries `mine`, so it is the viewer's answer as much as the club's. The
    // viewer goes last: every invalidation of this uses the bare ['schedule'],
    // which still reaches every viewer's entry.
    queryKey: viewerKey(['schedule', filter], session?.user.id),
    queryFn: () => listSchedule(filter === 'all' ? undefined : filter),
  })

  return (
    <div className="page">
      <div className="titleRow">
        <h1 className="title">일정</h1>
        <Link to="/schedule/calendar" className="btn outline">
          캘린더
        </Link>
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
        const isPast = hasFinished(entry.activity, today)
        const previous = rows[index - 1]
        // sortUpcomingFirst() guarantees every past row follows every upcoming
        // one, so the first past row is where the divider belongs. Both sides ask
        // hasFinished, or an in-progress multi-day race between them would put
        // the divider in the wrong place.
        const opensPast = isPast && (!previous || !hasFinished(previous.activity, today))

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

