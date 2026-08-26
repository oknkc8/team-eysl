import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { AsyncSection } from '../../components/ui/AsyncSection'
import { getStrokeRankings } from './api'
import {
  GENDERS,
  GENDER_LABEL,
  STROKES,
  STROKE_RANKING_TITLE,
  TOP_RANK_LIMIT,
  hasHiddenRanks,
  isStrokeRankingsEmpty,
  rankDisplay,
  rankToggleLabel,
  strokeRowsFor,
  type StrokeRankingRow,
  type StrokeRankings,
} from './rankings'

const CARD = {
  padding: 14,
  border: '1px solid #e1e5ea',
  borderRadius: 18,
  background: '#fff',
} as const

/**
 * 영법별 랭킹 — 50M personal bests, split by gender then stroke.
 *
 * Its own screen rather than a fourth `RankingKind`, because the data comes
 * from a different RPC (`stroke_rankings_v1`, 0041) with a different payload.
 * Folding it into EventRankingPage would put two contracts behind one query key
 * and one `isEmpty`.
 *
 * Eight sections, always all eight, even when a group is empty. A club with no
 * women's 접영 times should see that stated rather than see the section vanish
 * — a missing heading reads as a bug, an empty one reads as a fact.
 */
export function StrokeRankingPage() {
  const query = useQuery({ queryKey: ['stroke-rankings'], queryFn: getStrokeRankings })

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
        <h1 style={{ fontSize: 22, letterSpacing: -0.8, margin: 0, color: '#111317' }}>
          {STROKE_RANKING_TITLE}
        </h1>
      </header>

      <AsyncSection
        query={query}
        isEmpty={isStrokeRankingsEmpty}
        empty="아직 집계할 기록이 없습니다"
        error="랭킹을 불러오지 못했습니다"
      >
        {(data) => <Groups data={data} />}
      </AsyncSection>
    </div>
  )
}

function Groups({ data }: { data: StrokeRankings }) {
  return (
    <div style={{ marginTop: 16, display: 'grid', gap: 22 }}>
      {GENDERS.map((gender) => (
        <section key={gender}>
          <h2 style={{ fontSize: 15, margin: '0 0 10px 2px', color: '#111317' }}>
            {GENDER_LABEL[gender] ?? gender}
          </h2>
          <div style={{ display: 'grid', gap: 9 }}>
            {STROKES.map((stroke) => (
              <StrokeCard key={stroke} stroke={stroke} rows={strokeRowsFor(data, gender, stroke)} />
            ))}
          </div>
        </section>
      ))}

      {/* His own words for the rule, kept because they are the specification —
          the RPC that computes it lives in his Supabase project and we cannot
          read it (final92:index.html:5013). */}
      <p style={{ ...CARD, fontSize: 11, color: '#6b7178', lineHeight: 1.7, margin: 0 }}>
        남녀를 따로 계산합니다. 각 성별·영법에서 팀 내 가장 빠른 50M 기록을 100점으로 두고 상대
        점수를 매깁니다. 영법을 합친 종합 점수는 내지 않습니다.
      </p>
    </div>
  )
}

function StrokeCard({ stroke, rows }: { stroke: string; rows: StrokeRankingRow[] }) {
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? rows : rows.slice(0, TOP_RANK_LIMIT)

  return (
    <div style={CARD}>
      <h3 style={{ fontSize: 13, margin: '0 0 10px', color: '#111317' }}>{stroke} 50M</h3>

      {rows.length === 0 ? (
        <p style={{ fontSize: 12, color: '#6b7178', margin: 0 }}>집계할 기록이 없습니다.</p>
      ) : (
        <>
          <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 7 }}>
            {shown.map((row) => (
              <li
                key={`${row.nickname}-${row.rank}`}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  gap: 10,
                  fontSize: 13,
                }}
              >
                <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
                  <span
                    style={{ minWidth: 22, color: '#6b7178', fontVariantNumeric: 'tabular-nums' }}
                  >
                    {rankDisplay(row.rank)}
                  </span>
                  <b style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.nickname}</b>
                </span>
                <span
                  style={{ color: '#6b7178', fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' }}
                >
                  {row.pbSeconds.toFixed(2)}초 · {row.score.toFixed(1)}점
                </span>
              </li>
            ))}
          </ol>

          {hasHiddenRanks(rows.length) && (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              style={{
                marginTop: 10,
                minHeight: 44,
                width: '100%',
                borderRadius: 13,
                border: '1px solid #e1e5ea',
                background: '#fff',
                color: '#111317',
                fontSize: 12,
              }}
            >
              {rankToggleLabel(expanded)}
            </button>
          )}
        </>
      )}
    </div>
  )
}
