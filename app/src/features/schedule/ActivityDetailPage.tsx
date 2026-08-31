import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AsyncSection, Shimmer } from '../../components/ui/AsyncSection'
import { RaceEntryCard } from './RaceEntryCard'
import { SaveState } from '../../components/ui/SaveState'
import { useCurrentUser } from '../auth/useCurrentUser'
import { canEditActivity } from './permissions'
import { formatCountdown, msUntil } from './countdown'
import { formatDateLabel, formatTimeRange, hasFinished, todayKey } from './order'
import { viewerKey } from '../../lib/queryKeys'
import { useSession } from '../auth/SessionProvider'
import {
  applyToActivity,
  cancelApplication,
  getScheduleEntry,
  KIND_LABEL,
  respondToOffer,
  type MyApplication,
  type ScheduleEntry,
} from './api'

const CARD = {
  padding: 14,
  border: '1px solid #e1e5ea',
  borderRadius: 18,
  background: '#fff',
} as const

const META = { fontSize: 12, color: '#6b7178', margin: '4px 0 0' } as const

const PRIMARY_BUTTON = {
  minHeight: 44,
  width: '100%',
  borderRadius: 13,
  border: 'none',
  background: '#111317',
  color: '#fff',
  fontSize: 14,
} as const

const QUIET_BUTTON = {
  minHeight: 44,
  width: '100%',
  borderRadius: 13,
  border: '1px solid #e1e5ea',
  background: '#fff',
  color: '#111317',
  fontSize: 13,
} as const

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

export function ActivityDetailPage() {
  const { session } = useSession()
  const { activityId = '' } = useParams()

  const query = useQuery({
    // The viewer goes LAST, after the activity id. This entry carries `mine`,
    // so it must be per-viewer — and it must still be droppable for everyone
    // when the activity changes. Those look like conflicting requirements and
    // are not: react-query matches by prefix, so the five
    // invalidateQueries({queryKey: ['schedule-entry', activityId]}) calls below
    // reach every viewer's copy. Putting the viewer before the activity id
    // would compile and silently narrow all five to one person.
    queryKey: viewerKey(['schedule-entry', activityId], session?.user.id),
    queryFn: () => getScheduleEntry(activityId),
    enabled: !!activityId,
  })

  return (
    <div className="page">
      <Link to="/schedule" className="backLink">
        ← 일정
      </Link>

      <div style={{ marginTop: 12 }}>
        <AsyncSection
          query={query}
          loading={<Shimmer rows={3} />}
          error="일정을 불러오지 못했습니다"
        >
          {(entry) => <ActivityBody entry={entry} activityId={activityId} />}
        </AsyncSection>
      </div>
    </div>
  )
}

function ActivityBody({ entry, activityId }: { entry: ScheduleEntry; activityId: string }) {
  const { activity, mine } = entry
  const { user } = useCurrentUser()
  const time = formatTimeRange(activity.start_time, activity.end_time)
  // hasFinished, not the start date: a three-day 대회 keeps its 신청 and 취소
  // controls through day three.
  const isPast = hasFinished(activity, todayKey())
  // Staff for anything, the creator for their own 기타 — the same question
  // activities_member_event_update asks, asked here only to decide what to draw.
  // A past activity keeps the link: fixing a wrong time after the fact is the
  // most likely reason to open it.
  const mayEdit = canEditActivity(user, activity)

  const seats =
    activity.capacity === null
      ? `신청 ${entry.participant_count}명`
      : `신청 ${entry.participant_count}/${activity.capacity}`

  return (
    <>
      {/* The offer sits above the activity itself: it is time-boxed, and the
          details are already familiar to someone who joined the waitlist. An
          offer left over on a past activity is not worth answering, so it is
          hidden with the rest of the actions rather than inviting a tap. */}
      {!isPast && mine?.offer_status === 'offered' && (
        <OfferCard mine={mine} activityId={activityId} />
      )}

      <article style={CARD}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              padding: '2px 8px',
              borderRadius: 999,
              background: '#eef0f2',
              color: '#6b7178',
              fontSize: 11,
            }}
          >
            {KIND_LABEL[activity.kind]}
          </span>
          <span style={{ flex: 1 }} />
          {mayEdit && (
            <Link
              to={`/schedule/${activity.id}/edit`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                minHeight: 44,
                padding: '0 14px',
                margin: -10,
                borderRadius: 13,
                color: '#6b7178',
                fontSize: 13,
                textDecoration: 'none',
              }}
            >
              수정
            </Link>
          )}
        </div>
        <h1 style={{ fontSize: 20, letterSpacing: -0.6, margin: '8px 0 0', lineHeight: 1.4 }}>
          {activity.title}
        </h1>
        <p style={META}>
          {formatDateLabel(activity.activity_date)}
          {time && ` · ${time}`}
        </p>
        {activity.place && <p style={META}>{activity.place}</p>}
        <p style={META}>
          {seats}
          {entry.waitlist_count > 0 && ` · 대기 ${entry.waitlist_count}명`}
        </p>
      </article>

      <div style={{ marginTop: 14 }}>
        {isPast ? (
          <p style={{ ...META, textAlign: 'center' }}>지난 일정입니다</p>
        ) : (
          <ApplicationSection entry={entry} activityId={activityId} />
        )}
      </div>
    </>
  )
}

