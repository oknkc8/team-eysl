import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import {
  ACTIVITY_KIND_TITLE,
  ACTIVITY_KINDS,
  getMemberActivities,
  getMemberDetail,
  type MemberActivityKind,
  type MemberActivityView,
} from './api'

const CARD = {
  padding: 14,
  border: '1px solid #e1e5ea',
  borderRadius: 18,
  background: '#fff',
} as const

const formatDate = (key: string) => (key === '' ? '날짜 미정' : key.replaceAll('-', '.'))

function toKind(value: string | undefined): MemberActivityKind | null {
  return ACTIVITY_KINDS.find((kind) => kind === value) ?? null
}

/**
 * 활동 현황 — one member's 훈련 / 대회 / 기타, behind the three buttons on the
 * detail screen (index.html:4064-4092).
 *
 * `RequireAuth` for the same reason as the record drill-down: the two sources
 * are gated differently in the database — races come out of `records`
 * (can_manage_records, which includes a 코치) and applications out of
 * `activity_applications` (is_staff) — and a member is entitled to their own
 * rows in both. No single position in the route tree names that set, so the
 * screen asks the server per kind and says what it was told.
 */
export function MemberActivityPage() {
  const { memberId = '', kind: kindParam } = useParams()
  const kind = toKind(kindParam)

  const member = useQuery({
    queryKey: ['member', memberId, false],
    queryFn: () => getMemberDetail(memberId, { includePrivate: false }),
    enabled: memberId !== '',
  })

  const query = useQuery({
    queryKey: ['member-activities', memberId, kind],
    // `enabled` already excludes the null case; the assertion keeps the type
    // honest rather than widening getMemberActivities to accept a null kind.
    queryFn: () => getMemberActivities(memberId, kind as MemberActivityKind),
    enabled: memberId !== '' && kind !== null,
  })

  const nickname = member.data?.member.nickname

  return (
    <div style={{ padding: 18, background: '#f5f6f8', minHeight: '100vh' }}>
      <Link
        to={`/members/${memberId}`}
        style={{ fontSize: 12, color: '#6b7178', textDecoration: 'none' }}
      >
        ← 회원 상세
      </Link>
      <h1 style={{ fontSize: 22, letterSpacing: -0.8, margin: '12px 0 16px' }}>
        {nickname ? `${nickname} · ` : ''}
        {kind ? ACTIVITY_KIND_TITLE[kind] : '활동 현황'}
      </h1>

      {kind === null ? (
        // A url segment that names no kind, rather than a fetch that would fail
        // for a reason nobody could read off the screen.
        <div style={{ ...CARD, color: '#6b7178', fontSize: 13, lineHeight: 1.7 }}>
          알 수 없는 활동 종류입니다. 회원 상세에서 다시 선택해 주세요.
        </div>
      ) : (
        <AsyncSection
          query={query}
          loading={<Shimmer rows={4} />}
          error="활동 현황을 불러오지 못했습니다"
        >
          {(view) => <Body view={view} />}
        </AsyncSection>
      )}
    </div>
  )
}

function Body({ view }: { view: MemberActivityView }) {
  if (!view.allowed) {
    return (
      <div style={{ ...CARD, color: '#6b7178', fontSize: 13, lineHeight: 1.7 }}>
        다른 회원의 활동 현황은 운영진만 볼 수 있습니다.
      </div>
    )
  }

  return (
    <>
      {/* Printed above the rows, not below them: it changes what the rows mean,
          so it has to be read before them rather than as a footnote. */}
      {view.caveat && (
        <p
          style={{
            margin: '0 0 12px',
            padding: '10px 14px',
            borderRadius: 13,
            background: '#fff0d6',
            color: '#925900',
            fontSize: 12,
            lineHeight: 1.6,
          }}
        >
          {view.caveat}
        </p>
      )}

      {view.rows.length === 0 ? (
        <div
          style={{
            ...CARD,
            textAlign: 'center',
            padding: '32px 18px',
            color: '#6b7178',
            fontSize: 13,
          }}
        >
          기록된 활동이 없습니다
        </div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 9 }}>
          {view.rows.map((row) => (
            <li
              key={row.id}
              style={{ ...CARD, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>
                <b style={{ display: 'block', fontSize: 14 }}>{row.title}</b>
                <span style={{ fontSize: 11, color: '#6b7178' }}>{formatDate(row.date)}</span>
              </span>
              <span
                style={{
                  padding: '2px 8px',
                  borderRadius: 999,
                  fontSize: 11,
                  background: '#edf7f2',
                  color: '#11805b',
                }}
              >
                {row.note}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
