import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { useCurrentUser } from '../auth/useCurrentUser'
import { isStaff } from '../auth/schema'
import { formatCentiseconds, formatDelta } from './time'
import {
  CATEGORY_LABEL,
  getMyRecords,
  type MyRecords,
  type RecordHistoryRow,
  type SwimRecord,
} from './api'

const CARD = {
  padding: 14,
  border: '1px solid #e1e5ea',
  borderRadius: 18,
  background: '#fff',
} as const

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

type Tab = 'personal' | 'relay' | 'history'

const TABS: { value: Tab; label: string }[] = [
  { value: 'personal', label: '개인전' },
  { value: 'relay', label: '단체전' },
  { value: 'history', label: '히스토리' },
]

const EMPTY_MESSAGE: Record<Tab, string> = {
  personal: '아직 개인전 기록이 없습니다',
  relay: '아직 단체전 기록이 없습니다',
  history: '아직 기록이 없습니다',
}

export function MyRecordsPage() {
  const { user } = useCurrentUser()
  const [tab, setTab] = useState<Tab>('personal')

  // One query for all three tabs: they are three readings of the same rows, so
  // switching tabs is a re-render rather than a fetch.
  const query = useQuery({ queryKey: ['my-records'], queryFn: getMyRecords })

  return (
    <div style={{ padding: 18, background: '#f5f6f8', minHeight: '100vh' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 style={{ fontSize: 22, letterSpacing: -0.8, margin: 0 }}>기록</h1>
        {/* Presentation only. /admin/records/new sits under RequireStaff in the
            route tree, so hiding this button is not what keeps others out. */}
        {isStaff(user) && (
          <Link
            to="/admin/records/new"
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
            기록 추가
          </Link>
        )}
      </header>

      <div
        role="group"
        aria-label="기록 종류"
        style={{ display: 'flex', gap: 7, flexWrap: 'wrap', margin: '14px 0 0' }}
      >
        {TABS.map((option) => {
          const selected = tab === option.value
          return (
            <button
              key={option.value}
              onClick={() => setTab(option.value)}
              aria-pressed={selected}
              style={{
                minHeight: 44,
                minWidth: 72,
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
          isEmpty={(data) => sliceFor(data, tab).length === 0}
          loading={<Shimmer rows={4} />}
          empty={EMPTY_MESSAGE[tab]}
          error="기록을 불러오지 못했습니다"
        >
          {(data) => {
            if (tab === 'personal') return <PersonalBests records={data.personalBests} />
            if (tab === 'relay') return <RelayList records={data.relays} />
            return <History rows={data.history} />
          }}
        </AsyncSection>
      </div>
    </div>
  )
}

// Which slice is on screen decides whether the section is empty, so a swimmer
// with only relays sees "아직 개인전 기록이 없습니다" on the first tab rather
// than a blank panel.
function sliceFor(data: MyRecords, tab: Tab): unknown[] {
  if (tab === 'personal') return data.personalBests
  if (tab === 'relay') return data.relays
  return data.history
}

function PersonalBests({ records }: { records: SwimRecord[] }) {
  return (
    <div
      style={{
        display: 'grid',
        gap: 9,
        // Reflows from one column on a phone to several on a tablet without a
        // media query, which inline styles cannot express.
        gridTemplateColumns: 'repeat(auto-fill, minmax(148px, 1fr))',
      }}
    >
      {records.map((record) => (
        <div key={record.id} style={CARD}>
          <div style={{ fontSize: 12, color: '#6b7178' }}>{eventLabel(record)}</div>
          <strong style={{ display: 'block', fontSize: 24, letterSpacing: -0.8, margin: '6px 0' }}>
            {displayTime(record)}
          </strong>
          <div style={{ fontSize: 11, color: '#6b7178' }}>
            {formatEventDate(record.event_date)}
            {record.event_name && ` · ${record.event_name}`}
          </div>
        </div>
      ))}
    </div>
  )
}

function RelayList({ records }: { records: SwimRecord[] }) {
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 9 }}>
      {records.map((record) => (
        <li key={record.id} style={CARD}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <b style={{ fontSize: 14, flex: 1 }}>{eventLabel(record)}</b>
            <strong style={{ fontSize: 18, letterSpacing: -0.5 }}>{displayTime(record)}</strong>
          </div>
          <div
            style={{
              display: 'flex',
              gap: 8,
              flexWrap: 'wrap',
              margin: '8px 0 0',
              fontSize: 11,
              color: '#6b7178',
            }}
          >
            <span>{formatEventDate(record.event_date)}</span>
            <span>{CATEGORY_LABEL[record.category]}</span>
            {record.event_name && <span>{record.event_name}</span>}
          </div>
          {record.teammates.length > 0 && (
            <div style={{ fontSize: 11, color: '#6b7178', marginTop: 6 }}>
              함께한 선수 · {record.teammates.join(', ')}
            </div>
          )}
        </li>
      ))}
    </ul>
  )
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

const TAG_STYLE = { padding: '2px 8px', borderRadius: 999, fontSize: 11 } as const

function History({ rows }: { rows: RecordHistoryRow[] }) {
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 9 }}>
      {rows.map((row) => {
        const delta = deltaTag(row.delta_centiseconds)
        return (
          <li key={row.id} style={CARD}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <b style={{ fontSize: 14, flex: 1 }}>{eventLabel(row)}</b>
              <strong style={{ fontSize: 18, letterSpacing: -0.5 }}>{displayTime(row)}</strong>
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
              {row.is_personal_best && (
                <span style={{ ...TAG_STYLE, background: '#fff0d6', color: '#925900' }}>
                  최고 기록
                </span>
              )}
              <span style={{ fontSize: 11, color: '#6b7178' }}>
                {formatEventDate(row.event_date)}
              </span>
              <span style={{ fontSize: 11, color: '#6b7178' }}>{CATEGORY_LABEL[row.category]}</span>
              {row.event_name && (
                <span style={{ fontSize: 11, color: '#6b7178' }}>{row.event_name}</span>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
