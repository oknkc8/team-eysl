import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { AsyncSection } from '../../components/ui/AsyncSection'
import { SaveState } from '../../components/ui/SaveState'
import {
  clearDuesPayment,
  deleteDuesPeriod,
  getDuesPeriodRoster,
  listDuesPeriods,
  saveDuesPeriod,
  setDuesPayment,
  type DuesPeriod,
  type DuesRosterRow,
} from './api'
import {
  formatKrw,
  hasRecordedPayment,
  nextPeriod,
  periodLabel,
  recordLabel,
  summariseDues,
  type Half,
} from './duesMath'

/**
 * 회비 관리 — the 반기 회비 half. Session fees are the sibling screen at
 * /admin/dues/sessions.
 *
 * The guard on this route is presentation, as everywhere else in this app: every
 * RPC behind this screen checks `is_staff()` itself and raises 42501. What the
 * route position buys is that a member does not meet a form whose every button
 * the database would refuse.
 *
 * THE ROSTER REFUSES RATHER THAN EMPTYING. dues_period_roster_v1 raises on a
 * non-staff caller and on an unknown period id, so AsyncSection's error branch is
 * what a refusal looks like here — never a tidy empty list implying nobody owes
 * anything.
 *
 * NO 미수 합계. This screen shows what has been entered and what has not, and
 * does not total up what the club is owed, because it cannot: the deposits are on
 * a bank sheet the importer excludes on purpose. A staffer chasing payments needs
 * the list of names with nothing recorded, which IS here — what they must not be
 * given is a confident 미수 figure that is wrong by however many payments nobody
 * has keyed in yet.
 */
