import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { SaveState } from '../../components/ui/SaveState'
import { useCurrentUser } from '../auth/useCurrentUser'
import { isMasterAdmin, isStaff, type Role } from '../auth/schema'
import { getMemberRecords } from '../records/api'
import { personalBestGrid, PB_DISTANCE } from '../records/filter'
import { formatCentiseconds } from '../records/time'
import { MemberAvatar } from './MemberAvatar'
import {
  ACTIVITY_KIND_TITLE,
  ACTIVITY_KINDS,
  getMemberDetail,
  ROLE_LABEL,
  setMemberRole,
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

const SECTION_HEADING = {
  fontSize: 13,
  color: '#6b7178',
  fontWeight: 400,
  margin: 0,
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
          {(detail) => <Detail memberId={memberId} detail={detail} />}
        </AsyncSection>
      </div>
    </div>
  )
}

function Detail({ memberId, detail }: { memberId: string; detail: MemberDetail }) {
  const { member, privateFields } = detail

  return (
    <>
      <div style={{ ...CARD, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <MemberAvatar member={member} size={64} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ fontSize: 20, letterSpacing: -0.6, margin: 0 }}>{member.nickname}</h1>
          <p style={{ fontSize: 12, color: '#6b7178', margin: '6px 0 0' }}>
            {member.team_role ? `${member.team_role} · ` : ''}
            {ROLE_LABEL[member.role]}
          </p>
        </div>
        {/* Moved inline from a separate 권한 관리 section, the way his rebuilt
            screen does it (index.html:3942). /members/roles stays as its own
            page: it also assigns 팀 역할, which decides 결과지 업로드 and has no
            control here. */}
        <RoleAction memberId={memberId} nickname={member.nickname} role={member.role} />
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

      <RecordSummary memberId={memberId} />
      <ActivitySection memberId={memberId} />
    </>
  )
}

// ------------------------------------------------------------- role control

/**
 * 부관리자 지정 / 권한 해제.
 *
 * Shown only to a master admin, and only for a row `set_member_role_v1` will
 * actually accept: the function refuses anyone who is not a master admin and
 * refuses to touch a master admin's row at all. Rendering the button for a
 * 총관리자 would be offering a press whose only outcome is a 42501, which is the
 * thing this project keeps refusing to build.
 *
 * The button is presentation; the function is the authority. It is safe to show
 * because it is never the reason a change is permitted.
 */
function RoleAction({
  memberId,
  nickname,
  role,
}: {
  memberId: string
  nickname: string
  role: Role
}) {
  const { user } = useCurrentUser()
  const qc = useQueryClient()
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  const change = useMutation({
    mutationFn: (next: Role) => setMemberRole({ memberId, role: next }),
    onMutate: () => setState('saving'),
    onSuccess: async () => {
      setState('saved')
      // Every cached view of this member's role, including the affected member's
      // own session — the staff-only controls they just gained or lost hang off
      // ['me'].
      await qc.invalidateQueries({ queryKey: ['member', memberId] })
      await qc.invalidateQueries({ queryKey: ['roster'] })
      await qc.invalidateQueries({ queryKey: ['me'] })
      await qc.invalidateQueries({ queryKey: ['member-access'] })
    },
    onError: () => setState('error'),
  })

  if (!isMasterAdmin(user) || role === 'master_admin') return null

  const granting = role !== 'admin'
  const next: Role = granting ? 'admin' : 'member'

  return (
    <div style={{ display: 'grid', gap: 7, justifyItems: 'end' }}>
      <button
        onClick={() => change.mutate(next)}
        disabled={state === 'saving'}
        style={{
          minHeight: 44,
          padding: '0 16px',
          borderRadius: 13,
          border: granting ? '1px solid #111317' : '1px solid #925900',
          background: granting ? '#111317' : '#fff0d6',
          color: granting ? '#fff' : '#925900',
          fontSize: 13,
        }}
      >
        {granting ? '부관리자 지정' : '권한 해제'}
      </button>
      <SaveState state={state} onRetry={() => change.mutate(next)} />
      <span style={{ fontSize: 11, color: '#6b7178' }}>
        {granting ? `${nickname} 님에게 운영 권한을 부여합니다` : '운영 권한을 거둡니다'}
      </span>
    </div>
  )
}

// ------------------------------------------------------------ private half

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
      <h2 style={{ ...SECTION_HEADING, margin: '0 0 9px' }}>운영진에게만 보이는 정보</h2>
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

// ---------------------------------------------------------- record summary

/**
 * 수영 기록 — his four-stroke 50M grid (index.html:3933) with a link into the
 * filtered drill-down.
 *
 * Rendered from the same `allowed` flag the drill-down uses, so a viewer the
 * database would refuse reads one sentence saying so rather than a grid of four
 * dashes that looks like a member who has never raced.
 */
function RecordSummary({ memberId }: { memberId: string }) {
  const query = useQuery({
    queryKey: ['member-records', memberId],
    queryFn: () => getMemberRecords(memberId),
    enabled: memberId !== '',
  })

  return (
    <section style={{ marginTop: 18 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 10,
          marginBottom: 9,
        }}
      >
        <h2 style={SECTION_HEADING}>수영 기록 · {PB_DISTANCE}M</h2>
        {query.data?.allowed && (
          <Link
            to={`/members/${memberId}/records`}
            style={{ fontSize: 12, color: '#111317', textDecoration: 'none' }}
          >
            상세 기록 ›
          </Link>
        )}
      </div>

      <AsyncSection
        query={query}
        loading={<Shimmer rows={2} />}
        error="기록을 불러오지 못했습니다"
      >
        {(view) =>
          view.allowed ? (
            <div
              style={{
                display: 'grid',
                gap: 9,
                gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
              }}
            >
              {personalBestGrid(view.records).map((cell) => (
                <div key={cell.stroke} style={CARD}>
                  <div style={{ fontSize: 12, color: '#6b7178' }}>{cell.stroke}</div>
                  <strong
                    style={{
                      display: 'block',
                      fontSize: 22,
                      letterSpacing: -0.7,
                      margin: '6px 0 0',
                      color: cell.record ? '#111317' : '#c3c9d1',
                    }}
                  >
                    {cell.record
                      ? (formatCentiseconds(cell.record.result_centiseconds) ??
                        cell.record.result_display)
                      : '-'}
                  </strong>
                </div>
              ))}
            </div>
          ) : (
            <p style={{ ...CARD, margin: 0, fontSize: 13, color: '#6b7178', lineHeight: 1.7 }}>
              다른 회원의 기록은 운영진과 코치만 볼 수 있습니다.
            </p>
          )
        }
      </AsyncSection>
    </section>
  )
}

// -------------------------------------------------------- activity section

function ActivitySection({ memberId }: { memberId: string }) {
  return (
    <section style={{ marginTop: 18 }}>
      <h2 style={{ ...SECTION_HEADING, margin: '0 0 9px' }}>활동 현황</h2>
      <div style={{ display: 'grid', gap: 9 }}>
        {ACTIVITY_KINDS.map((kind) => (
          <Link
            key={kind}
            to={`/members/${memberId}/activities/${kind}`}
            style={{
              ...CARD,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              minHeight: 44,
              color: '#111317',
              fontSize: 14,
              textDecoration: 'none',
            }}
          >
            <b style={{ fontWeight: 500 }}>{ACTIVITY_KIND_TITLE[kind]}</b>
            <span style={{ color: '#6b7178' }}>›</span>
          </Link>
        ))}
      </div>
    </section>
  )
}