// One of four bodies, chosen by the viewer's own application row. The counts
// above never take part in this decision — apply_to_activity() made it under a
// row lock, and re-deciding it here from participant_count against capacity is
// the legacy race (index.html:2384) rebuilt in a new file.
function ApplicationSection({ entry, activityId }: { entry: ScheduleEntry; activityId: string }) {
  const { mine } = entry
  // 대회 신청 sits under whichever of the four bodies applies, not instead of
  // one: the seat and the events are separate answers, and a member who is
  // waitlisted still needs to say what they would swim. It is only offered for a
  // 대회 — a 훈련 has no events to enter (0045 refuses one anyway).
  const events = entry.activity.kind === 'race' ? <RaceEntryCard entry={entry} /> : null

  if (!mine)
    return (
      <>
        <NotApplied entry={entry} activityId={activityId} />
        {events}
      </>
    )
  if (mine.application_type === 'participant')
    return (
      <>
        <Seated mine={mine} activityId={activityId} />
        {events}
      </>
    )
  return (
    <>
      <Waitlisted mine={mine} activityId={activityId} />
      {events}
    </>
  )
}

function NotApplied({ entry, activityId }: { entry: ScheduleEntry; activityId: string }) {
  const qc = useQueryClient()
  const [state, setState] = useState<SaveStatus>('idle')
  // What the server decided, not what this screen guessed. Held so the outcome
  // is stated in the RPC's own words even before the refetch repaints.
  const [verdict, setVerdict] = useState<MyApplication | null>(null)

  const apply = useMutation({
    mutationFn: () => applyToActivity(activityId),
    onMutate: () => setState('saving'),
    onSuccess: async (row) => {
      setVerdict(row)
      // Marked saved before the refetch, unlike the cancel below: the RPC
      // already returned the stored row, so the write is confirmed. Waiting
      // would hide the badge entirely, since this card unmounts the moment the
      // refetch lands and the seated or waitlisted card takes its place.
      setState('saved')
      await qc.invalidateQueries({ queryKey: ['schedule-entry', activityId] })
      await qc.invalidateQueries({ queryKey: ['schedule'] })
    },
    onError: () => setState('error'),
  })

  const full =
    entry.activity.capacity !== null && entry.participant_count >= entry.activity.capacity

  return (
    <div style={CARD}>
      {/* An observation about the current count, deliberately not a prediction:
          which of the two a member gets is settled server-side when they tap. */}
      {full && (
        <p style={{ ...META, margin: '0 0 12px' }}>
          지금 신청 인원이 정원과 같습니다. 자리 배정은 신청할 때 서버가 정합니다.
        </p>
      )}

      <button onClick={() => apply.mutate()} disabled={state === 'saving'} style={PRIMARY_BUTTON}>
        신청하기
      </button>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
        <SaveState state={state} onRetry={() => apply.mutate()} />
      </div>

      {verdict && (
        <p style={{ ...META, textAlign: 'center' }}>
          {verdict.application_type === 'participant'
            ? '참가가 확정되었습니다'
            : verdict.wait_order === null
              ? '대기 명단에 등록되었습니다'
              : `대기 ${verdict.wait_order}번째로 등록되었습니다`}
        </p>
      )}
    </div>
  )
}

