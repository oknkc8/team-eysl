// What sits under the filter tabs: the 50M personal-best block, the list of
// swims the current selection matches, and — the part that matters — an empty
// state that says which filter emptied it.
//
// Shared by the member's own 기록 screen and a staffer's drill-down, so the two
// cannot drift into disagreeing about what a 접영 200M selection means.

import { useMemo, useState } from 'react'
import type { RecordHistoryRow, SwimRecord } from './api'
import {
  ALL_DISTANCES,
  applyFilter,
  emptyReason,
  personalBestGrid,
  resolveFilter,
  subLabel,
  type Filterable,
  type PartialFilter,
  type RecordFilter,
} from './filter'
import { formatCentiseconds, formatDelta } from './time'

const CARD = {
  padding: 14,
  border: '1px solid #e1e5ea',
  borderRadius: 18,
  background: '#fff',
} as const

const TAG_STYLE = { padding: '2px 8px', borderRadius: 999, fontSize: 11 } as const

// event_date is a bare 'YYYY-MM-DD'; swapping the separators needs no Date at
// all, which is the point — order.ts documents how parsing one shifts the day
// for anyone west of Greenwich. A meet date reads fine without a weekday.
const formatEventDate = (key: string) => key.replaceAll('-', '.')

const eventLabel = (record: SwimRecord) => `${record.stroke} ${record.distance_m}m`

/**
 * The canonical number, formatted — falling back to what the sheet said only if
 * the number is somehow unusable. The reverse order would show a swimmer a
 * string nobody has re-checked since it was parsed.
 */
const displayTime = (record: SwimRecord) =>
  formatCentiseconds(record.result_centiseconds) ?? record.result_display

/**
 * The filter the screen is currently showing, kept as the user's own choices
 * rather than as a resolved value.
 *
 * The distinction is what makes the tabs behave: state holds only what was
 * actually pressed, and `resolveFilter` fills the rest in against the rows in
 * hand. So a 대분류 that clears the stroke beneath it re-defaults to a stroke
 * that has something in it, instead of to a fixed 자유형 that may not.
 */
export function useRecordFilter(rows: readonly Filterable[]) {
  const [partial, setPartial] = useState<PartialFilter>({})
  const filter = useMemo(() => resolveFilter(rows, partial), [rows, partial])
  return { filter, setPartial }
}

type Tag = { label: string; background: string; color: string }

/**
 * The gap to this swimmer's previous swim of the same event.
 *
 * Faster is green and slower is red, and both read off the sign of the number
 * rather than off the formatted string. A first swim has no previous time to
 * compare with, which is a different thing from an unchanged one — it gets its
 * own neutral tag instead of a 0.00.
 */
function deltaTag(delta: number | null): Tag {
  if (delta === null) return { label: '첫 기록', background: '#eef0f2', color: '#6b7178' }

  const text = formatDelta(delta)
  if (text === null) return { label: '기록 확인 필요', background: '#eef0f2', color: '#6b7178' }

  if (delta < 0) return { label: text, background: '#edf7f2', color: '#11805b' }
  if (delta > 0) return { label: text, background: '#fff0f0', color: '#a33' }
  return { label: text, background: '#eef0f2', color: '#6b7178' }
}

/**
 * His MY PB · 50M block (index.html:2849), 일반 개인전 only.
 *
 * Four fixed cells with a dash where there is no swim, because the grid is a
 * shape a reader learns the position of — dropping an empty stroke would move
 * the other three every time a new record landed.
 */
