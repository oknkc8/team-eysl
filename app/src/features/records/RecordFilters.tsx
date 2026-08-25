// The four tab rows — 대분류 / 개인·단체 / 영법 / 거리 — shared by the member's
// own 기록 screen and a staffer's drill-down into somebody else's, because they
// are the same control over the same question.
//
// Every option list comes from `filter.ts`, which means a distance or a stroke
// the data holds and his fixed lists do not still gets a tab here. Nothing in
// this file decides what is offered; it only draws it.

import type { RecordCategory, RecordSubcategory } from './api'
import {
  ALL_DISTANCES,
  distanceOptions,
  isExtraDistance,
  MAJOR_LABEL,
  MAJORS,
  strokeOptions,
  subLabel,
  SUBS,
  type Filterable,
  type PartialFilter,
  type RecordFilter,
} from './filter'

const TAB = (selected: boolean) =>
  ({
    minHeight: 44,
    minWidth: 60,
    padding: '0 16px',
    borderRadius: 999,
    border: selected ? '1px solid #111317' : '1px solid #e1e5ea',
    background: selected ? '#111317' : '#fff',
    color: selected ? '#fff' : '#111317',
    fontSize: 13,
  }) as const

const ROW = { display: 'flex', gap: 7, flexWrap: 'wrap' } as const

function TabRow<T extends string | number>({
  label,
  options,
  selected,
  render,
  onSelect,
}: {
  label: string
  options: readonly T[]
  selected: T
  render: (option: T) => string
  onSelect: (option: T) => void
}) {
  return (
    <div role="group" aria-label={label} style={ROW}>
      {options.map((option) => (
        <button
          key={option}
          onClick={() => onSelect(option)}
          aria-pressed={option === selected}
          style={TAB(option === selected)}
        >
          {render(option)}
        </button>
      ))}
    </div>
  )
}

export function RecordFilters({
  rows,
  filter,
  onChange,
}: {
  /** Every record in scope — what decides which options exist. */
  rows: readonly Filterable[]
  filter: RecordFilter
  onChange: (partial: PartialFilter) => void
}) {
  const strokes = strokeOptions(rows, filter.major, filter.sub)
  const distances = distanceOptions(rows, filter.major, filter.sub, filter.stroke)

  return (
    <div style={{ display: 'grid', gap: 9 }}>
      {/* Each row sends only the fields at or above its own level, so choosing a
          new 대분류 clears the stroke and distance beneath it rather than
          carrying a selection the new 대분류 cannot express. resolveFilter then
          fills the cleared ones back in. */}
      <TabRow
        label="대분류"
        options={MAJORS}
        selected={filter.major}
        render={(major: RecordCategory) => MAJOR_LABEL[major]}
        onSelect={(major) => onChange({ major })}
      />

      <TabRow
        label="종류"
        options={SUBS}
        selected={filter.sub}
        render={(sub: RecordSubcategory) => subLabel(filter.major, sub)}
        onSelect={(sub) => onChange({ major: filter.major, sub })}
      />

      {/* 기타 단체기록 has exactly one bucket, so a row of one button would be a
          control that cannot be operated. The heading already says it. */}
      {strokes.length > 1 && (
        <TabRow
          label="영법"
          options={strokes}
          selected={filter.stroke}
          render={(stroke) => stroke}
          onSelect={(stroke) => onChange({ major: filter.major, sub: filter.sub, stroke })}
        />
      )}

      {distances.length > 0 && (
        <TabRow
          label="거리"
          options={distances}
          selected={filter.distance}
          render={(distance) => (distance === ALL_DISTANCES ? '전체' : `${distance}M`)}
          onSelect={(distance) =>
            onChange({
              major: filter.major,
              sub: filter.sub,
              stroke: filter.stroke,
              distance,
            })
          }
        />
      )}

      {/* Says why an unfamiliar button is there. His UI offers 50/100/200/400
          only, so a 25m or 1500m swim would have no tab at all — this one exists
          because the member has such a record, and that is worth stating rather
          than leaving as an oddity. */}
      {isExtraDistance(filter.distance, filter.major, filter.sub, filter.stroke) && (
        <p style={{ fontSize: 11, color: '#925900', margin: 0, lineHeight: 1.6 }}>
          {filter.distance}M는 기본 거리 목록에 없지만, 기록에 있어 함께 표시합니다.
        </p>
      )}
    </div>
  )
}
