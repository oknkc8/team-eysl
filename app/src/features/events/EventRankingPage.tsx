import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router'
import { AsyncSection } from '../../components/ui/AsyncSection'
import { getTeamEventRankings } from './api'
import {
  KIND_TITLE,
  PERIODS,
  countListsFor,
  formatSeconds,
  groupByStroke,
  isRankingKind,
  isRankingsEmpty,
  type CountRow,
  type ImprovementRow,
  type RankingPeriod,
  type TeamEventRankings,
} from './rankings'

const CARD = {
  padding: 14,
  border: '1px solid #e1e5ea',
  borderRadius: 18,
  background: '#fff',
} as const

// Headings are built from the year the server reported, never from the
// browser's clock. The two would disagree for a member abroad on New Year, and
// the server is the one that decided which rows went into which half.
const PERIOD_LABEL: Record<RankingPeriod, (year: number) => string> = {
  lifetime: () => '누적',
  h1: (year) => `${year} 상반기`,
  h2: (year) => `${year} 하반기`,
}

export function EventRankingPage() {
  const { kind } = useParams()
  const query = useQuery({ queryKey: ['team-event-rankings'], queryFn: getTeamEventRankings })

  // An unknown /events/:kind is a typed URL, not a failed fetch, so it gets its
  // own answer rather than the ranking screen's error state.
  if (!isRankingKind(kind)) {
    return (
      <Page title="이벤트">
        <div style={{ ...CARD, color: '#6b7178', fontSize: 13 }}>없는 이벤트입니다.</div>
      </Page>
    )
  }

  return (
    <Page title={KIND_TITLE[kind]}>
      <AsyncSection
        query={query}
        isEmpty={(data) => isRankingsEmpty(data, kind)}
        empty="아직 집계할 기록이 없습니다"
        error="랭킹을 불러오지 못했습니다"
      >
        {(data) =>
          kind === 'improve' ? <Improvements data={data} /> : <Counts data={data} kind={kind} />
        }
      </AsyncSection>
    </Page>
  )
}

function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="page">
      <header style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Link
          to="/events"
          aria-label="이벤트 목록으로"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: 44,
            minHeight: 44,
            marginLeft: -10,
            color: '#111317',
            textDecoration: 'none',
            fontSize: 18,
          }}
        >
          ←
        </Link>
        <h1 style={{ fontSize: 22, letterSpacing: -0.8, margin: 0, color: '#111317' }}>{title}</h1>
      </header>
      <div style={{ marginTop: 16 }}>{children}</div>
    </div>
  )
}

// 출석왕 · 지각왕: three periods, one list each.
function Counts({ data, kind }: { data: TeamEventRankings; kind: 'attendance' | 'late' }) {
  const lists = countListsFor(data, kind)
  const unit = KIND_TITLE[kind]

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      {PERIODS.map((period) => (
        <section key={period}>
          <Heading>{`${PERIOD_LABEL[period](data.year)} ${unit}`}</Heading>
          <Rows
            rows={lists[period]}
            render={(row) => `${row.count}회`}
            emptyLabel="집계 데이터가 없습니다"
          />
        </section>
      ))}
      {/* Lifetime carries pre-app history that has no date attached, so the two
          halves cannot add up to it. Said out loud, because a member checking
          the arithmetic would otherwise read it as a bug. */}
      <p style={{ fontSize: 11, color: '#6b7178', margin: 0 }}>
        누적에는 앱 도입 전 기록이 함께 반영되어 상반기·하반기 합계와 다를 수 있습니다.
      </p>
    </div>
  )
}

// 단축왕: two comparisons, each split into the four strokes.
function Improvements({ data }: { data: TeamEventRankings }) {
  return (
    <div style={{ display: 'grid', gap: 22 }}>
      <ImprovementGroup
        heading={`${data.year}년 올해 안에서 가장 많이 단축`}
        rows={data.improvements.within_year}
      />
      <ImprovementGroup
        heading={`${data.year - 1}년 PB 대비 ${data.year}년 PB 단축`}
        rows={data.improvements.yoy_pb}
      />
    </div>
  )
}

function ImprovementGroup({ heading, rows }: { heading: string; rows: ImprovementRow[] }) {
  return (
    <section>
      <h2 style={{ fontSize: 15, margin: '0 0 10px', color: '#111317' }}>{heading}</h2>
      <div style={{ display: 'grid', gap: 12 }}>
        {groupByStroke(rows).map(({ stroke, rows: strokeRows }) => (
          <section key={stroke}>
            <Heading>{stroke}</Heading>
            <Rows
              rows={strokeRows}
              render={(row) => `${row.distance}M · ▼ ${formatSeconds(row.seconds)}초`}
              emptyLabel="집계 데이터가 없습니다"
            />
          </section>
        ))}
      </div>
    </section>
  )
}

function Heading({ children }: { children: ReactNode }) {
  return (
    <h3 style={{ fontSize: 13, margin: '0 0 8px', color: '#6b7178', fontWeight: 600 }}>
      {children}
    </h3>
  )
}

/**
 * One ranked list. Generic over the row so 출석왕 and 단축왕 share the rank
 * badge, the nickname and the tie behaviour, and differ only in the value on
 * the right — which is the only thing that actually differs between them.
 */
function Rows<T extends CountRow | ImprovementRow>({
  rows,
  render,
  emptyLabel,
}: {
  rows: T[]
  render: (row: T) => string
  emptyLabel: string
}) {
  if (rows.length === 0)
    return <div style={{ ...CARD, fontSize: 12, color: '#6b7178' }}>{emptyLabel}</div>

  return (
    <ol style={{ ...CARD, listStyle: 'none', margin: 0, padding: 4 }}>
      {rows.map((row, index) => (
        // Rank is not unique — tied members share it — so the nickname goes into
        // the key as well, and the index keeps it stable if a refetch ever
        // returns the same person twice.
        <li
          key={`${row.rank}-${row.nickname}-${index}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            minHeight: 44,
            padding: '0 10px',
            borderTop: index === 0 ? 'none' : '1px solid #e1e5ea',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <span
              aria-label={`${row.rank}위`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                minWidth: 24,
                height: 24,
                borderRadius: 999,
                background: row.rank === 1 ? '#edf7f2' : '#f5f6f8',
                color: row.rank === 1 ? '#11805b' : '#6b7178',
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              {row.rank}
            </span>
            <b
              style={{
                fontSize: 13,
                color: '#111317',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {row.nickname}
            </b>
          </span>
          <span style={{ fontSize: 12, color: '#11805b', flexShrink: 0 }}>{render(row)}</span>
        </li>
      ))}
    </ol>
  )
}
