import { useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { SaveState } from '../../components/ui/SaveState'
import { useCurrentUser } from '../auth/useCurrentUser'
import { canEditActivity, creatableKinds, MEMBER_KIND } from './permissions'
import {
  createActivity,
  deleteActivity,
  getActivity,
  getReservedSeats,
  KIND_LABEL,
  updateActivity,
  type Activity,
  type ActivityInput,
  type ActivityKind,
} from './api'

const CARD = {
  padding: 14,
  border: '1px solid #e1e5ea',
  borderRadius: 18,
  background: '#fff',
} as const

const FIELD = {
  width: '100%',
  boxSizing: 'border-box',
  padding: 12,
  minHeight: 44,
  borderRadius: 13,
  border: '1px solid #e1e5ea',
  fontSize: 14,
  fontFamily: 'inherit',
} as const

const LABEL = { display: 'block', fontSize: 12, color: '#6b7178', marginBottom: 6 } as const

const NOTE = { fontSize: 12, color: '#6b7178', margin: '6px 0 0' } as const

/**
 * Creating and editing an activity, for staff and members alike.
 *
 * Both routes sit under RequireAuth rather than RequireStaff, because since 0015
 * neither job is staff-only: any approved member may file a 기타, and its creator
 * alone may change it. No route guard can express that — it depends on the kind
 * of the row and on who filed it — so the database expresses it, in four RLS
 * policies, and this screen offers only the parts that would be accepted.
 */
export function ActivityEditPage() {
  const { activityId } = useParams()

  // Fetching first and passing the activity down means the form seeds its state
  // from a prop exactly once, with no effect syncing a late-arriving row.
  if (!activityId) return <CreateActivity />
  return <EditExisting activityId={activityId} />
}

function CreateActivity() {
  const { user } = useCurrentUser()
  const kinds = creatableKinds(user)

  // Empty only for a viewer with no approved member row, whom RequireAuth has
  // already sent to /pending. Handled rather than assumed away, since an empty
  // list would otherwise render a form with no kind to submit.
  if (kinds.length === 0) {
    return (
      <Page title="일정 등록">
        <Refusal>승인된 회원만 일정을 등록할 수 있습니다.</Refusal>
      </Page>
    )
  }

  // 기타 등록 is the president's own wording for the member-facing version of
  // this screen — his openOtherActivityCreate sets exactly that heading.
  const onlyEvent = kinds.length === 1
  return (
    <Page title={onlyEvent ? '기타 등록' : '새 일정'}>
      <ActivityForm kinds={kinds} />
    </Page>
  )
}

function EditExisting({ activityId }: { activityId: string }) {
  const { user } = useCurrentUser()
  const query = useQuery({
    queryKey: ['activity', activityId],
    queryFn: () => getActivity(activityId),
  })

  // Kept as its own query rather than folded into the activity, because it is
  // advisory. 0020's activities_capacity_floor trigger is what actually refuses a
  // capacity below the seats already committed; this only lets the form say so
  // first. A form that could not read the count must stay submittable.
  const reserved = useQuery({
    queryKey: ['activity-reserved', activityId],
    queryFn: () => getReservedSeats(activityId),
  })

  return (
    <Page title="일정 수정">
      <AsyncSection query={query} loading={<Shimmer rows={3} />} error="일정을 불러오지 못했습니다">
        {(activity) =>
          canEditActivity(user, activity) ? (
            <ActivityForm
              activity={activity}
              kinds={creatableKinds(user)}
              reservedSeats={reserved.data ?? null}
            />
          ) : (
            // Not merely a hidden button. Somebody who types this URL gets a
            // sentence rather than a form whose every save the database would
            // discard — and it is the policies in 0015 that discard it, which is
            // what lets this screen be plain instead of defensive.
            <Refusal>
              {activity.kind === 'event'
                ? '이 일정은 등록한 회원과 운영진만 수정할 수 있습니다.'
                : `${KIND_LABEL[activity.kind]} 일정은 운영진만 수정할 수 있습니다.`}
              <div style={{ marginTop: 12 }}>
                <Link
                  to={`/schedule/${activity.id}`}
                  style={{ fontSize: 13, color: '#111317', textDecoration: 'none' }}
                >
                  일정 보기 →
                </Link>
              </div>
            </Refusal>
          )
        }
      </AsyncSection>
    </Page>
  )
}

function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ padding: 18, background: '#f5f6f8', minHeight: '100vh' }}>
      <Link to="/schedule" style={{ fontSize: 12, color: '#6b7178', textDecoration: 'none' }}>
        ← 일정
      </Link>
      <h1 style={{ fontSize: 22, letterSpacing: -0.8, margin: '12px 0 16px' }}>{title}</h1>
      {children}
    </div>
  )
}

function Refusal({ children }: { children: ReactNode }) {
  return (
    <div style={CARD} role="status">
      <div style={{ fontSize: 14, color: '#111317', lineHeight: 1.5 }}>{children}</div>
    </div>
  )
}

