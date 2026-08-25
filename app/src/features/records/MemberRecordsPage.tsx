import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { getMemberDetail } from '../members/api'
import { FilteredRecords, useRecordFilter } from './FilteredRecords'
import { RecordFilters } from './RecordFilters'
import { withDeltas } from './derive'
import { getMemberRecords, type MemberRecordsView } from './api'

/**
 * 상세 기록 — one member's swims, filtered the way his rebuilt screen filters
 * them (index.html:4042-4062).
 *
 * Sits on `RequireAuth` rather than on a staff guard, and the reason is in
 * `getMemberRecords`: `records_read` admits the member themselves **or**
 * `can_manage_records()`, which includes any member whose team_role is '코치'.
 * `CurrentUser` carries no team_role, so no position in the route tree and no
 * client-side predicate can express that set — a `RequireStaff` here would turn
 * a coach away from a screen the database would have answered, and would also
 * bar a member from their own records. So the tree grants the screen to any
 * approved member and the database decides what it contains, with the refusal
 * said out loud below rather than rendered as an empty list.
 */
export function MemberRecordsPage() {
  const { memberId = '' } = useParams()

  // Public fields only: this screen shows times, never a 실명. The detail page
  // is where a staff viewer reads the private half.
  const member = useQuery({
    queryKey: ['member', memberId, false],
    queryFn: () => getMemberDetail(memberId, { includePrivate: false }),
    enabled: memberId !== '',
  })

  const query = useQuery({
    queryKey: ['member-records', memberId],
    queryFn: () => getMemberRecords(memberId),
    enabled: memberId !== '',
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
        {nickname ? `${nickname} 기록` : '기록'}
      </h1>

      <AsyncSection query={query} loading={<Shimmer rows={4} />} error="기록을 불러오지 못했습니다">
        {(view) => <Body view={view} />}
      </AsyncSection>
    </div>
  )
}

function Body({ view }: { view: MemberRecordsView }) {
  // Deltas are computed here rather than in api.ts because they belong to the
  // rendering, not to the fetch: the same rows feed a plain list elsewhere.
  // Memoised so the array keeps its identity across a tab press, which is what
  // useRecordFilter's own memo hangs off.
  const rows = useMemo(() => withDeltas(view.records), [view.records])
  const { filter, setPartial } = useRecordFilter(rows)

  // Not an error and not an empty history — a refusal. Saying which of the two
  // it is, is the whole reason `allowed` travels beside the rows.
  if (!view.allowed) {
    return (
      <div
        style={{
          padding: 14,
          border: '1px solid #e1e5ea',
          borderRadius: 18,
          background: '#fff',
          color: '#6b7178',
          fontSize: 13,
          lineHeight: 1.7,
        }}
      >
        다른 회원의 기록은 운영진과 코치만 볼 수 있습니다. 본인 기록은 기록 화면에서 확인할 수
        있습니다.
      </div>
    )
  }

  return (
    <>
      <RecordFilters rows={rows} filter={filter} onChange={setPartial} />
      <div style={{ marginTop: 16 }}>
        <FilteredRecords rows={rows} filter={filter} onChange={setPartial} />
      </div>
    </>
  )
}
