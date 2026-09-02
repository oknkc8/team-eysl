import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router'
import { AsyncSection } from '../../components/ui/AsyncSection'
import { getActivityFeeRoster, setActivityFeePayment, type ActivityFeeRosterRow } from './api'
import { formatKrw, summariseActivityFees } from './duesMath'

/**
 * One session's 참가비 register — the sheet's column, as a screen.
 *
 * A TOGGLE, NOT AN AMOUNT FIELD, and that is faithful to the source: every filled
 * cell in both of the president's sheets holds the session's own number, so the
 * only fact a member's cell carries is whether they settled. The amount is copied
 * from the session by `set_activity_fee_payment_v1` on the server, so this screen
 * cannot name a price and the two can never drift.
 *
 * The 반기 회비 roster next door IS an amount field, for the opposite reason:
 * that one is genuinely partial-payable.
 *
 * If the session has no fee set, `activity_fee_roster_v1` raises 23503 rather
 * than returning an empty roster — "no fee here" and "nobody paid" are different
 * facts, and only the first is fixed by going to 참가비 설정.
 */
export function SessionFeeRosterPage() {
  const { activityId } = useParams<{ activityId: string }>()

  const rosterQuery = useQuery({
    queryKey: ['activity-fee-roster', activityId],
    queryFn: () => getActivityFeeRoster(activityId!),
    enabled: !!activityId,
  })

  return (
    <div className="page">
      <Link to="/admin/dues/sessions" className="backLink">
        ← 세션 참가비 관리
      </Link>
      <h1 className="title">세션 참가비 납부 현황</h1>

      <AsyncSection
        query={rosterQuery}
        isEmpty={(rows) => rows.length === 0}
        empty="승인된 회원이 없습니다"
        error="납부 현황을 불러오지 못했습니다. 이 세션에 참가비가 설정되어 있는지 확인해 주세요."
      >
        {(rows) => {
          const totals = summariseActivityFees(rows)
          const fee = rows[0]?.fee_amount ?? 0
          return (
            <>
              <div className="stats">
                <Stat label="참가비" value={formatKrw(fee)} />
                <Stat label="납부 인원" value={`${totals.paidCount}명`} />
                <Stat label="미납 인원" value={`${totals.unpaidCount}명`} />
                <Stat label="수납 합계" value={formatKrw(totals.collected)} />
              </div>

              <ul className="list">
                {rows.map((row) => (
                  <PaymentRow key={row.member_id} activityId={activityId!} row={row} />
                ))}
              </ul>
            </>
          )
        }}
      </AsyncSection>
    </div>
  )
}

function PaymentRow({ activityId, row }: { activityId: string; row: ActivityFeeRosterRow }) {
  const queryClient = useQueryClient()

  const toggle = useMutation({
    mutationFn: (paid: boolean) =>
      setActivityFeePayment({ activityId, memberId: row.member_id, paid }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['activity-fee-roster', activityId] })
      void queryClient.invalidateQueries({ queryKey: ['activity-fees'] })
      // Reaches every cached viewer's 내 회비, not only whoever is signed in
      // here: viewerKey appends the viewer after this prefix.
      void queryClient.invalidateQueries({ queryKey: ['my-activity-fees'] })
    },
  })

  // The write lands on the tap. The legacy app's admin check-in mutated an
  // in-memory object and lost it on refresh, and the president's own fix left a
  // separate 저장 button that a staffer can walk away without pressing. Ours
  // persists immediately, and SaveState-style feedback comes from the row
  // re-rendering off the refetched server value rather than from local state
  // pretending the write succeeded.
  return (
    <li className="row">
      <span className="grow">
        {row.nickname}
        <span className="meta">
          {row.paid
            ? `${formatKrw(row.paid_amount)} 납부${row.paid_on ? ` · ${row.paid_on}` : ''}`
            : `${formatKrw(row.fee_amount)} 미납`}
        </span>
      </span>

      <label className="tag">
        <input
          type="checkbox"
          checked={row.paid}
          disabled={toggle.isPending}
          aria-label={`${row.nickname} 참가비 납부`}
          onChange={(e) => toggle.mutate(e.target.checked)}
        />{' '}
        납부
      </label>

      <span className={`tag ${row.paid ? 'ok' : 'wait'}`}>{row.paid ? '납부' : '미납'}</span>
    </li>
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
