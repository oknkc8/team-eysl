import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { useCurrentUser } from '../auth/useCurrentUser'
import { isMasterAdmin, isStaff } from '../auth/schema'
import { MemberAvatar } from './MemberAvatar'
import { filterRoster } from './search'
import { listRoster, ROLE_LABEL, type RosterMember } from './api'

export function MemberListPage() {
  const { user } = useCurrentUser()
  const [query, setQuery] = useState('')

  const rosterQuery = useQuery({ queryKey: ['roster'], queryFn: listRoster })

  return (
    <div className="page">
      <h1 className="title">회원</h1>

      {/* Presentation only. Both screens sit behind their own guard in the route
          tree and their writes behind an RPC that checks the caller, so hiding
          these links is not what keeps anyone out. */}
      {isStaff(user) && (
        <div className="actions">
          <Link to="/members/approval" className="btn outline">
            가입 승인
          </Link>
          {isMasterAdmin(user) && (
            <>
              <Link to="/members/roles" className="btn outline">
                권한 관리
              </Link>
              <Link to="/members/blocked" className="btn outline">
                회원 내보내기
              </Link>
              <Link to="/members/link" className="btn outline">
                회원 연결
              </Link>
            </>
          )}
        </div>
      )}

      <label htmlFor="member-search" className="sr-only">
        회원 검색
      </label>
      <input
        id="member-search"
        className="field memberSearch"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="닉네임이나 역할로 찾기"
        // search rather than text so a phone offers a clear button and the
        // browser does not try to autofill somebody's name into it.
        type="search"
        autoComplete="off"
      />

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
  )
}

function Roster({ members }: { members: RosterMember[] }) {
  return (
    <ul className="list">
      {members.map((member) => (
        <li key={member.id}>
          <Link to={`/members/${member.id}`} className="row">
            <MemberAvatar member={member} />
            <div className="grow">
              <b>{member.nickname}</b>
              {/* team_role is the club's own free-text label (코치, 총무 …).
                  Where nobody has set one, the account role is the honest answer
                  rather than a blank line. */}
              <p>{member.team_role ?? ROLE_LABEL[member.role]}</p>
            </div>
            {member.role !== 'member' && <span className="tag ok">{ROLE_LABEL[member.role]}</span>}
          </Link>
        </li>
      ))}
    </ul>
  )
}
