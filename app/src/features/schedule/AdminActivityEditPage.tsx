import { useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { SaveState } from '../../components/ui/SaveState'
import {
  ACTIVITY_KINDS,
  createActivity,
  deleteActivity,
  getActivity,
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

// Both routes sit under RequireStaff, so neither this component nor the form
// re-checks the role — the route tree is what decides who gets here.
export function AdminActivityEditPage() {
  const { activityId } = useParams()

  // Fetching first and passing the activity down means the form seeds its state
  // from a prop exactly once, with no effect syncing a late-arriving row.
  if (!activityId) return <ActivityForm />
  return <EditExisting activityId={activityId} />
}

function EditExisting({ activityId }: { activityId: string }) {
  const query = useQuery({
    queryKey: ['activity', activityId],
    queryFn: () => getActivity(activityId),
  })

  return (
    <Page title="일정 수정">
      <AsyncSection query={query} loading={<Shimmer rows={3} />} error="일정을 불러오지 못했습니다">
        {(activity) => <ActivityForm activity={activity} />}
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

// A `time` column comes back as 'HH:MM:SS'; the input wants 'HH:MM' and hands
// back the same, which Postgres accepts unchanged.
const toTimeInput = (value: string | null) => value?.slice(0, 5) ?? ''
const fromTimeInput = (value: string) => (value === '' ? null : value)
const trimToNull = (value: string) => {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function ActivityForm({ activity }: { activity?: Activity }) {
  const navigate = useNavigate()
  const qc = useQueryClient()

  const [kind, setKind] = useState<ActivityKind>(activity?.kind ?? 'training')
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
  // An end before a start is the one cross-field rule worth catching here; the
  // database has no constraint for it.
  const timesOrdered = startTime === '' || endTime === '' || startTime <= endTime

  const canSubmit =
    trimmedTitle.length > 0 && date !== '' && capacityValid && timesOrdered && state !== 'saving'

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

  const form = (
    <>
      <div style={CARD}>
        <span style={LABEL}>종류</span>
        <div role="group" aria-label="종류" style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          {ACTIVITY_KINDS.map((option) => {
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
          placeholder="예: 화요일 정기 훈련"
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
        <p style={{ fontSize: 12, color: '#6b7178', margin: '6px 0 0' }}>
          정원을 비워 두면 신청한 사람이 모두 참가자로 등록되고 대기 명단은 생기지 않습니다.
        </p>
        {!capacityValid && (
          <p role="alert" style={{ fontSize: 12, color: '#a33', margin: '8px 0 0' }}>
            정원은 1 이상의 정수여야 합니다.
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

  // In edit mode the page chrome is already rendered by EditExisting.
  return activity ? form : <Page title="새 일정">{form}</Page>
}
