import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { SaveState } from '../../components/ui/SaveState'
import type { Role } from '../auth/schema'
import { MemberAvatar } from './MemberAvatar'
import {
  ASSIGNABLE_TEAM_ROLES,
  grantsRecordUpload,
  RECORD_MANAGER_TEAM_ROLE,
  teamRoleChoice,
  type AssignableTeamRole,
} from './teamRole'
import {
  ASSIGNABLE_ROLES,
  listRoster,
  ROLE_LABEL,
  setMemberRole,
  setMemberTeamRole,
  type RosterMember,
} from './api'

const CARD = {
  padding: 14,
  border: '1px solid #e1e5ea',
  borderRadius: 18,
  background: '#fff',
} as const

// Two different columns are edited on this screen through two different RPCs,
// so a change says which one it is rather than leaving it to be inferred from
// which field happens to be present.
type ChangeInput =
  | { kind: 'role'; role: Role }
  | { kind: 'teamRole'; teamRole: AssignableTeamRole | null }

type Change = ChangeInput & { memberId: string }

function applyChange(change: Change): Promise<void> {
  return change.kind === 'role'
    ? setMemberRole({ memberId: change.memberId, role: change.role })
    : setMemberTeamRole({ memberId: change.memberId, teamRole: change.teamRole })
}

export function MemberRolesPage() {
  const qc = useQueryClient()
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  // Which row is mid-write, so the feedback lands beside the person it concerns
  // rather than once at the top of a forty-row list.
  const [pending, setPending] = useState<Change | null>(null)

  const query = useQuery({ queryKey: ['roster'], queryFn: listRoster })

  const change = useMutation({
    mutationFn: applyChange,
    onMutate: (input: Change) => {
      setPending(input)
      setState('saving')
    },
    onSuccess: async () => {
      setState('saved')
      await qc.invalidateQueries({ queryKey: ['roster'] })
      // The affected member's own session reads their role from ['me'], and the
      // staff-only controls they just gained or lost hang off it. A team role
      // change matters here too: 코치 decides 결과지 업로드.
      await qc.invalidateQueries({ queryKey: ['me'] })
      // Both columns are shown on the block screen's rows as well.
      await qc.invalidateQueries({ queryKey: ['member-access'] })
    },
    onError: () => setState('error'),
  })

  return (
    <div style={{ padding: 18, background: '#f5f6f8', minHeight: '100vh' }}>
      <Link to="/members" style={{ fontSize: 12, color: '#6b7178', textDecoration: 'none' }}>
        ← 회원
      </Link>
      <h1 style={{ fontSize: 22, letterSpacing: -0.8, margin: '12px 0 6px' }}>권한 관리</h1>
      <p style={{ fontSize: 12, color: '#6b7178', margin: '0 0 16px', lineHeight: 1.6 }}>
        부관리자는 일정·공지·출석·기록을 관리할 수 있습니다. 팀 역할을 {RECORD_MANAGER_TEAM_ROLE}로
        지정하면 일반회원도 결과지를 올릴 수 있습니다. 총관리자 권한은 이 화면에서 주거나 거둘 수
        없습니다.
      </p>

      <AsyncSection
        query={query}
        isEmpty={(rows) => rows.length === 0}
        loading={<Shimmer rows={5} />}
        empty="등록된 회원이 없습니다"
        error="회원 목록을 불러오지 못했습니다"
      >
        {(rows) => (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 9 }}>
            {rows.map((member) => (
              <li key={member.id} style={CARD}>
                <RoleRow
                  member={member}
                  busy={state === 'saving'}
                  saveState={pending?.memberId === member.id ? state : 'idle'}
                  onChange={(next) => change.mutate({ ...next, memberId: member.id })}
                  onRetry={pending ? () => change.mutate(pending) : undefined}
                />
              </li>
            ))}
          </ul>
        )}
      </AsyncSection>
    </div>
  )
}

const CHOICE_BUTTON = (selected: boolean) =>
  ({
    flex: 1,
    minHeight: 44,
    borderRadius: 13,
    border: selected ? '1px solid #111317' : '1px solid #e1e5ea',
    background: selected ? '#111317' : '#fff',
    color: selected ? '#fff' : '#111317',
    fontSize: 13,
  }) as const