function Seated({ mine, activityId }: { mine: MyApplication; activityId: string }) {
  return (
    <div style={{ ...CARD, borderColor: '#11805b', background: '#edf7f2' }}>
      <b style={{ fontSize: 14, color: '#11805b' }}>참가확정</b>
      <p style={{ ...META, color: '#11805b' }}>신청이 확정된 일정입니다.</p>
      <div style={{ marginTop: 14 }}>
        <CancelButton applicationId={mine.id} activityId={activityId} />
      </div>
    </div>
  )
}

function Waitlisted({ mine, activityId }: { mine: MyApplication; activityId: string }) {
  // An offer that was declined or allowed to lapse is a dead end: the server only
  // ever offers a row sitting at offer_status 'none', so nothing will reach this
  // member again. Re-applying is the documented way back (0020), and the two
  // sentences below say so — which they may only do because this button exists.
  const spent = mine.offer_status === 'expired' || mine.offer_status === 'declined'

  return (
    <div style={{ ...CARD, borderColor: '#925900', background: '#fff0d6' }}>
      <b style={{ fontSize: 14, color: '#925900' }}>
        {mine.wait_order === null ? '대기 중' : `대기 ${mine.wait_order}번째`}
      </b>
      {/* The legacy screen promised "자동으로 다음 대기자에게 기회가 넘어갑니다"
          while nothing implemented it, so this screen used to say nothing about
          the queue at all. Since 0020 the promise is true: every path that frees
          a reserved seat — a participant cancelling, an offer holder cancelling,
          an offer lapsing, capacity going up — offers it to the next 순번 under
          the activity lock. So the screen may say it now, and only now. */}
      {mine.offer_status === 'none' && (
        <p style={{ ...META, color: '#925900' }}>
          참가자가 취소하거나 앞 순번이 기한을 넘기면 대기 순서대로 자리 안내가 갑니다.
        </p>
      )}
      {/* A spent offer is a dead end: nothing ever offers the same row twice.
          Saying so, and saying what to do about it, beats leaving them to wonder
          why their turn never comes back. */}
      {mine.offer_status === 'expired' && (
        <p style={{ ...META, color: '#925900' }}>
          이전에 받은 자리 안내는 기한이 지났습니다. 다시 신청하면 대기 명단 맨 뒤에 등록됩니다.
        </p>
      )}
      {mine.offer_status === 'declined' && (
        <p style={{ ...META, color: '#925900' }}>
          이전에 받은 자리 안내를 거절했습니다. 다시 신청하면 대기 명단 맨 뒤에 등록됩니다.
        </p>
      )}
      <div style={{ marginTop: 14 }}>
        {spent && <ReapplyButton activityId={activityId} />}
        <CancelButton applicationId={mine.id} activityId={activityId} />
      </div>
    </div>
  )
}

/**
 * Rejoin the queue after a spent offer. Deliberately the same RPC as 신청하기 —
 * apply_to_activity() is what decides where they land, and since 0020 that is the
 * back of the waitlist, or a seat if one is genuinely free. This screen states
 * nothing about the outcome; the refetch does.
 */
function ReapplyButton({ activityId }: { activityId: string }) {
  const qc = useQueryClient()
  const [state, setState] = useState<SaveStatus>('idle')

  const reapply = useMutation({
    mutationFn: () => applyToActivity(activityId),
    onMutate: () => setState('saving'),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['schedule-entry', activityId] })
      await qc.invalidateQueries({ queryKey: ['schedule'] })
      setState('saved')
    },
    onError: () => setState('error'),
  })

  return (
    <>
      <button
        onClick={() => reapply.mutate()}
        disabled={state === 'saving'}
        style={PRIMARY_BUTTON}
      >
        다시 신청
      </button>
      <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '10px 0' }}>
        <SaveState state={state} onRetry={() => reapply.mutate()} />
      </div>
    </>
  )
}

