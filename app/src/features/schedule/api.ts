import { supabase } from '../../lib/supabase'
import { shiftDays, sortUpcomingFirst, todayKey } from './order'

export type ActivityKind = 'training' | 'race' | 'event'
export type ApplicationType = 'participant' | 'waitlist'
export type OfferStatus = 'none' | 'offered' | 'accepted' | 'declined' | 'expired'

export const ACTIVITY_KINDS: readonly ActivityKind[] = ['training', 'race', 'event']

// Korean is a render-time concern; the database stores English tokens, the same
// split as attendance's STATUS_LABEL.
export const KIND_LABEL: Record<ActivityKind, string> = {
  training: '훈련',
  race: '대회',
  event: '이벤트',
}

export type Activity = {
  id: string
  kind: ActivityKind
  title: string
  activity_date: string
  start_time: string | null
  end_time: string | null
  place: string | null
  capacity: number | null
}

export type MyApplication = {
  id: string
  activity_id: string
  application_type: ApplicationType
  wait_order: number | null
  offer_status: OfferStatus
  offer_expires_at: string | null
}

export type Seats = { participant_count: number; waitlist_count: number }

export type ScheduleEntry = Seats & {
  activity: Activity
  /** The viewer's own application, or null when they have not applied. */
  mine: MyApplication | null
}

const ACTIVITY_COLUMNS = 'id, kind, title, activity_date, start_time, end_time, place, capacity'
const APPLICATION_COLUMNS =
  'id, activity_id, application_type, wait_order, offer_status, offer_expires_at'

// Far enough back that last month's training is still reachable, near enough
// that the list stays a schedule rather than an archive.
const PAST_WINDOW_DAYS = 30
const NO_SEATS: Seats = { participant_count: 0, waitlist_count: 0 }

// ---------------------------------------------------------------- narrowing
// Every one of these columns is constrained by a CHECK in 0001, but the
// generated types widen them to `string`. Narrowing happens once, here, rather
// than as a cast at each render site.

function toKind(value: string): ActivityKind {
  return (ACTIVITY_KINDS as readonly string[]).includes(value) ? (value as ActivityKind) : 'event'
}

// These two fallbacks lean to the less privileged reading on purpose: an
// unrecognised type counts as a waitlist entry and an unrecognised offer as no
// offer, so a value this client does not understand can never render a seat or
// a live 수락 button the server did not actually grant.
function toApplicationType(value: string): ApplicationType {
  return value === 'participant' ? 'participant' : 'waitlist'
}

function toOfferStatus(value: string): OfferStatus {
  const known: readonly string[] = ['none', 'offered', 'accepted', 'declined', 'expired']
  return known.includes(value) ? (value as OfferStatus) : 'none'
}

type ActivityRow = {
  id: string
  kind: string
  title: string
  activity_date: string
  start_time: string | null
  end_time: string | null
  place: string | null
  capacity: number | null
}

const toActivity = (row: ActivityRow): Activity => ({ ...row, kind: toKind(row.kind) })

type ApplicationRow = {
  id: string
  activity_id: string
  application_type: string
  wait_order: number | null
  offer_status: string
  offer_expires_at: string | null
}

const toApplication = (row: ApplicationRow): MyApplication => ({
  id: row.id,
  activity_id: row.activity_id,
  application_type: toApplicationType(row.application_type),
  wait_order: row.wait_order,
  offer_status: toOfferStatus(row.offer_status),
  offer_expires_at: row.offer_expires_at,
})

// ------------------------------------------------------------------- reads

// Asked of the server rather than threaded down from the session. It matters
// more here than in notices: staff can read every application row, so a query
// filtered only by activity would hand an admin somebody else's application
// as "mine".
async function getMyMemberId(): Promise<string> {
  const { data, error } = await supabase.rpc('current_member_id')
  if (error) throw error
  if (!data) throw new Error('승인된 회원이 아닙니다')
  return data
}

// Counts come from a view because applications_read shows a member only their
// own row — counting activity_applications in the browser would answer 0 or 1
// for every activity. An activity with no applications is simply absent from
// the view, so a missing row means zero rather than a failure.
async function getSeats(activityIds: string[]): Promise<Map<string, Seats>> {
  const { data, error } = await supabase
    .from('activity_seats_v')
    .select('activity_id, participant_count, waitlist_count')
    .in('activity_id', activityIds)
  if (error) throw error

  const seats = new Map<string, Seats>()
  for (const row of data ?? []) {
    if (!row.activity_id) continue
    seats.set(row.activity_id, {
      participant_count: row.participant_count ?? 0,
      waitlist_count: row.waitlist_count ?? 0,
    })
  }
  return seats
}

async function getMyApplications(
  memberId: string,
  activityIds: string[],
): Promise<Map<string, MyApplication>> {
  const { data, error } = await supabase
    .from('activity_applications')
    .select(APPLICATION_COLUMNS)
    .eq('member_id', memberId)
    .in('activity_id', activityIds)
  if (error) throw error

  const mine = new Map<string, MyApplication>()
  for (const row of data ?? []) mine.set(row.activity_id, toApplication(row))
  return mine
}