// A `time` column comes back as 'HH:MM:SS'; the input wants 'HH:MM' and hands
// back the same, which Postgres accepts unchanged.
const toTimeInput = (value: string | null) => value?.slice(0, 5) ?? ''
const fromTimeInput = (value: string) => (value === '' ? null : value)
const trimToNull = (value: string) => {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function ActivityForm({
  activity,
  kinds,
  reservedSeats = null,
}: {
  activity?: Activity
  kinds: readonly ActivityKind[]
  /** Seats already committed, or null while unknown. Absent when creating. */
  reservedSeats?: number | null
}) {
  const navigate = useNavigate()
  const qc = useQueryClient()

  // MEMBER_KIND is the fallback the type system asks for, not a case that
  // happens: CreateActivity returns before rendering a form with no kinds, and
  // in edit mode the activity supplies its own. It is also the right way to be
  // wrong — the least privileged kind is the one every approved member may file.
  const [kind, setKind] = useState<ActivityKind>(activity?.kind ?? kinds[0] ?? MEMBER_KIND)
  const [title, setTitle] = useState(activity?.title ?? '')
  const [date, setDate] = useState(activity?.activity_date ?? '')
  const [startTime, setStartTime] = useState(toTimeInput(activity?.start_time ?? null))
  const [endTime, setEndTime] = useState(toTimeInput(activity?.end_time ?? null))
  const [place, setPlace] = useState(activity?.place ?? '')
  // Kept as text so an empty box stays "정원 없음" rather than collapsing to 0,
  // which the capacity > 0 CHECK would reject anyway.
  const [capacity, setCapacity] = useState(
    activity?.capacity === null || activity?.capacity === undefined
      ? ''
      : String(activity.capacity),
  )
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  const save = useMutation({
    mutationFn: (input: ActivityInput) =>
      activity ? updateActivity({ activityId: activity.id, ...input }) : createActivity(input),
    onMutate: () => setState('saving'),
    onSuccess: async (saved) => {
      setState('saved')
      // Invalidated before navigating, so the screen we land on reads the
      // server's copy rather than the pre-edit one still sitting in the cache.
      await qc.invalidateQueries({ queryKey: ['schedule'] })
      await qc.invalidateQueries({ queryKey: ['schedule-entry', saved.id] })
      await qc.invalidateQueries({ queryKey: ['activity', saved.id] })
      // Raising capacity hands offers to whoever was queued (0020), so the seats
      // already committed are not what they were before this save.
      await qc.invalidateQueries({ queryKey: ['activity-reserved', saved.id] })
      // The attendance admin keeps its own list of activities.
      await qc.invalidateQueries({ queryKey: ['activities'] })
      void navigate(`/schedule/${saved.id}`, { replace: true })
    },
    onError: () => setState('error'),
  })

  const remove = useMutation({
    mutationFn: () => deleteActivity(activity?.id ?? ''),
    onMutate: () => setState('saving'),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['schedule'] })
      await qc.invalidateQueries({ queryKey: ['activities'] })
      void navigate('/schedule', { replace: true })
    },
    onError: () => setState('error'),
  })

  const trimmedTitle = title.trim()
  const capacityValue = capacity.trim() === '' ? null : Number(capacity)
  const capacityValid =
    capacityValue === null || (Number.isInteger(capacityValue) && capacityValue > 0)
  // Mirrors 0020's activities_capacity_floor. Lowering capacity under the seats
  // already given out would leave offer holders unable to accept inside their own
  // deadline through no fault of theirs, so the database refuses it — this is
  // only the form saying which number is in the way.
  const belowReserved =
    reservedSeats !== null && capacityValue !== null && capacityValue < reservedSeats
  // An end before a start is the one cross-field rule worth catching here; the
  // database has no constraint for it.
  const timesOrdered = startTime === '' || endTime === '' || startTime <= endTime

  const canSubmit =
    trimmedTitle.length > 0 &&
    date !== '' &&
    capacityValid &&
    !belowReserved &&
    timesOrdered &&
    state !== 'saving'

  function submit() {
    if (!canSubmit) return
    save.mutate({
      kind,
      title: trimmedTitle,
      activity_date: date,
      start_time: fromTimeInput(startTime),
      end_time: fromTimeInput(endTime),
      place: trimToNull(place),
      capacity: capacityValue,
    })
  }

  function touched() {
    if (state !== 'saving') setState('idle')
  }

  // One creatable kind means there is no choice to present. A single-button
  // "group" would look like a control and behave like a label.
  const kindIsFixed = kinds.length < 2

  return (
    <>
      <div style={CARD}>
        <span style={LABEL}>종류</span>
        {kindIsFixed ? (
          <>
            <span
              style={{
                display: 'inline-block',
                padding: '6px 14px',
                borderRadius: 999,
                background: '#eef0f2',
                color: '#111317',
                fontSize: 13,
              }}
            >
              {KIND_LABEL[kind]}
            </span>
            <p style={NOTE}>훈련·대회 일정은 운영진이 등록합니다.</p>
          </>
        ) : (
          <div role="group" aria-label="종류" style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
            {kinds.map((option) => {
              const selected = kind === option
              return (
                <button
                  key={option}
                  onClick={() => {
                    setKind(option)
                    touched()
                  }}
                  aria-pressed={selected}
                  style={{
                    minHeight: 44,
                    minWidth: 72,
                    padding: '0 16px',
                    borderRadius: 999,
                    border: selected ? '1px solid #111317' : '1px solid #e1e5ea',
                    background: selected ? '#111317' : '#fff',
                    color: selected ? '#fff' : '#111317',
                    fontSize: 13,
                  }}
                >
                  {KIND_LABEL[option]}
                </button>
              )
            })}
          </div>
        )}

        <label htmlFor="activity-title" style={{ ...LABEL, marginTop: 14 }}>
          제목
        </label>
        <input
          id="activity-title"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value)
            touched()
          }}
          placeholder={kindIsFixed ? '예: 금요일 저녁 모임' : '예: 화요일 정기 훈련'}
          style={FIELD}
        />

        <label htmlFor="activity-date" style={{ ...LABEL, marginTop: 14 }}>
          날짜
        </label>
        <input
          id="activity-date"
          type="date"
          value={date}
          onChange={(e) => {
            setDate(e.target.value)
            touched()
          }}
          style={FIELD}
        />

        <div style={{ display: 'flex', gap: 9, marginTop: 14 }}>
          <div style={{ flex: 1 }}>
            <label htmlFor="activity-start" style={LABEL}>
              시작 시간
            </label>
            <input
              id="activity-start"
              type="time"
              value={startTime}
              onChange={(e) => {
                setStartTime(e.target.value)
                touched()
              }}
              style={FIELD}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label htmlFor="activity-end" style={LABEL}>
              종료 시간
            </label>
            <input
              id="activity-end"
              type="time"
              value={endTime}
              onChange={(e) => {
                setEndTime(e.target.value)
                touched()
              }}
              style={FIELD}
            />
          </div>
        </div>
        {!timesOrdered && (
          <p role="alert" style={{ fontSize: 12, color: '#a33', margin: '8px 0 0' }}>
            종료 시간이 시작 시간보다 빠릅니다.
          </p>
        )}

        <label htmlFor="activity-place" style={{ ...LABEL, marginTop: 14 }}>
          장소
        </label>
        <input
          id="activity-place"
          value={place}
          onChange={(e) => {
            setPlace(e.target.value)
            touched()
          }}
          placeholder="예: 올림픽수영장"
          style={FIELD}
        />

        <label htmlFor="activity-capacity" style={{ ...LABEL, marginTop: 14 }}>
          정원
        </label>
        <input
          id="activity-capacity"
          type="number"
          inputMode="numeric"
          min={1}
          value={capacity}
          onChange={(e) => {
            setCapacity(e.target.value)
            touched()
          }}
          placeholder="비워 두면 정원 없음"
          style={FIELD}
        />
        <p style={NOTE}>
          정원을 비워 두면 신청한 사람이 모두 참가자로 등록됩니다. 이미 대기 중인 회원이 있으면
          모두에게 자리 안내가 갑니다.
        </p>
        {!capacityValid && (
          <p role="alert" style={{ fontSize: 12, color: '#a33', margin: '8px 0 0' }}>
            정원은 1 이상의 정수여야 합니다.
          </p>
        )}
        {capacityValid && belowReserved && (
          <p role="alert" style={{ fontSize: 12, color: '#a33', margin: '8px 0 0' }}>
            이미 {reservedSeats}명이 자리를 확보했습니다. 정원을 그보다 적게 줄일 수 없습니다.
          </p>
        )}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 9,
          marginTop: 14,
        }}
      >
        <SaveState state={state} onRetry={canSubmit ? submit : undefined} />
        <button
          onClick={submit}
          disabled={!canSubmit}
          style={{
            minHeight: 44,
            minWidth: 96,
            padding: '0 18px',
            borderRadius: 13,
            border: 'none',
            background: canSubmit ? '#111317' : '#e1e5ea',
            color: canSubmit ? '#fff' : '#6b7178',
            fontSize: 13,
          }}
        >
          {activity ? '수정' : '등록'}
        </button>
      </div>

      {activity && (
        <button
          onClick={() => {
            // Spelled out because the cascade reaches data nobody expects to
            // lose from a schedule screen.
            if (window.confirm('이 일정을 삭제할까요? 신청 내역과 출석 기록도 함께 사라집니다.')) {
              remove.mutate()
            }
          }}
          disabled={state === 'saving'}
          style={{
            minHeight: 44,
            width: '100%',
            marginTop: 24,
            borderRadius: 13,
            border: '1px solid #a33',
            background: '#fff0f0',
            color: '#a33',
            fontSize: 13,
          }}
        >
          일정 삭제
        </button>
      )}
    </>
  )
}