function PersonalBestBlock({ rows }: { rows: readonly RecordHistoryRow[] }) {
  const grid = personalBestGrid(rows)

  return (
    <section style={{ marginBottom: 16 }}>
      <h2 style={{ fontSize: 13, color: '#6b7178', fontWeight: 400, margin: '0 0 9px' }}>
        MY PB · 50M
      </h2>
      <div
        style={{
          display: 'grid',
          gap: 9,
          gridTemplateColumns: 'repeat(auto-fill, minmax(148px, 1fr))',
        }}
      >
        {grid.map((cell) => (
          <div key={cell.stroke} style={CARD}>
            <div style={{ fontSize: 12, color: '#6b7178' }}>{cell.stroke}</div>
            <strong
              style={{
                display: 'block',
                fontSize: 24,
                letterSpacing: -0.8,
                margin: '6px 0 0',
                color: cell.record ? '#111317' : '#c3c9d1',
              }}
            >
              {cell.record ? displayTime(cell.record) : '-'}
            </strong>
            {cell.record && (
              <div style={{ fontSize: 11, color: '#6b7178', marginTop: 6 }}>
                {formatEventDate(cell.record.event_date)}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

/**
 * The empty state the legacy app never had.
 *
 * It printed 해당 조건의 기록이 없습니다 for every empty combination, which a
 * reader takes to mean the member has no records when it almost always means
 * "not at this distance". The sentence here names the filter responsible and the
 * button applies a selection that is guaranteed to hold something — so nobody
 * has to guess which of four tab rows to undo.
 */
function FilteredEmpty({
  rows,
  filter,
  onChange,
}: {
  rows: readonly Filterable[]
  filter: RecordFilter
  onChange: (partial: PartialFilter) => void
}) {
  const reason = emptyReason(rows, filter)
  const { fallback } = reason

  return (
    <div style={{ ...CARD, textAlign: 'center', padding: '32px 18px', color: '#6b7178' }}>
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.7 }}>{reason.message}</p>
      {fallback && (
        <button
          onClick={() => onChange(fallback)}
          style={{
            marginTop: 14,
            minHeight: 44,
            minWidth: 108,
            padding: '0 18px',
            borderRadius: 13,
            border: '1px solid #111317',
            background: '#fff',
            color: '#111317',
            fontSize: 13,
          }}
        >
          {reason.fallbackLabel}
        </button>
      )}
    </div>
  )
}

function RecordRow({ record, showTeammates }: { record: RecordHistoryRow; showTeammates: boolean }) {
  const delta = deltaTag(record.delta_centiseconds)

  return (
    <li style={CARD}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 14, flex: 1 }}>{eventLabel(record)}</b>
        <strong style={{ fontSize: 18, letterSpacing: -0.5 }}>{displayTime(record)}</strong>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          flexWrap: 'wrap',
          margin: '9px 0 0',
        }}
      >
        <span style={{ ...TAG_STYLE, background: delta.background, color: delta.color }}>
          {delta.label}
        </span>
        {record.is_personal_best && (
          <span style={{ ...TAG_STYLE, background: '#fff0d6', color: '#925900' }}>최고 기록</span>
        )}
        <span style={{ fontSize: 11, color: '#6b7178' }}>{formatEventDate(record.event_date)}</span>
        {record.event_name && (
          <span style={{ fontSize: 11, color: '#6b7178' }}>{record.event_name}</span>
        )}
      </div>

      {showTeammates && record.teammates.length > 0 && (
        <div style={{ fontSize: 11, color: '#6b7178', marginTop: 6 }}>
          함께한 선수 · {record.teammates.join(', ')}
        </div>
      )}
    </li>
  )
}

export function FilteredRecords({
  rows,
  filter,
  onChange,
}: {
  /** Every record in scope, newest first and already carrying deltas. */
  rows: readonly RecordHistoryRow[]
  filter: RecordFilter
  onChange: (partial: PartialFilter) => void
}) {
  const matched = applyFilter(rows, filter)
  const showPersonalBests = filter.major === 'meet' && filter.sub === 'personal'
  const distanceText = filter.distance === ALL_DISTANCES ? '' : `${filter.distance}M `

  return (
    <>
      {/* His screen shows the block for 일반 only (index.html:2849); the fin
          branch he wrote at :2831 is never reached. */}
      {showPersonalBests && <PersonalBestBlock rows={rows} />}

      <h2 style={{ fontSize: 13, color: '#6b7178', fontWeight: 400, margin: '0 0 9px' }}>
        {filter.stroke} {distanceText}
        {subLabel(filter.major, filter.sub)} · {matched.length}건
      </h2>

      {matched.length === 0 ? (
        <FilteredEmpty rows={rows} filter={filter} onChange={onChange} />
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 9 }}>
          {matched.map((record) => (
            <RecordRow key={record.id} record={record} showTeammates={filter.sub === 'relay'} />
          ))}
        </ul>
      )}
    </>
  )
}
