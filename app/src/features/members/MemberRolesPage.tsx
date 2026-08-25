import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { SaveState } from '../../components/ui/SaveState'
import type { Role } from '../auth/schema'
import { MemberAvatar } from './MemberAvatar'
import { ASSIGNABLE_ROLES, listRoster, ROLE_LABEL, setMemberRole, type RosterMember } from './api'

const CARD = {
  padding: 14,
  border: '1px solid #e1e5ea',
  borderRadius: 18,
  background: '#fff',
} as const

type RoleChange = { memberId: string; role: Role }

export function MemberRolesPage() {
  const qc = useQueryClient()
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  // Which row is mid-write, so the feedback lands beside the person it concerns
  // rather than once at the top of a forty-row list.
  const [pending, setPending] = useState<RoleChange | null>(null)

  const query = useQuery({ queryKey: ['roster'], queryFn: listRoster })

  const change = useMutation({
    mutationFn: (input: RoleChange) => setMemberRole(input),
    onMutate: (input) => {
      setPending(input)
      setState('saving')
    },
    onSuccess: async () => {
      setState('saved')
      await qc.invalidateQueries({ queryKey: ['roster'] })
      // The affected member's own session reads their role from ['me'], and the
      // staff-only controls they just gained or lost hang off it.
      await qc.invalidateQueries({ queryKey: ['me'] })
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
        부관리자는 일정·공지·출석·기록을 관리할 수 있습니다. 총관리자 권한은 이 화면에서 주거나
        거둘 수 없습니다.
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
                  onChange={(role) => change.mutate({ memberId: member.id, role })}
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
  onChange: (role: Role) => void
  onRetry?: () => void
}) {
  // A master admin is listed but not editable: set_member_role_v1() refuses that
  // row, so offering the buttons would be offering an error. Showing the row
  // anyway is what tells the reader why it cannot be changed.
  const locked = member.role === 'master_admin'

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
        <div
          role="group"
          aria-label={`${member.nickname} 권한`}
          style={{ display: 'flex', gap: 7, marginTop: 10 }}
        >
          {ASSIGNABLE_ROLES.map((role) => {
            const selected = member.role === role
            return (
              <button
                key={role}
                onClick={() => onChange(role)}
                // The role somebody already holds is disabled rather than
                // re-sendable: it is a write with no meaning, and aria-pressed
                // already says which one is current.
                disabled={busy || selected}
                aria-pressed={selected}
                style={{
                  flex: 1,
                  minHeight: 44,
                  borderRadius: 13,
                  border: selected ? '1px solid #111317' : '1px solid #e1e5ea',
                  background: selected ? '#111317' : '#fff',
                  color: selected ? '#fff' : '#111317',
                  fontSize: 13,
                }}
              >
                {ROLE_LABEL[role]}
              </button>
            )
          })}
        </div>
      )}
    </>
  )
}
