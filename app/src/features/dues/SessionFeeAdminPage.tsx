import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { AsyncSection } from '../../components/ui/AsyncSection'
import { listActivities } from '../attendance/api'
import { clearActivityFee, listActivityFees, setActivityFee } from './api'
import { formatKrw } from './duesMath'

/**
 * 세션 참가비 관리 — which trainings charge, and how much.
 *
 * SETTING A FEE TO 0 IS NOT THE SAME AS CLEARING IT, and this screen is where
 * that distinction earns its keep. 0057 keeps the two apart on purpose:
 *
 *   no row       nobody has decided what this session costs
 *   amount = 0   somebody decided it is free
 *
 * 2026-05-31 is the real case — a training the club ran and charged nothing for.
 * With a nullable column on `activities` the two would be one NULL.
 *
 * Which is exactly why 참가비 해제 has to exist and has to be reachable from
 * here. A distinction that can be entered and not left is not a distinction: a
 * staffer who sets 0 on the wrong session would otherwise have recorded "this was
 * free" permanently, with no way back to "undecided". The button says what it
 * destroys, because clearing also cascades away every payment entry for that
 * session.
 */
export function SessionFeeAdminPage() {
  const feesQuery = useQuery({ queryKey: ['activity-fees'], queryFn: listActivityFees })

  return (
    <div className="page">
      <Link to="/" className="backLink">
        ← 홈
      </Link>
      <h1 className="title">세션 참가비 관리</h1>

      <FeeForm />

      <h2 className="listDivider">참가비가 정해진 세션</h2>
      <AsyncSection
        query={feesQuery}
        isEmpty={(rows) => rows.length === 0}
        empty="아직 참가비를 정한 세션이 없습니다"
        error="세션 참가비를 불러오지 못했습니다"
      >
        {(rows) => (
          <ul className="list">
            {rows.map((row) => (
              <li key={row.activity_id} className="row">
                <Link to={`/admin/dues/sessions/${row.activity_id}`} className="grow">
                  {row.activity_date} {row.title}
                  <span className="meta">
                    {row.place ? `${row.place} · ` : ''}
                    {formatKrw(row.fee_amount)} · 납부 기록 {row.paid_count}명
                  </span>
                </Link>
                <ClearFeeButton activityId={row.activity_id} title={row.title} />
              </li>
            ))}
          </ul>
        )}
      </AsyncSection>
    </div>
  )
}

/**
 * Pick an activity and give it a price.
 *
 * The activity list comes from `listActivities()`, which is the same read
 * 출석 관리 uses. It returns every kind, not just 훈련: 0057 deliberately puts no
 * `kind = 'training'` check on `activity_fees`, so a 대회 with an entry fee is
 * expressible, and a selector that hid races would be the screen contradicting
 * the schema.
 */
function FeeForm() {
  const queryClient = useQueryClient()
  const activitiesQuery = useQuery({ queryKey: ['activities'], queryFn: listActivities })

  const [activityId, setActivityId] = useState('')
  const [amount, setAmount] = useState('15000')
  const [message, setMessage] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () => setActivityFee({ activityId, amount: Number(amount) }),
    onSuccess: () => {
      setMessage(null)
      void queryClient.invalidateQueries({ queryKey: ['activity-fees'] })
      void queryClient.invalidateQueries({ queryKey: ['my-activity-fees'] })
    },
    onError: (error: unknown) => {
      setMessage(error instanceof Error ? error.message : '저장하지 못했습니다')
    },
  })

  const amountNumber = Number(amount)
  const valid = activityId !== '' && Number.isInteger(amountNumber) && amountNumber >= 0

  return (
    <section className="card">
      <h2>참가비 설정</h2>

      <AsyncSection query={activitiesQuery} error="일정을 불러오지 못했습니다">
        {(activities) => (
          <div className="formrow">
            <div className="field">
              <label className="field-label" htmlFor="feeActivity">
                일정
              </label>
              <select
                id="feeActivity"
                value={activityId}
                onChange={(e) => setActivityId(e.target.value)}
              >
                <option value="">선택하세요</option>
                {activities.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.activity_date} {a.title}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label className="field-label" htmlFor="feeAmount">
                참가비 (원)
              </label>
              <input
                id="feeAmount"
                type="number"
                inputMode="numeric"
                min={0}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              {/* Said on the screen, not only in the migration: a staffer who
                  means "this one was free" must not reach for 해제. */}
              <p className="fieldNote">
                0원으로 저장하면 무료로 진행한 세션이라는 뜻입니다. 참가비를 아직 정하지 않은
                상태와는 다릅니다.
              </p>
            </div>
          </div>
        )}
      </AsyncSection>

      <div className="actions">
        <button className="btn" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? '저장 중…' : '저장'}
        </button>
        {message && (
          <p role="alert" className="authMsg error">
            {message}
          </p>
        )}
      </div>
    </section>
  )
}

function ClearFeeButton({ activityId, title }: { activityId: string; title: string }) {
  const queryClient = useQueryClient()
  const clear = useMutation({
    mutationFn: () => clearActivityFee(activityId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['activity-fees'] })
      void queryClient.invalidateQueries({ queryKey: ['my-activity-fees'] })
    },
  })

  return (
    <button
      className="btn outline"
      disabled={clear.isPending}
      onClick={() => {
        // Names the cascade. activity_fee_payments' FK points at activity_fees,
        // so this takes the whole set of entries with it — which is why the
        // sentence does not say "are you sure".
        if (
          window.confirm(
            `「${title}」의 참가비 설정을 지우면 이 세션에 기록된 납부 내역도 모두 사라집니다. 무료로 진행한 세션이라면 대신 0원으로 저장하세요. 계속할까요?`,
          )
        ) {
          clear.mutate()
        }
      }}
    >
      참가비 해제
    </button>
  )
}