function CancelButton({ applicationId, activityId }: { applicationId: string; activityId: string }) {
  const qc = useQueryClient()
  const [state, setState] = useState<SaveStatus>('idle')

  const cancel = useMutation({
    mutationFn: () => cancelApplication(applicationId),
    onMutate: () => setState('saving'),
    onSuccess: async () => {
      // "저장됨" waits for the refetch here. A delete returns no row, and RLS
      // reports no error when it matches nothing, so the request having been
      // accepted is not evidence that the application is gone.
      await qc.invalidateQueries({ queryKey: ['schedule-entry', activityId] })
      await qc.invalidateQueries({ queryKey: ['schedule'] })
      setState('saved')
    },
    onError: () => setState('error'),
  })

  function confirmCancel() {
    if (window.confirm('신청을 취소할까요?')) cancel.mutate()
  }

  return (
    <>
      <button onClick={confirmCancel} disabled={state === 'saving'} style={QUIET_BUTTON}>
        신청 취소
      </button>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
        <SaveState state={state} onRetry={() => cancel.mutate()} />
      </div>
    </>
  )
}

/** Milliseconds left on an offer, ticking once a second and stopping at zero. */
function useCountdown(expiresAt: string | null): number {
  const [remaining, setRemaining] = useState(() => msUntil(expiresAt))

  useEffect(() => {
    setRemaining(msUntil(expiresAt))
    if (!expiresAt) return

    const id = window.setInterval(() => {
      const next = msUntil(expiresAt)
      setRemaining(next)
      if (next <= 0) window.clearInterval(id)
    }, 1_000)
    return () => window.clearInterval(id)
  }, [expiresAt])

  return remaining
}

function OfferCard({ mine, activityId }: { mine: MyApplication; activityId: string }) {
  const qc = useQueryClient()
  const [state, setState] = useState<SaveStatus>('idle')
  const [lastChoice, setLastChoice] = useState<boolean | null>(null)

  const remaining = useCountdown(mine.offer_expires_at)
  const label = formatCountdown(remaining)
  const expired = label === null

  // The countdown running out changes nothing by itself. expire_stale_offers(),
  // which pg_cron runs every five minutes, is what actually lapses the offer and
  // hands the seat to the next 순번 — so all this screen may do is ask the server
  // again and report what comes back.
  useEffect(() => {
    if (!expired) return
    void qc.invalidateQueries({ queryKey: ['schedule-entry', activityId] })
  }, [expired, qc, activityId])

  const respond = useMutation({
    mutationFn: (accept: boolean) => respondToOffer({ activityId, accept }),
    onMutate: (accept) => {
      setLastChoice(accept)
      setState('saving')
    },
    onSuccess: async () => {
      // No local claim about what the answer produced: the RPC re-checks the
      // deadline and the seat count under a lock, so an offer that lapsed a
      // moment ago comes back expired and the refetch is what shows it.
      await qc.invalidateQueries({ queryKey: ['schedule-entry', activityId] })
      await qc.invalidateQueries({ queryKey: ['schedule'] })
      setState('saved')
    },
    onError: () => setState('error'),
  })

  const disabled = expired || state === 'saving'

  return (
    <section style={{ ...CARD, borderColor: '#925900', background: '#fff0d6', marginBottom: 14 }}>
      <b style={{ fontSize: 16, color: '#925900' }}>지금 자리가 났어요</b>

      <p
        aria-live="polite"
        style={{
          fontSize: 13,
          color: '#925900',
          margin: '6px 0 0',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {expired ? '만료됨 · 확인 중…' : label}
      </p>

      {!expired && (
        <p style={{ ...META, color: '#925900' }}>
          기한이 지나면 이 자리는 다음 순번에게 넘어갑니다.
        </p>
      )}

      <div style={{ display: 'flex', gap: 9, marginTop: 14 }}>
        <button
          onClick={() => respond.mutate(true)}
          disabled={disabled}
          style={{
            ...PRIMARY_BUTTON,
            background: disabled ? '#e1e5ea' : '#925900',
            color: disabled ? '#6b7178' : '#fff',
          }}
        >
          수락
        </button>
        <button
          onClick={() => respond.mutate(false)}
          disabled={disabled}
          style={{
            ...QUIET_BUTTON,
            borderColor: disabled ? '#e1e5ea' : '#925900',
            color: disabled ? '#6b7178' : '#925900',
          }}
        >
          거절
        </button>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
        <SaveState
          state={state}
          onRetry={lastChoice === null || expired ? undefined : () => respond.mutate(lastChoice)}
        />
      </div>
    </section>
  )
}
