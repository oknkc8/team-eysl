import { useQuery } from '@tanstack/react-query'
import { AsyncSection } from '../../components/ui/AsyncSection'
import { viewerKey } from '../../lib/queryKeys'
import { useSession } from '../auth/SessionProvider'
import { getMyHistory, STATUS_LABEL, type AttendanceStatus } from './api'

// 출석 / 지각 / 불참 are three different answers and were all printed in the
// same green, which made 불참 read as something that had gone right.
const STATUS_TONE: Record<AttendanceStatus, string> = {
  present: 'ok',
  late: 'wait',
  absent: 'idle',
}

export function MyAttendancePage() {
  const { session } = useSession()
  const query = useQuery({
    queryKey: viewerKey(['my-attendance'], session?.user.id),
    queryFn: getMyHistory,
  })

  return (
    <div className="page">
      <h1 className="title">내 출석</h1>

      {/* The totals are derived from the same rows, so they live inside the
          section rather than showing a confident "0" while the fetch runs. */}
      <AsyncSection
        query={query}
        isEmpty={(rows) => rows.length === 0}
        empty="아직 출석 기록이 없습니다"
        error="출석 기록을 불러오지 못했습니다"
      >
        {(rows) => {
          const present = rows.filter((r) => r.status === 'present' || r.status === 'late').length
          const late = rows.filter((r) => r.status === 'late').length

          return (
            <>
              <div className="stats">
                <Stat label="누적 출석" value={present} />
                <Stat label="누적 지각" value={late} />
              </div>

              <ul className="list attendanceList">
                {rows.map((r) => (
                  <li key={r.activity_id} className="row">
                    <span className="grow">
                      {r.activity_date} {r.title}
                    </span>
                    <span className={`tag ${STATUS_TONE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                  </li>
                ))}
              </ul>
            </>
          )
        }}
      </AsyncSection>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  )
}
