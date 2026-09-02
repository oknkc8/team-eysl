import { useQuery } from '@tanstack/react-query'
import { AsyncSection } from '../../components/ui/AsyncSection'
import { viewerKey } from '../../lib/queryKeys'
import { useSession } from '../auth/SessionProvider'
import { getMyActivityFees, getMyDuesSummary } from './api'
import {
  balanceLabel,
  formatKrw,
  isSettled,
  periodLabel,
  summariseActivityFees,
  summariseDues,
} from './duesMath'

/**
 * 내 회비 — the member's own two ledgers, side by side and clearly separate.
 *
 * TWO SECTIONS, NOT ONE COMBINED TOTAL. 반기 회비 and 세션 참가비 are collected
 * differently and settled differently, and a member who owes one but not the
 * other needs to see which. A single "you owe 70,000원" would be arithmetically
 * true and would not tell them what to pay or to whom.
 *
 * Each section fetches on its own, so a failure in one cannot blank the other —
 * the same reason MyAchievements is its own query inside 마이페이지.
 *
 * Neither RPC takes a member id: both derive the caller from the session, so
 * there is no URL that reaches somebody else's dues. viewerKey is what keeps two
 * members on a shared phone from reading one cache entry.
 */
export function MyDuesPage() {
  const { session } = useSession()

  const periodsQuery = useQuery({
    queryKey: viewerKey(['my-dues'], session?.user.id),
    queryFn: getMyDuesSummary,
  })

  const sessionsQuery = useQuery({
    queryKey: viewerKey(['my-activity-fees'], session?.user.id),
    queryFn: getMyActivityFees,
  })

  return (
    <div className="page">
      <h1 className="title">내 회비</h1>

      <h2 className="listDivider">반기 회비</h2>
      <AsyncSection
        query={periodsQuery}
        isEmpty={(rows) => rows.length === 0}
        empty="아직 등록된 반기 회비 기간이 없습니다"
        error="반기 회비를 불러오지 못했습니다"
      >
        {(rows) => {
          const totals = summariseDues(rows)
          return (
            <>
              <div className="stats">
                <Stat label="청구 합계" value={formatKrw(totals.due)} />
                <Stat label="납부 합계" value={formatKrw(totals.paid)} />
                {/* The number a member opened this screen for. It is derived
                    here and in SQL and stored in neither place. */}
                <Stat label="잔액" value={balanceLabel(totals.balance)} />
              </div>

              <ul className="list">
                {rows.map((row) => {
                  const balance = row.due_amount - row.paid_amount
                  return (
                    <li key={row.period_id} className="row">
                      <span className="grow">
                        {periodLabel(row.year, row.half)}
                        <span className="meta">
                          {formatKrw(row.paid_amount)} / {formatKrw(row.due_amount)}
                          {row.paid_on ? ` · ${row.paid_on}` : ''}
                        </span>
                      </span>
                      {/* 완납 and 미납 are different answers and were the same
                          grey until this tag split them. `ok` for settled,
                          `wait` for still owing — the tones MyAttendancePage
                          already uses for 출석 and 지각. */}
                      <span className={`tag ${isSettled(balance) ? 'ok' : 'wait'}`}>
                        {balanceLabel(balance)}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </>
          )
        }}
      </AsyncSection>

      <h2 className="listDivider">세션 참가비</h2>
      <AsyncSection
        query={sessionsQuery}
        isEmpty={(rows) => rows.length === 0}
        empty="참가비가 정해진 훈련이 아직 없습니다"
        error="세션 참가비를 불러오지 못했습니다"
      >
        {(rows) => {
          const totals = summariseActivityFees(rows)
          return (
            <>
              <div className="stats">
                <Stat label="참여 횟수" value={`${totals.paidCount}회`} />
                <Stat label="납부 합계" value={formatKrw(totals.collected)} />
                <Stat label="미납" value={formatKrw(totals.outstanding)} />
              </div>

              <ul className="list">
                {rows.map((row) => (
                  <li key={row.activity_id} className="row">
                    <span className="grow">
                      {row.activity_date} {row.title}
                      <span className="meta">
                        {row.place ? `${row.place} · ` : ''}
                        {formatKrw(row.fee_amount)}
                      </span>
                    </span>
                    <span className={`tag ${row.paid ? 'ok' : 'wait'}`}>
                      {/* When the fee was corrected after this member paid, the
                          two numbers differ and the row says so rather than
                          quietly showing the current price as if it were what
                          they handed over. */}
                      {row.paid
                        ? row.paid_amount === row.fee_amount
                          ? '납부'
                          : `납부 ${formatKrw(row.paid_amount)}`
                        : '미납'}
                    </span>
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  )
}
