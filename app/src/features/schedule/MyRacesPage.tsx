import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { AsyncSection } from '../../components/ui/AsyncSection'
import { getMyRaceHistory, isFinished, isWaiting, type RaceHistoryRow } from './api'

// 나의 대회 신청 내역, the president's myStatus screen scoped to races
// (upstream-index.html:2737). His 전체/예정/종료 filter is kept, because a
// member with years of meets behind them opens this to find one of them.
//
// His per-row 상세보기 button is not kept. It opens the schedule detail for a
// live application and falls back to the records screen for a historical row
// (upstream :2741), and that fallback exists precisely because a backfilled meet
// has no activity to open. Our rows carry no activity id either — the RPC
// returns title, date, status and source, matching his contract — so a per-row
// button could only guess. The one link below the list is his fallback, made
// honest: it goes where the times actually are.

type Filter = 'all' | 'upcoming' | 'done'

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: '전체' },
  { value: 'upcoming', label: '예정' },
  { value: 'done', label: '종료' },
]

const CARD = {
  padding: 14,
  border: '1px solid #e1e5ea',
  borderRadius: 18,
  background: '#fff',
} as const

export function MyRacesPage() {
  const [filter, setFilter] = useState<Filter>('all')
  const query = useQuery({ queryKey: ['my-races'], queryFn: getMyRaceHistory })

  return (
    <div className="page">
      <h1 style={{ fontSize: 22, letterSpacing: -0.8, margin: 0, color: '#111317' }}>
        나의 대회 신청 내역
      </h1>

      <div
        role="group"
        aria-label="신청 상태"
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
                borderRadius: 13,
                border: `1px solid ${selected ? '#111317' : '#e1e5ea'}`,
                background: selected ? '#111317' : '#fff',
                color: selected ? '#fff' : '#6b7178',
                fontSize: 13,
              }}
            >
              {option.label}
            </button>
          )
        })}
      </div>

      <div style={{ marginTop: 16 }}>
        {/* The filter is applied inside the section rather than in the query, so
            switching tabs never refetches and an empty tab stays
            distinguishable from an empty history. */}
        <AsyncSection
          query={query}
          isEmpty={(rows) => rows.length === 0}
          empty="아직 대회 신청 내역이 없습니다"
          error="대회 신청 내역을 불러오지 못했습니다"
        >
          {(rows) => {
            const visible = rows.filter((row) => matches(row, filter))
            if (visible.length === 0)
              return (
                <div style={{ ...CARD, fontSize: 13, color: '#6b7178', textAlign: 'center' }}>
                  해당 신청 내역이 없습니다
                </div>
              )

            return (
              <div style={{ display: 'grid', gap: 9 }}>
                {visible.map((row) => (
                  <RaceCard key={`${row.title}|${row.activity_date}`} row={row} />
                ))}
              </div>
            )
          }}
        </AsyncSection>
      </div>

      {/* The screen's one onward action, so it is shaped like one. As 12px text
          it measured 88x14 — a third of a thumb — and it is the only way from a
          member's race history to the times those races produced. */}
      <div className="actions">
        <Link to="/records" className="btn outline block">
          대회 기록 보기
        </Link>
      </div>
    </div>
  )
}

function matches(row: RaceHistoryRow, filter: Filter): boolean {
  if (filter === 'all') return true
  return filter === 'done' ? isFinished(row) : !isFinished(row)
}

function RaceCard({ row }: { row: RaceHistoryRow }) {
  const tone = isFinished(row)
    ? { fg: '#6b7178', bg: '#f5f6f8' }
    : isWaiting(row)
      ? { fg: '#925900', bg: '#fff0d6' }
      : { fg: '#11805b', bg: '#edf7f2' }

  return (
    <div style={{ ...CARD, display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <b style={{ fontSize: 14, color: '#111317' }}>{row.title}</b>
        <p style={{ fontSize: 11, color: '#6b7178', margin: '4px 0 0' }}>{row.activity_date}</p>
      </div>
      <span
        style={{
          flexShrink: 0,
          padding: '5px 10px',
          borderRadius: 999,
          background: tone.bg,
          color: tone.fg,
          fontSize: 11,
        }}
      >
        {row.status}
      </span>
    </div>
  )
}
