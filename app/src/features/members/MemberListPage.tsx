import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { useCurrentUser } from '../auth/useCurrentUser'
import { isMasterAdmin, isStaff } from '../auth/schema'
import { MemberAvatar } from './MemberAvatar'
import { filterRoster } from './search'
import { listRoster, ROLE_LABEL, type RosterMember } from './api'

const CARD = {
  padding: 14,
  border: '1px solid #e1e5ea',
  borderRadius: 18,
  background: '#fff',
} as const

const ADMIN_LINK = {
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: 44,
  padding: '0 16px',
  borderRadius: 13,
  border: '1px solid #e1e5ea',
  background: '#fff',
  color: '#111317',
  fontSize: 13,
  textDecoration: 'none',
} as const

const SR_ONLY = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const

export function MemberListPage() {
  const { user } = useCurrentUser()
  const [query, setQuery] = useState('')

  const rosterQuery = useQuery({ queryKey: ['roster'], queryFn: listRoster })

  return (
    <div style={{ padding: 18, background: '#f5f6f8', minHeight: '100vh' }}>
      <h1 style={{ fontSize: 22, letterSpacing: -0.8, margin: 0 }}>회원</h1>

      {/* Presentation only. Both screens sit behind their own guard in the route
          tree and their writes behind an RPC that checks the caller, so hiding
          these links is not what keeps anyone out. */}
      {isStaff(user) && (
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', margin: '14px 0 0' }}>
          <Link to="/members/approval" style={ADMIN_LINK}>
            가입 승인
          </Link>
          {isMasterAdmin(user) && (
            <>
              <Link to="/members/roles" style={ADMIN_LINK}>
                권한 관리
              </Link>
              <Link to="/members/blocked" style={ADMIN_LINK}>
                회원 내보내기
              </Link>
            </>
          )}
        </div>
      )}

      <label htmlFor="member-search" style={SR_ONLY}>
        회원 검색
      </label>
      <input
        id="member-search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="닉네임이나 역할로 찾기"
        // search rather than text so a phone offers a clear button and the
        // browser does not try to autofill somebody's name into it.
        type="search"
        autoComplete="off"
        style={{
          width: '100%',
          boxSizing: 'border-box',
          marginTop: 14,
          padding: 12,
          minHeight: 44,
          borderRadius: 13,
          border: '1px solid #e1e5ea',
          background: '#fff',
          fontSize: 14,
          fontFamily: 'inherit',
        }}
      />

      <div style={{ marginTop: 14 }}>
        <AsyncSection
          query={rosterQuery}
          // Emptiness is judged after filtering, so a search that matches nobody
          // says so instead of leaving a blank panel under a full roster.
          isEmpty={(rows) => filterRoster(rows, query).length === 0}
          loading={<Shimmer rows={5} />}
          empty={query.trim() === '' ? '등록된 회원이 없습니다' : '찾는 회원이 없습니다'}
          error="회원 목록을 불러오지 못했습니다"
        >
          {(rows) => <Roster members={filterRoster(rows, query)} />}
        </AsyncSection>
      </div>
    </div>
  )
}

function Roster({ members }: { members: RosterMember[] }) {
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 9 }}>
      {members.map((member) => (
        <li key={member.id}>
          <Link
            to={`/members/${member.id}`}
            style={{
              ...CARD,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              minHeight: 44,
              textDecoration: 'none',
              color: '#111317',
            }}
          >
            <MemberAvatar member={member} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <b style={{ display: 'block', fontSize: 14 }}>{member.nickname}</b>
              {/* team_role is the club's own free-text label (코치, 총무 …).
                  Where nobody has set one, the account role is the honest answer
                  rather than a blank line. */}
              <span style={{ fontSize: 11, color: '#6b7178' }}>
                {member.team_role ?? ROLE_LABEL[member.role]}
              </span>
            </span>
            {member.role !== 'member' && (
              <span
                style={{
                  padding: '2px 8px',
                  borderRadius: 999,
                  background: '#edf7f2',
                  color: '#11805b',
                  fontSize: 11,
                }}
              >
                {ROLE_LABEL[member.role]}
              </span>
            )}
          </Link>
        </li>
      ))}
    </ul>
  )
}
