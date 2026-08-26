import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { ActivityCard } from './ActivityCard'
import { coversDate, formatMonthTitle, monthGrid, monthPrefix, stepMonth } from './calendar'
import { hasFinished, todayKey } from './order'
import { seoulYearMonth } from '../../lib/seoulDate'
import {
  ACTIVITY_KINDS,
  KIND_LABEL,
  listActivitiesInMonth,
  type ActivityKind,
  type ScheduleEntry,
} from './api'

type Filter = ActivityKind | 'all'

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: '전체' },
  ...ACTIVITY_KINDS.map((kind) => ({ value: kind, label: KIND_LABEL[kind] })),
]

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'] as const

/**
 * 일정 캘린더 — his `renderCalendar` (upstream:3171), which is the half of
 * final91 that actually worked.
 *
 * The multi-day part is the whole point. A race with an end date occupies every
 * square from its start to its end, so a three-day meet is visible on all three
 * days rather than only on the day it opens. His version does this too; what his
 * version cannot do is create such a race, because there is no end-date input
 * anywhere in his app — see the note on Activity.end_date.
 */
export function ScheduleCalendarPage() {
  const today = todayKey()
  // Seoul, not the device: on 1 September in Seoul a member on the US west
  // coast is still on 31 August, and would open the calendar a month behind
  // what the club considers current.
  const [cursor, setCursor] = useState(seoulYearMonth)
  const [filter, setFilter] = useState<Filter>('all')
  // Today when the month on screen contains it, nothing otherwise. His version
  // clears the day panel on every month change (upstream:3220), so arriving at
  // the screen shows an empty panel under a full calendar.
  const [selected, setSelected] = useState<string | null>(today)

  const query = useQuery({
    queryKey: ['schedule-month', cursor.year, cursor.month, filter],
    queryFn: () =>
      listActivitiesInMonth(cursor.year, cursor.month, filter === 'all' ? undefined : filter),
  })

  function goMonth(delta: number) {
    const next = stepMonth(cursor.year, cursor.month, delta)
    setCursor(next)
    // A selection from the old month would sit under the new one naming a day
    // that is no longer on screen.
    setSelected(monthPrefix(next.year, next.month) === today.slice(0, 7) ? today : null)
  }

  return (
    <div className="page">
      <div className="titleRow">
        <h1 className="title">일정 캘린더</h1>
        <Link to="/schedule" className="btn outline">
          목록으로
        </Link>
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

      <div className="monthSwitch">
        <button type="button" onClick={() => goMonth(-1)} aria-label="이전 달">
          ‹
        </button>
        <b aria-live="polite">{formatMonthTitle(cursor.year, cursor.month)}</b>
        <button type="button" onClick={() => goMonth(1)} aria-label="다음 달">
          ›
        </button>
      </div>

      <AsyncSection query={query} loading={<Shimmer rows={3} />} error="일정을 불러오지 못했습니다">
        {({ entries, truncated }) => (
          <>
            {truncated && (
              <p role="alert" className="card meta">
                이 달의 일정이 너무 많아 일부만 표시했습니다. 목록에서 확인해 주세요.
              </p>
            )}
            <MonthGrid
              year={cursor.year}
              month={cursor.month}
              rows={entries}
              today={today}
              selected={selected}
              onSelect={setSelected}
            />
            <DayPanel rows={entries} day={selected} today={today} />
          </>
        )}
      </AsyncSection>
    </div>
  )
}

function MonthGrid({
  year,
  month,
  rows,
  today,
  selected,
  onSelect,
}: {
  year: number
  month: number
  rows: ScheduleEntry[]
  today: string
  selected: string | null
  onSelect: (key: string) => void
}) {
  const grid = monthGrid(year, month)

  return (
    <div className="calendar">
      <div className="calendarHead" aria-hidden="true">
        {WEEKDAYS.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>

      <div className="calendarDays">
        {grid.map((cell, index) =>
          cell === null ? (
            <span key={`blank-${index}`} />
          ) : (
            <DayCell
              key={cell.key}
              cell={cell}
              rows={rows.filter((entry) => coversDate(entry.activity, cell.key))}
              isToday={cell.key === today}
              isSelected={cell.key === selected}
              onSelect={onSelect}
            />
          ),
        )}
      </div>
    </div>
  )
}

function DayCell({
  cell,
  rows,
  isToday,
  isSelected,
  onSelect,
}: {
  cell: { key: string; day: number }
  rows: ScheduleEntry[]
  isToday: boolean
  isSelected: boolean
  onSelect: (key: string) => void
}) {
  const classes = ['calDay', isToday && 'isToday', isSelected && 'isSelected']
    .filter(Boolean)
    .join(' ')

  return (
    <button
      type="button"
      className={classes}
      aria-pressed={isSelected}
      // The dots carry no text, so without this a screen reader hears a bare
      // number and cannot tell a day with three activities from an empty one.
      aria-label={`${cell.day}일${rows.length ? `, 일정 ${rows.length}건` : ''}`}
      onClick={() => onSelect(cell.key)}
    >
      <span aria-hidden="true">{cell.day}</span>
      {rows.length > 0 && (
        <span className="calDots" aria-hidden="true">
          {/* Three at most: beyond that the dots stop being countable and become
              a smear, and the panel below is where the detail lives. */}
          {rows.slice(0, 3).map((entry) => (
            <i key={entry.activity.id} className={`calDot ${entry.activity.kind}`} />
          ))}
        </span>
      )}
    </button>
  )
}

function DayPanel({
  rows,
  day,
  today,
}: {
  rows: ScheduleEntry[]
  day: string | null
  today: string
}) {
  if (!day) return <p className="card meta">날짜를 선택하면 그 날의 일정이 보입니다.</p>

  const onDay = rows.filter((entry) => coversDate(entry.activity, day))
  if (onDay.length === 0) return <p className="card meta">이 날에는 등록된 일정이 없습니다.</p>

  return (
    <ul className="list" style={{ marginTop: 12 }}>
      {onDay.map((entry) => (
        <li key={entry.activity.id}>
          {/* Dimmed by whether the activity is over, not by which day is
              selected — a three-day race is not "past" on its second day. */}
          <ActivityCard entry={entry} dimmed={hasFinished(entry.activity, today)} />
        </li>
      ))}
    </ul>
  )
}
