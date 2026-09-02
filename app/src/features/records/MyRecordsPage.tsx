import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { useCurrentUser } from '../auth/useCurrentUser'
import { useSession } from '../auth/SessionProvider'
import { viewerKey } from '../../lib/queryKeys'
import { isStaff } from '../auth/schema'
import { FilteredRecords, useRecordFilter } from './FilteredRecords'
import { RecordFilters } from './RecordFilters'
import { getMyRecords, type MyRecords } from './api'

export function MyRecordsPage() {
  const { user } = useCurrentUser()

  // One query for every tab: they are readings of the same rows, so changing a
  // filter is a re-render rather than a fetch.
  const { session } = useSession()
  const query = useQuery({
    queryKey: viewerKey(['my-records'], session?.user.id),
    queryFn: getMyRecords,
  })

  return (
    <div className="page">
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 style={{ fontSize: 22, letterSpacing: -0.8, margin: 0 }}>기록</h1>
        {/* Presentation only. /admin/records/new sits under RequireStaff in the
            route tree, so hiding this button is not what keeps others out. */}
        {isStaff(user) && (
          <Link
            to="/admin/records/new"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              minHeight: 44,
              padding: '0 16px',
              borderRadius: 13,
              background: '#111317',
              color: '#fff',
              fontSize: 13,
              textDecoration: 'none',
            }}
          >
            기록 추가
          </Link>
        )}
      </header>

      <div style={{ marginTop: 16 }}>
        <AsyncSection
          query={query}
          loading={<Shimmer rows={4} />}
          error="기록을 불러오지 못했습니다"
        >
          {(data) => <Filtered data={data} />}
        </AsyncSection>
      </div>
    </div>
  )
}

/**
 * The filters and the list, split out so the hook holding the selection sits
 * below `AsyncSection` rather than above it.
 *
 * That placement is deliberate: `useRecordFilter` resolves a default against the
 * rows in hand, and rows arriving later would otherwise leave the screen holding
 * a default chosen when there was nothing to choose from.
 *
 * `history` is every swim newest first, each already carrying its delta and
 * whether it stood as a best — so the same array feeds the PB block, the
 * personal list and the relay list. The other two slices `getMyRecords` returns
 * are the unfiltered views the previous tabs showed; this screen no longer reads
 * them, matching his, where the 개인전 tab *is* the history.
 */
function Filtered({ data }: { data: MyRecords }) {
  const { filter, setPartial } = useRecordFilter(data.history)

  return (
    <>
      <RecordFilters rows={data.history} filter={filter} onChange={setPartial} />
      <div style={{ marginTop: 16 }}>
        <FilteredRecords rows={data.history} filter={filter} onChange={setPartial} />
      </div>
    </>
  )
}