export function DuesAdminPage() {
  const periodsQuery = useQuery({ queryKey: ['dues-periods'], queryFn: listDuesPeriods })
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Select the newest period once it arrives, and only while nothing is chosen —
  // re-selecting on every render would fight a staffer who picked an older half.
  const periods = periodsQuery.data
  useEffect(() => {
    const newest = periods?.[0]
    if (!selectedId && newest) setSelectedId(newest.period_id)
  }, [periods, selectedId])

  return (
    <div className="page">
      <Link to="/" className="backLink">
        ← 홈
      </Link>
      <h1 className="title">반기 회비 관리</h1>

      <AsyncSection query={periodsQuery} error="회비 기간을 불러오지 못했습니다">
        {(rows) => (
          <>
            <PeriodForm periods={rows} />

            {rows.length > 0 && (
              <>
                <h2 className="listDivider">기간 선택</h2>
                <div className="field">
                  <label className="field-label" htmlFor="duesPeriod">
                    반기
                  </label>
                  <select
                    id="duesPeriod"
                    value={selectedId ?? ''}
                    onChange={(e) => setSelectedId(e.target.value || null)}
                  >
                    {rows.map((p) => (
                      <option key={p.period_id} value={p.period_id}>
                        {periodLabel(p.year, p.half)} · {formatKrw(p.amount)}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}

            {selectedId && (
              <PeriodRoster
                period={rows.find((p) => p.period_id === selectedId) ?? null}
                periodId={selectedId}
                onDeleted={() => setSelectedId(null)}
              />
            )}
          </>
        )}
      </AsyncSection>
    </div>
  )
}

/**
 * 새 반기 등록.
 *
 * Pre-filled from `nextPeriod`, which rolls 하반기 over into the next year. The
 * point of pre-filling correctly is that the obvious wrong default — the newest
 * period again — proposes a half that already exists, and the database answers
 * that with `그 반기는 이미 등록되어 있습니다`: a refusal the staffer did nothing
 * to earn and cannot interpret.
 */
function PeriodForm({ periods }: { periods: DuesPeriod[] }) {
  const queryClient = useQueryClient()
  const suggested = useMemo(() => nextPeriod(periods), [periods])

  const [year, setYear] = useState(String(suggested.year))
  const [half, setHalf] = useState<Half>(suggested.half)
  // 50,000 is what both sheets charge. It is a starting value in a field the
  // staffer can overwrite, not a constant anywhere in the schema.
  const [amount, setAmount] = useState('50000')
  const [message, setMessage] = useState<string | null>(null)

  // Follow the suggestion as periods arrive or change, but never while the
  // staffer is mid-edit on a value they typed.
  const [touched, setTouched] = useState(false)
  useEffect(() => {
    if (touched) return
    setYear(String(suggested.year))
    setHalf(suggested.half)
  }, [suggested, touched])

  // The period this form is about, if it already exists.
  //
  // WITHOUT THIS THE AMOUNT COULD NEVER BE CORRECTED. save_dues_period_v1 has an
  // update path, and this form always sent null, so submitting an existing
  // (year, half) hit the duplicate refusal. The only visible recovery was to
  // DELETE the period and recreate it — which cascades every payment recorded
  // against it. Setting 2026 하반기 to 5,000 by mistake, keying in twenty
  // members, then noticing it should be 50,000 meant destroying twenty payment
  // records to fix one number.
  //
  // Matched on (year, half) rather than tracked in state because the form is
  // pre-filled from the data and the staffer may type their way onto an
  // existing half; the question "does this one exist" has to be asked of the
  // values in the fields, not of how they got there.
  const existing = useMemo(
    () => periods.find((p) => p.year === Number(year) && p.half === half) ?? null,
    [periods, year, half],
  )

  const save = useMutation({
    mutationFn: () =>
      saveDuesPeriod({
        periodId: existing?.period_id ?? null,
        year: Number(year),
        half,
        amount: Number(amount),
      }),
    onSuccess: () => {
      setMessage(null)
      setTouched(false)
      void queryClient.invalidateQueries({ queryKey: ['dues-periods'] })
    },
    onError: (error: unknown) => {
      // The database's own sentence where it wrote one — the duplicate-half case
      // is already Korean and already says exactly what happened.
      const text = error instanceof Error ? error.message : String(error)
      setMessage(text || '저장하지 못했습니다')
    },
  })

  const yearNumber = Number(year)
  const amountNumber = Number(amount)
  const valid =
    Number.isInteger(yearNumber) &&
    yearNumber >= 2000 &&
    yearNumber <= 2100 &&
    Number.isInteger(amountNumber) &&
    amountNumber >= 0

  return (
    <section className="card">
      <h2>{existing ? '반기 회비 수정' : '새 반기 등록'}</h2>
      {/* The form pre-fills the next unused half, so landing on an existing one
          means the staffer typed their way there — and a button still saying
          「등록」 would let them overwrite an amount believing they were adding a
          period. Naming it is the whole of the fix; the payments themselves are
          untouched either way, which is the point of using the update path
          rather than delete-and-recreate. */}
      {existing ? (
        <p className="muted">
          {existing.year}년 {existing.half === 1 ? '상반기' : '하반기'}가 이미 있습니다. 저장하면 금액만
          바뀌고 이미 기록된 납부는 그대로 남습니다.
        </p>
      ) : null}

      <div className="formrow">
        <div className="field">
          <label className="field-label" htmlFor="duesYear">
            년도
          </label>
          <input
            id="duesYear"
            type="number"
            inputMode="numeric"
            value={year}
            onChange={(e) => {
              setTouched(true)
              setYear(e.target.value)
            }}
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="duesHalf">
            반기
          </label>
          <select
            id="duesHalf"
            value={half}
            onChange={(e) => {
              setTouched(true)
              setHalf(Number(e.target.value) === 2 ? 2 : 1)
            }}
          >
            <option value={1}>상반기</option>
            <option value={2}>하반기</option>
          </select>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="duesAmount">
            1인당 회비 (원)
          </label>
          <input
            id="duesAmount"
            type="number"
            inputMode="numeric"
            min={0}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
      </div>

      <div className="actions">
        <button className="btn" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? '저장 중…' : existing ? '금액 수정' : '등록'}
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

function PeriodRoster({
  period,
  periodId,
  onDeleted,
}: {
  period: DuesPeriod | null
  periodId: string
  onDeleted: () => void
}) {
  const queryClient = useQueryClient()
  const rosterQuery = useQuery({
    queryKey: ['dues-roster', periodId],
    queryFn: () => getDuesPeriodRoster(periodId),
  })

  const remove = useMutation({
    mutationFn: () => deleteDuesPeriod(periodId),
    onSuccess: () => {
      onDeleted()
      void queryClient.invalidateQueries({ queryKey: ['dues-periods'] })
    },
  })

  return (
    <>
      <h2 className="listDivider">
        {period ? periodLabel(period.year, period.half) : '납부 기록'}
      </h2>

      <AsyncSection
        query={rosterQuery}
        isEmpty={(rows) => rows.length === 0}
        empty="승인된 회원이 없습니다"
        error="납부 기록을 불러오지 못했습니다"
      >
        {(rows) => {
          const totals = summariseDues(rows)
          return (
            <>
              <div className="stats">
                <Stat label="기록 없음" value={`${totals.unrecordedCount}명`} />
                <Stat label="기록 있음" value={`${totals.recordedCount}명`} />
                <Stat label="청구 합계" value={formatKrw(totals.due)} />
              </div>

              <ul className="list">
                {rows.map((row) => (
                  <RosterRow key={row.member_id} periodId={periodId} row={row} />
                ))}
              </ul>
            </>
          )
        }}
      </AsyncSection>

      <div className="actions">
        <button
          className="btn outline"
          disabled={remove.isPending}
          onClick={() => {
            // Deleting a period CASCADES every payment recorded against it.
            // The confirm names that consequence rather than asking a bare
            // "are you sure" — there is no undo for this inside the app.
            const label = period ? periodLabel(period.year, period.half) : '이 기간'
            if (
              window.confirm(
                `${label}을(를) 삭제하면 이 기간에 기록된 납부 내역도 모두 사라집니다. 되돌릴 수 없습니다. 계속할까요?`,
              )
            ) {
              remove.mutate()
            }
          }}
        >
          이 반기 삭제
        </button>
      </div>
    </>
  )
}

/**
 * One member's cell.
 *
 * The amount is a field rather than a checkbox because a 반기 회비 payment is a
 * number the club may receive in part — `set_dues_payment_v1` accepts less than
 * the period's amount, and more. A checkbox would throw that away and force a
 * partial payment to be recorded as either nothing or everything.
 *
 * 기록 삭제 is the delete path and it is not decoration. Without it a figure
 * typed against the wrong member could only be overwritten with 0, which is a
 * different claim — "we received nothing from them" rather than "we never
 * recorded anything". See 0057's header.
 */
function RosterRow({ periodId, row }: { periodId: string; row: DuesRosterRow }) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState(String(row.paid_amount))
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  // Follow the server after a refetch, so a value corrected in another tab does
  // not sit stale in this field.
  useEffect(() => {
    setDraft(String(row.paid_amount))
  }, [row.paid_amount])

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['dues-roster', periodId] })
    // Every member's own 내 회비 screen reads the same rows. viewerKey puts the
    // viewer LAST, so this prefix reaches every cached viewer rather than only
    // whoever is signed in here.
    void queryClient.invalidateQueries({ queryKey: ['my-dues'] })
  }

  const save = useMutation({
    mutationFn: (amount: number) => setDuesPayment({ periodId, memberId: row.member_id, amount }),
    onMutate: () => setState('saving'),
    onSuccess: () => {
      setState('saved')
      invalidate()
    },
    onError: () => setState('error'),
  })

  const clear = useMutation({
    mutationFn: () => clearDuesPayment({ periodId, memberId: row.member_id }),
    onMutate: () => setState('saving'),
    onSuccess: () => {
      setState('saved')
      invalidate()
    },
    onError: () => setState('error'),
  })

  const amount = Number(draft)
  const validAmount = Number.isInteger(amount) && amount >= 0
  const recorded = hasRecordedPayment(row) || row.paid_on !== null

  return (
    <li className="row">
      <span className="grow">
        {row.nickname}
        <span className="meta">
          {recordLabel(row)}
          {row.paid_on ? ` · ${row.paid_on}` : ''}
          {row.note ? ` · ${row.note}` : ''}
        </span>
      </span>

      <input
        type="number"
        inputMode="numeric"
        min={0}
        aria-label={`${row.nickname} 납부액`}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          setState('idle')
        }}
        style={{ width: 104 }}
      />

      <button
        className="btn"
        disabled={!validAmount || save.isPending}
        onClick={() => save.mutate(amount)}
      >
        저장
      </button>

      {/* Only offered where there is something to remove. Calling it on an absent
          row is harmless — the RPC is deliberately idempotent — but a button that
          does nothing is a button that teaches nothing. */}
      {recorded && (
        <button className="btn outline" disabled={clear.isPending} onClick={() => clear.mutate()}>
          기록 삭제
        </button>
      )}

      <SaveState state={state} onRetry={() => validAmount && save.mutate(amount)} />
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
