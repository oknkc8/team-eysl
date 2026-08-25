import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { useCurrentUser } from '../auth/useCurrentUser'
import { isStaff } from '../auth/schema'
import { MemberAvatar } from './MemberAvatar'
import {
  getMemberDetail,
  ROLE_LABEL,
  STATUS_LABEL,
  type MemberDetail,
  type MemberPrivateFields,
} from './api'

const CARD = {
  padding: 14,
  border: '1px solid #e1e5ea',
  borderRadius: 18,
  background: '#fff',
} as const

export function MemberDetailPage() {
  const { memberId = '' } = useParams()
  const { user } = useCurrentUser()

  // Staff membership is part of the cache key, not only of the request:
  // switching accounts within one session must not serve a cached page that
  // still carries somebody's 실명.
  const staff = isStaff(user)
  const query = useQuery({
    queryKey: ['member', memberId, staff],
    queryFn: () => getMemberDetail(memberId, { includePrivate: staff }),
    enabled: memberId !== '',
  })

  return (
    <div style={{ padding: 18, background: '#f5f6f8', minHeight: '100vh' }}>
      <Link to="/members" style={{ fontSize: 12, color: '#6b7178', textDecoration: 'none' }}>
        ← 회원
      </Link>

      <div style={{ marginTop: 12 }}>
        <AsyncSection
          query={query}
          loading={<Shimmer rows={4} />}
          error="회원 정보를 불러오지 못했습니다"
        >
          {(detail) => <Detail detail={detail} />}
        </AsyncSection>
      </div>
    </div>
  )
}

function Detail({ detail }: { detail: MemberDetail }) {
  const { member, privateFields } = detail

  return (
    <>
      <div style={{ ...CARD, display: 'flex', alignItems: 'center', gap: 14 }}>
        <MemberAvatar member={member} size={64} />
        <div style={{ minWidth: 0 }}>
          <h1 style={{ fontSize: 20, letterSpacing: -0.6, margin: 0 }}>{member.nickname}</h1>
          <p style={{ fontSize: 12, color: '#6b7178', margin: '6px 0 0' }}>
            {member.team_role ? `${member.team_role} · ` : ''}
            {ROLE_LABEL[member.role]}
          </p>
        </div>
      </div>

      {privateFields ? (
        <PrivateSection fields={privateFields} />
      ) : (
        // Said out loud rather than left as an unexplained short page: a member
        // looking at a teammate should know the rest exists and is withheld,
        // not wonder whether the screen failed to load it.
        <p style={{ fontSize: 12, color: '#6b7178', margin: '14px 2px 0', lineHeight: 1.6 }}>
          실명·생년월일·메모 등 개인정보는 운영진만 볼 수 있습니다.
        </p>
      )}
    </>
  )
}

// Ordered the way the legacy 회원 상세 screen ordered them, so a staffer reading
// both during the cutover is not hunting for a row that moved. A dash rather
// than an empty cell, so a blank field reads as "nobody filled this in".
function rowsFor(fields: MemberPrivateFields): [string, string][] {
  const birth =
    fields.birth_date_text ?? (fields.birth_year !== null ? `${fields.birth_year}년` : null)

  const rows: [string, string | null][] = [
    ['실명', fields.real_name],
    ['가입일', fields.join_date_text],
    ['생년월일', birth],
    ['성별', fields.gender],
    ['거주지', fields.location],
    ['강습', fields.lesson_level],
    ['수력', fields.swim_experience],
    ['가입 사유', fields.join_reason],
    ['기타', fields.notes],
    ['상태', STATUS_LABEL[fields.status]],
    // Named "이관 전" because that is what they are: a frozen carry-over of the
    // legacy counters (0001), not a count of anything this app recorded.
    ['이관 전 출석', `${fields.historical_attendance_count_legacy}회`],
    ['이관 전 지각', `${fields.historical_late_count_legacy}회`],
  ]

  return rows.map(([label, value]) => [label, value ?? '-'])
}

function PrivateSection({ fields }: { fields: MemberPrivateFields }) {
  return (
    <section style={{ marginTop: 14 }}>
      <h2 style={{ fontSize: 13, color: '#6b7178', fontWeight: 400, margin: '0 0 9px' }}>
        운영진에게만 보이는 정보
      </h2>
      <dl style={{ ...CARD, display: 'grid', gap: 10, margin: 0 }}>
        {rowsFor(fields).map(([label, value]) => (
          <div key={label} style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
            <dt style={{ fontSize: 12, color: '#6b7178', width: 84, flexShrink: 0 }}>{label}</dt>
            <dd style={{ fontSize: 13, margin: 0, flex: 1, minWidth: 0, wordBreak: 'break-word' }}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
