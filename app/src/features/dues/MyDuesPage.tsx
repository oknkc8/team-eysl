import { useQuery } from '@tanstack/react-query'
import { AsyncSection } from '../../components/ui/AsyncSection'
import { viewerKey } from '../../lib/queryKeys'
import { useSession } from '../auth/SessionProvider'
import { getMyActivityFees, getMyDuesSummary } from './api'
import {
  formatKrw,
  hasRecordedPayment,
  periodLabel,
  recordLabel,
  summariseActivityFees,
  summariseDues,
} from './duesMath'

/**
 * 내 회비 — the member's own two ledgers, side by side and clearly separate.
 *
 * TWO SECTIONS, NOT ONE COMBINED TOTAL. 반기 회비 and 세션 참가비 are collected
 * differently and settled differently, and a member who owes one but not the
 * other needs to see which. A single combined figure would be arithmetically
 * true and would not tell them what to pay or to whom.
 *
 * WHAT THIS SCREEN DELIBERATELY DOES NOT SAY. No 잔액, no 미납, no running total
 * of what the member has paid. The club's receipts live on a bank sheet the
 * importer excludes on purpose (see 0057's header), so this app has the charge
 * side and a staffer's notes and nothing else. It therefore reports what is
 * RECORDED and lets the member compare that against what they know they paid —
 * which is the honest division of labour, because the member is the one who
 * actually holds the missing half.
 *
 * The 안내 line says so out loud. A member seeing 「납부 기록 없음」 beside a
 * transfer they made last week must not conclude the club has lost their money.
 *
 * Each section fetches on its own, so a failure in one cannot blank the other.
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

      {/* Not a disclaimer in small print — it is the frame the rest of the
          screen has to be read in, so it comes first. */}
      <p className="fieldNote">
        운영진이 입력한 기록만 보여 줍니다. 입금 내역과 자동으로 맞춰 보지 않기 때문에, 이미 냈는데
        「납부 기록 없음」으로 보일 수 있습니다. 기록이 다르면 운영진에게 알려 주세요.
      </p>

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
                {/* 소계 — the charge side, which this database knows in full. */}
                <Stat label="청구 합계" value={formatKrw(totals.due)} />
                <Stat label="납부 기록 있음" value={`${totals.recordedCount}건`} />
                <Stat label="납부 기록 없음" value={`${totals.unrecordedCount}건`} />
              </div>

              <ul className="list">
                {rows.map((row) => (
                  <li key={row.period_id} className="row">
                    <span className="grow">
                      {periodLabel(row.year, row.half)}
                      <span className="meta">
                        청구 {formatKrw(row.due_amount)}
                        {hasRecordedPayment(row) ? ` · 기록 ${formatKrw(row.paid_amount)}` : ''}
                        {row.paid_on ? ` · ${row.paid_on}` : ''}
                      </span>
                    </span>
                    {/* `idle`, not `ok`/`wait`. Green would read as "you are
                        settled" and amber as "you owe" — both are verdicts this
                        screen is not entitled to reach. */}
                    <span className={`tag ${hasRecordedPayment(row) ? 'ok' : 'idle'}`}>
                      {recordLabel(row)}
                    </span>
                  </li>
                ))}
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
                <Stat label="기록 없음" value={`${totals.unpaidCount}회`} />
                <Stat label="참가비 합계" value={formatKrw(totals.chargeTotal)} />
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
                    <span className={`tag ${row.paid ? 'ok' : 'idle'}`}>
                      {/* When the fee was corrected after the entry was made the
                          two numbers differ, and the row says so rather than
                          quietly showing today's price as if it were what was
                          handed over. */}
                      {row.paid
                        ? row.paid_amount === row.fee_amount
                          ? '납부 기록 있음'
                          : `납부 기록 ${formatKrw(row.paid_amount)}`
                        : '납부 기록 없음'}
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