const SECTION_LABEL = {
  display: 'block',
  fontSize: 11,
  color: '#6b7178',
  margin: '14px 0 7px',
} as const

function RoleRow({
  member,
  busy,
  saveState,
  onChange,
  onRetry,
}: {
  member: RosterMember
  busy: boolean
  saveState: 'idle' | 'saving' | 'saved' | 'error'
  onChange: (change: ChangeInput) => void
  onRetry?: () => void
}) {
  // A master admin is listed but not editable: set_member_role_v1() and
  // set_member_team_role_v1() both refuse that row, so offering the buttons
  // would be offering an error. Showing the row anyway is what tells the reader
  // why it cannot be changed.
  const locked = member.role === 'master_admin'
  const choice = teamRoleChoice(member.team_role)
  const canUpload = grantsRecordUpload({ role: member.role, teamRole: member.team_role })

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <MemberAvatar member={member} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <b style={{ display: 'block', fontSize: 14 }}>{member.nickname}</b>
          <span style={{ fontSize: 11, color: '#6b7178' }}>
            {member.team_role ?? ROLE_LABEL[member.role]}
          </span>
        </span>
        <SaveState state={saveState} onRetry={onRetry} />
      </div>

      {locked ? (
        <p style={{ fontSize: 12, color: '#6b7178', margin: '10px 0 0' }}>
          총관리자 · 이 화면에서 변경할 수 없습니다
        </p>
      ) : (
        <>
          <span style={{ ...SECTION_LABEL, marginTop: 12 }}>등급</span>
          <div
            role="group"
            aria-label={`${member.nickname} 등급`}
            style={{ display: 'flex', gap: 7 }}
          >
            {ASSIGNABLE_ROLES.map((role) => {
              const selected = member.role === role
              return (
                <button
                  key={role}
                  onClick={() => onChange({ kind: 'role', role })}
                  // The role somebody already holds is disabled rather than
                  // re-sendable: it is a write with no meaning, and aria-pressed
                  // already says which one is current.
                  disabled={busy || selected}
                  aria-pressed={selected}
                  style={CHOICE_BUTTON(selected)}
                >
                  {ROLE_LABEL[role]}
                </button>
              )
            })}
          </div>

          <span style={SECTION_LABEL}>팀 역할</span>
          <div
            role="group"
            aria-label={`${member.nickname} 팀 역할`}
            style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}
          >
            {/* A picker rather than a text field, and this is the reason: the
                stored string is compared literally against '코치' by
                can_manage_records(), so '코 치' would save cleanly and take the
                right away with no error to show anybody. */}
            <button
              onClick={() => onChange({ kind: 'teamRole', teamRole: null })}
              disabled={busy || choice.kind === 'none'}
              aria-pressed={choice.kind === 'none'}
              style={CHOICE_BUTTON(choice.kind === 'none')}
            >
              지정 안 함
            </button>
            {ASSIGNABLE_TEAM_ROLES.map((teamRole) => {
              const selected = choice.kind === 'assignable' && choice.value === teamRole
              return (
                <button
                  key={teamRole}
                  onClick={() => onChange({ kind: 'teamRole', teamRole })}
                  disabled={busy || selected}
                  aria-pressed={selected}
                  style={CHOICE_BUTTON(selected)}
                >
                  {teamRole}
                </button>
              )
            })}
          </div>

          {/* A value the club uses but this screen does not assign. Said out
              loud so nobody replaces 총무 believing the field was empty — the
              RPC leaves such a value alone until somebody picks another. */}
          {choice.kind === 'unknown' && (
            <p style={{ fontSize: 11, color: '#925900', margin: '9px 0 0', lineHeight: 1.6 }}>
              현재 팀 역할은 &lsquo;{choice.value}&rsquo;입니다. 이 화면에서 고를 수 없는 값이라
              다른 항목을 선택하면 바뀝니다.
            </p>
          )}

          <p
            style={{
              fontSize: 11,
              margin: '9px 0 0',
              lineHeight: 1.6,
              color: canUpload ? '#11805b' : '#6b7178',
            }}
          >
            {canUpload ? '결과지를 올릴 수 있습니다' : '결과지를 올릴 수 없습니다'}
          </p>
        </>
      )}
    </>
  )
}