/** Upcoming activities first, each with its seat counts and the viewer's own status. */
export async function listSchedule(kind?: ActivityKind): Promise<ScheduleEntry[]> {
  const today = todayKey()
  const memberId = await getMyMemberId()

  let query = supabase
    .from('activities')
    .select(ACTIVITY_COLUMNS)
    .gte('activity_date', shiftDays(today, -PAST_WINDOW_DAYS))
    .order('activity_date', { ascending: true })
    .order('start_time', { ascending: true, nullsFirst: true })
    .limit(200)
  if (kind) query = query.eq('kind', kind)

  const { data, error } = await query
  if (error) throw error

  // The database orders by date so the limit takes the right rows; the final
  // upcoming-then-past arrangement is a display decision and stays in JS.
  const activities = sortUpcomingFirst((data ?? []).map(toActivity), today)
  if (activities.length === 0) return []

  const ids = activities.map((a) => a.id)
  const [seats, mine] = await Promise.all([getSeats(ids), getMyApplications(memberId, ids)])

  return activities.map((activity) => ({
    activity,
    ...(seats.get(activity.id) ?? NO_SEATS),
    mine: mine.get(activity.id) ?? null,
  }))
}

/** One activity with its seat counts and the viewer's own application. */
export async function getScheduleEntry(activityId: string): Promise<ScheduleEntry> {
  const memberId = await getMyMemberId()

  const [activity, seats, mine] = await Promise.all([
    getActivity(activityId),
    supabase
      .from('activity_seats_v')
      .select('activity_id, participant_count, waitlist_count')
      .eq('activity_id', activityId)
      .maybeSingle(),
    supabase
      .from('activity_applications')
      .select(APPLICATION_COLUMNS)
      .eq('activity_id', activityId)
      .eq('member_id', memberId)
      .maybeSingle(),
  ])

  if (seats.error) throw seats.error
  if (mine.error) throw mine.error

  return {
    activity,
    participant_count: seats.data?.participant_count ?? 0,
    waitlist_count: seats.data?.waitlist_count ?? 0,
    mine: mine.data ? toApplication(mine.data) : null,
  }
}

export async function getActivity(activityId: string): Promise<Activity> {
  const { data, error } = await supabase
    .from('activities')
    .select(ACTIVITY_COLUMNS)
    .eq('id', activityId)
    .single()
  if (error) throw error
  return toActivity(data)
}

// ------------------------------------------------------------------ writes

/**
 * Apply for a place. Never an insert into activity_applications — there is no
 * INSERT policy on that table, and the RPC is what locks the activity row and
 * decides seat versus waitlist.
 *
 * The returned row is the server's verdict and the only thing a caller may
 * render the outcome from. The legacy screen decided from a cached participant
 * count (index.html:2384), which is how two people took the same last seat.
 */
export async function applyToActivity(activityId: string): Promise<MyApplication> {
  const { data, error } = await supabase.rpc('apply_to_activity', { p_activity_id: activityId })
  if (error) throw error
  return toApplication(data)
}

/**
 * Withdraw. A direct delete, allowed by applications_self_delete — RLS is what
 * confines it to the caller's own row, so no member id is sent.
 *
 * Returns nothing: whether a freed seat moved to the next person in line is the
 * server's business, and the caller learns it by refetching.
 */
export async function cancelApplication(applicationId: string): Promise<void> {
  const { error } = await supabase.from('activity_applications').delete().eq('id', applicationId)
  if (error) throw error
}

/**
 * Answer a waitlist offer. The RPC re-checks the deadline and the seat count
 * under the activity row lock, so an offer that lapsed while the card was on
 * screen comes back as expired rather than being honoured.
 */
export async function respondToOffer(input: {
  activityId: string
  accept: boolean
}): Promise<MyApplication> {
  const { data, error } = await supabase.rpc('respond_waitlist_offer', {
    p_activity_id: input.activityId,
    p_accept: input.accept,
  })
  if (error) throw error
  return toApplication(data)
}

// ------------------------------------------------------------- staff writes
// Guarded by activities_write (is_staff) in the database and by RequireStaff in
// the route tree. Nothing here re-checks the role, because a check here would
// only decide what to render.

export type ActivityInput = {
  kind: ActivityKind
  title: string
  activity_date: string
  start_time: string | null
  end_time: string | null
  place: string | null
  capacity: number | null
}

export async function createActivity(input: ActivityInput): Promise<Activity> {
  const { data: memberId, error: memberError } = await supabase.rpc('current_member_id')
  if (memberError) throw memberError

  const { data, error } = await supabase
    .from('activities')
    .insert({ ...input, title: input.title.trim(), created_by: memberId })
    .select(ACTIVITY_COLUMNS)
    .single()
  if (error) throw error
  return toActivity(data)
}

export async function updateActivity(
  input: ActivityInput & { activityId: string },
): Promise<Activity> {
  const { activityId, ...fields } = input
  const { data, error } = await supabase
    .from('activities')
    .update({
      ...fields,
      title: fields.title.trim(),
      // Set explicitly, same as notices: the column defaults to now() on insert
      // but no trigger touches it on update.
      updated_at: new Date().toISOString(),
    })
    .eq('id', activityId)
    .select(ACTIVITY_COLUMNS)
    .single()
  if (error) throw error
  return toActivity(data)
}

/** Cascades to applications and attendance, so the caller confirms first. */
export async function deleteActivity(activityId: string): Promise<void> {
  const { error } = await supabase.from('activities').delete().eq('id', activityId)
  if (error) throw error
}
