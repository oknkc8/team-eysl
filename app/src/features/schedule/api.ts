import { supabase } from '../../lib/supabase'
import { lastDayOfMonth, monthPrefix } from './calendar'
import { hasFinished, shiftDays, sortUpcomingFirst, todayKey } from './order'
import { toKind, type ActivityKind } from './kinds'
import { dedupeRaceHistory, type RaceHistoryRow } from './raceHistory'

// The kind vocabulary lives in kinds.ts, which imports nothing: this module
// loads the Supabase client at import time, so anything testable had to move out
// from under it. Re-exported so call sites keep a single import.
export { ACTIVITY_KINDS, KIND_LABEL, toKind } from './kinds'
export type { ActivityKind } from './kinds'

// Same reason as kinds.ts: the dedupe rule is testable without a client.
export { isFinished, isWaiting } from './raceHistory'
export type { RaceHistoryRow } from './raceHistory'

export type ApplicationType = 'participant' | 'waitlist'
export type OfferStatus = 'none' | 'offered' | 'accepted' | 'declined' | 'expired'

export type Activity = {
  id: string
  kind: ActivityKind
  title: string
  activity_date: string
  /**
   * The last day of a multi-day activity, or null for the single-day majority.
   *
   * A real column rather than a `details` key, and the reasoning belongs next to
   * the field. His app holds this in details.endDate and reads it in seven
   * places while writing it in none — his 일정 등록 has no end-date input at all,
   * and registerSchedule rebuilds details from scratch, so editing a multi-day
   * race in his app silently collapses it to one day. That is the same shape as
   * the backfilled-attendance loss CLAUDE.md already records.
   *
   * Ours cannot lose it the same way: this is part of ActivityInput, so an edit
   * that failed to carry it would not compile. `end_date >= activity_date` is a
   * CHECK, which a jsonb key could never have been given.
   */
  end_date: string | null
  start_time: string | null
  end_time: string | null
  place: string | null
  capacity: number | null
  /**
   * Who filed it. Derived by the activities_created_by trigger (0015) from the
   * session, never from the request — a member who could send this column could
   * file an activity in somebody else's name and then edit it as its owner.
   * Read here because canEditActivity() needs it; null on rows filed before
   * anyone was attributed.
   */
  created_by: string | null
  /** Coach, gear, notes, link and plan. Empty fields read as null, not ''. */
  detail: TrainingDetail
  /**
   * Carried so an edit can prove it saw this version. saveTrainingDetail sends
   * it back as p_expected_updated_at and the function refuses a mismatch, which
   * is what stops two staffers overwriting each other's plan.
   */
  updated_at: string
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

const ACTIVITY_COLUMNS =
  'id, kind, title, activity_date, end_date, start_time, end_time, place, capacity, created_by, details, updated_at'
const APPLICATION_COLUMNS =
  'id, activity_id, application_type, wait_order, offer_status, offer_expires_at'

// Far enough back that last month's training is still reachable, near enough
// that the list stays a schedule rather than an archive.
const PAST_WINDOW_DAYS = 30
const NO_SEATS: Seats = { participant_count: 0, waitlist_count: 0 }

// ---------------------------------------------------------------- narrowing
// Every one of these columns is constrained by a CHECK in 0001, but the
// generated types widen them to `string`. Narrowing happens once, here, rather
// than as a cast at each render site. toKind() is the same idea and lives in
// kinds.ts with the labels it goes with.

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
  end_date: string | null
  start_time: string | null
  end_time: string | null
  place: string | null
  capacity: number | null
  created_by: string | null
  details: unknown
  updated_at: string
}

/**
 * The training-detail keys, and only those.
 *
 * `details` also carries keys this feature has no business reading — the
 * importer's `source`, and the backfilled `historical_*` registers — so it is
 * narrowed here rather than handed to the screens whole. Reading it as a
 * Record<string, unknown> and picking six names means a key added by somebody
 * else cannot appear on a training screen by accident.
 */
export type TrainingDetail = {
  coach: string | null
  gear: string | null
  info: string | null
  link: string | null
  plan: string | null
  plan_by: string | null
  plan_at: string | null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

const toTrainingDetail = (raw: unknown): TrainingDetail => {
  const d = (raw ?? {}) as Record<string, unknown>
  return {
    coach: str(d.coach),
    gear: str(d.gear),
    info: str(d.info),
    link: str(d.link),
    plan: str(d.plan),
    plan_by: str(d.plan_by),
    plan_at: str(d.plan_at),
  }
}

const toActivity = (row: ActivityRow): Activity => ({
  ...row,
  kind: toKind(row.kind),
  detail: toTrainingDetail(row.details),
})

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

/**
 * Seat counts and the viewer's own application, attached to a page of rows.
 *
 * Shared by the list and the calendar so the two screens cannot drift into
 * disagreeing about whether somebody holds a seat — which is exactly the split
 * status.ts documents between his list and his home screen.
 */
async function withSeatsAndMine(
  activities: Activity[],
  memberId: string,
): Promise<ScheduleEntry[]> {
  if (activities.length === 0) return []
  const ids = activities.map((a) => a.id)
  const [seats, mine] = await Promise.all([getSeats(ids), getMyApplications(memberId, ids)])
  return activities.map((activity) => ({
    activity,
    ...(seats.get(activity.id) ?? NO_SEATS),
    mine: mine.get(activity.id) ?? null,
  }))
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
  return withSeatsAndMine(activities, memberId)
}

/**
 * Every activity that touches one calendar month.
 *
 * NOT listSchedule with a different filter: that one reaches back a fixed 30
 * days from today and forward without limit, which is the right window for
 * "무엇을 신청하지?" and the wrong one for a month a member has paged back to.
 *
 * The overlap test is the part worth reading twice. A multi-day race that STARTS
 * in March and ENDS in April belongs on April's calendar too, so filtering on
 * activity_date alone would drop it from a month it visibly occupies:
 *
 *   activity_date <= last day of the month     -- starts by the end of it
 *   AND (activity_date >= first day            -- ... and either starts inside
 *        OR end_date  >= first day)            -- ... or runs into it
 *
 * end_date is null on a single-day row, so that arm evaluates to NULL rather
 * than to false — and `false OR NULL` is NULL, which a WHERE clause discards
 * exactly as it discards false. Those rows are therefore decided entirely by the
 * first arm. Verified against the database rather than reasoned about: of seven
 * synthetic rows spanning every shape, the four that touch March came back and
 * the single-day row in February did not.
 */
/**
 * The most activities one month may show.
 *
 * This club runs a few dozen activities a year, so the cap is not expected to
 * bind. It exists because an unbounded month query is unbounded, and the screen
 * has to be able to SAY when it bound — a calendar quietly missing the last
 * three days of a month looks like an empty calendar, not a truncated one.
 */
const MONTH_LIMIT = 200

export type MonthEntries = {
  entries: ScheduleEntry[]
  /** True when more activities exist in this month than were returned. */
  truncated: boolean
}

export async function listActivitiesInMonth(
  year: number,
  month: number,
  kind?: ActivityKind,
): Promise<MonthEntries> {
  const memberId = await getMyMemberId()
  const first = `${monthPrefix(year, month)}-01`
  const last = lastDayOfMonth(year, month)

  let query = supabase
    .from('activities')
    .select(ACTIVITY_COLUMNS)
    .lte('activity_date', last)
    .or(`activity_date.gte.${first},end_date.gte.${first}`)
    .order('activity_date', { ascending: true })
    .order('start_time', { ascending: true, nullsFirst: true })
    // One more than we intend to show. Asking for exactly MONTH_LIMIT and
    // getting MONTH_LIMIT back is indistinguishable from "that is all there is"
    // — the extra row is the only thing that tells the two apart.
    .limit(MONTH_LIMIT + 1)
  if (kind) query = query.eq('kind', kind)

  const { data, error } = await query
  if (error) throw error

  const rows = data ?? []
  const truncated = rows.length > MONTH_LIMIT
  const entries = await withSeatsAndMine(rows.slice(0, MONTH_LIMIT).map(toActivity), memberId)
  return { entries, truncated }
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

/**
 * Seats an activity has already committed: confirmed participants plus offers
 * that have not lapsed. The same number 0020's activities_capacity_floor trigger
 * refuses to let capacity fall below.
 *
 * Read by the edit screen so it can say what is in the way before staff press
 * 저장. The refusal itself stays the database's — this only spares them a bare
 * 저장 실패 with no reason attached.
 */
export async function getReservedSeats(activityId: string): Promise<number> {
  const { data, error } = await supabase
    .from('activity_seats_v')
    .select('reserved_count')
    .eq('activity_id', activityId)
    .maybeSingle()
  if (error) throw error
  // An activity nobody has applied to is absent from the view, not zero-valued.
  return data?.reserved_count ?? 0
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

// ------------------------------------------------- 활동 취합본 (staff view)

/** One applicant, as the summary needs them: a name and which list they are on. */
export type ApplicantName = {
  memberId: string
  nickname: string
  applicationType: ApplicationType
  wait_order: number | null
}

/**
 * A member staff can put on an activity, because that member has no way to put
 * themselves on one. Carries no auth user id: the browser needs the fact, not
 * the identifier behind it.
 */
export type EnrollableMember = {
  memberId: string
  nickname: string
  alreadyEnrolled: boolean
}

export type ApplicationSummary = {
  activity: Activity
  participants: ApplicantName[]
  waitlist: ApplicantName[]
  /** Its date has passed — his card's 종료 tag. */
  finished: boolean
}

/**
 * Every activity with the people who applied to it.
 *
 * Deliberately not `attendance_for_activity_v1`, which is the only other
 * applicant-shaped read in the app: that RPC filters to
 * `application_type = 'participant'` (0001:262), so the waitlist — half of what
 * this screen exists to show — is invisible through it.
 *
 * Names come from `members` rather than `member_public_v` because the view is
 * confined to approved rows (0001:158-161). Somebody who applied and was later
 * blocked is precisely the row a staffer needs to see on a roster they are about
 * to act on, and through the view they would silently disappear from it.
 *
 * `applications_read` (0001:188-190) is the real gate here — it says
 * `member_id = current_member_id() or is_staff()`, so a non-staff caller gets
 * their own applications and nothing else. The screen asks the server whether
 * the caller is staff and prints a refusal rather than rendering that as a
 * suspiciously short roster.
 */
export async function listApplicationSummaries(
  kind?: ActivityKind,
): Promise<ApplicationSummary[]> {
  const today = todayKey()

  let query = supabase
    .from('activities')
    .select(ACTIVITY_COLUMNS)
    .order('activity_date', { ascending: false })
    .order('start_time', { ascending: false, nullsFirst: false })
    .limit(200)
  if (kind) query = query.eq('kind', kind)

  const { data, error } = await query
  if (error) throw error

  const activities = (data ?? []).map(toActivity)
  if (activities.length === 0) return []

  const applications = await supabase
    .from('activity_applications')
    .select('activity_id, member_id, application_type, wait_order')
    .in(
      'activity_id',
      activities.map((a) => a.id),
    )
  if (applications.error) throw applications.error

  const rows = applications.data ?? []
  const nicknames = await getNicknames(rows.map((row) => row.member_id))

  const byActivity = new Map<string, { participants: ApplicantName[]; waitlist: ApplicantName[] }>()
  for (const row of rows) {
    const bucket = byActivity.get(row.activity_id) ?? { participants: [], waitlist: [] }
    const applicant: ApplicantName = {
      memberId: row.member_id,
      // A member the roster query did not return is shown as an unnamed member
      // rather than dropped: the count on the card has to stay truthful.
      nickname: nicknames.get(row.member_id) ?? '이름 없는 회원',
      applicationType: toApplicationType(row.application_type),
      wait_order: row.wait_order,
    }
    if (applicant.applicationType === 'participant') bucket.participants.push(applicant)
    else bucket.waitlist.push(applicant)
    byActivity.set(row.activity_id, bucket)
  }

  return activities.map((activity) => {
    const bucket = byActivity.get(activity.id) ?? { participants: [], waitlist: [] }
    return {
      activity,
      participants: [...bucket.participants].sort((a, b) => a.nickname.localeCompare(b.nickname)),
      // The queue order is the information here, so this one is not alphabetised.
      waitlist: [...bucket.waitlist].sort((a, b) => (a.wait_order ?? 0) - (b.wait_order ?? 0)),
      // The staff view of an activity has to agree with the member's about
      // whether it is over, or a 취합본 reads finished while the member can
      // still cancel.
      finished: hasFinished(activity, today),
    }
  })
}

/** id → nickname for a batch of applicants. Empty for a caller RLS refuses. */
async function getNicknames(memberIds: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(memberIds)]
  const names = new Map<string, string>()
  if (unique.length === 0) return names

  const { data, error } = await supabase.from('members').select('id, nickname').in('id', unique)
  if (error) throw error

  for (const row of data ?? []) names.set(row.id, row.nickname)
  return names
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
 * Approved members who cannot sign in, and whether each is already on this
 * activity. 36 of our 41 members are in this list: their rows came from the
 * club's spreadsheet and nobody ever had an account, so they can neither apply
 * nor be seen to have applied.
 *
 * The `alreadyEnrolled` flag is what lets the card mark the people on it who
 * cannot be reached — staff need to know who will not get a push and cannot
 * answer a waitlist offer.
 *
 * Empty for a non-staff caller rather than an error: 0042 filters on is_staff()
 * the way 0030 does, so this returns zero rows instead of throwing.
 */
export async function listEnrollableMembers(activityId: string): Promise<EnrollableMember[]> {
  const { data, error } = await supabase.rpc('activity_enrollable_members_v1', {
    p_activity_id: activityId,
  })
  if (error) throw error
  return (data ?? []).map((row) => ({
    memberId: row.member_id,
    nickname: row.nickname,
    alreadyEnrolled: row.already_enrolled,
  }))
}

/**
 * Put a member on an activity on their behalf. Only a member who cannot sign in
 * — anyone with a login applies for themselves, and the RPC refuses rather than
 * letting staff speak for them.
 *
 * A full activity REFUSES instead of queueing. That is deliberate and is the
 * one place this differs from applyToActivity: offer_seat_to_next_waitlister()
 * picks by wait_order without asking whether the person can answer, so queueing
 * somebody who cannot sign in would park a live seat for 12 hours and lapse it,
 * once per turn, at the expense of everybody behind them.
 */
export async function enrolMember(activityId: string, memberId: string): Promise<MyApplication> {
  const { data, error } = await supabase.rpc('activity_enrol_member_v1', {
    p_activity_id: activityId,
    p_member_id: memberId,
  })
  if (error) throw error
  return toApplication(data)
}

/**
 * Take a staff-enrolled member back off. Ships with enrolMember rather than
 * after it: applications_self_delete is the only DELETE policy on the table and
 * it is `member_id = current_member_id()`, so a row created by enrolMember is
 * deletable by nobody without this — the member cannot log in to withdraw and
 * staff have no policy to do it for them.
 *
 * Returns whether a row actually went, so a second press is not an error.
 */
export async function unenrolMember(activityId: string, memberId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('activity_unenrol_member_v1', {
    p_activity_id: activityId,
    p_member_id: memberId,
  })
  if (error) throw error
  return data === true
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

// ------------------------------------------------------------------- writes
// Four RLS policies decide these, not this file (0015). Staff keep every command
// on every kind through activities_write; an approved member may insert a row
// only when kind = 'event' and may update or delete it only while they are its
// creator and it is still a 기타.
//
// Nothing here re-checks any of that. permissions.ts mirrors the same rules for
// the screens, so a button is offered only when the write behind it would
// succeed — but the refusal itself is the database's, and these functions are
// written to surface it rather than to pre-empt it.

export type ActivityInput = {
  kind: ActivityKind
  title: string
  activity_date: string
  /** Null for a single-day activity. The CHECK refuses anything before the start. */
  end_date: string | null
  start_time: string | null
  end_time: string | null
  place: string | null
  capacity: number | null
}

/**
 * File an activity. created_by is deliberately absent from the payload: the
 * activities_created_by trigger (0015) fills it from the session, and a value
 * sent from here would be overwritten anyway. Asking the server who we are
 * first, as this used to, was both a round trip and a claim the client is not
 * entitled to make.
 */
export async function createActivity(input: ActivityInput): Promise<Activity> {
  const { data, error } = await supabase
    .from('activities')
    .insert({ ...input, title: input.title.trim() })
    .select(ACTIVITY_COLUMNS)
    .single()
  if (error) throw error
  return toActivity(data)
}

/**
 * Save an edit. A row RLS declines to hand over simply does not match, so
 * .single() is what turns a refusal into a thrown error instead of a silent
 * success — the caller must never report 저장됨 for a write the database
 * discarded. kind is sent like any other field; a member trying to promote their
 * own 기타 to 훈련 fails the policy's WITH CHECK and lands here as an error,
 * which is what the live probe against the dev database showed.
 */
export type TrainingDetailInput = {
  activityId: string
  coach: string
  gear: string
  info: string
  link: string
  plan: string
  /** The updated_at this edit started from. The function refuses a mismatch. */
  expectedUpdatedAt: string
}

/**
 * Save the training detail through save_activity_details_v1 (0048).
 *
 * NOT a `.from('activities').update({ details })`, and the difference is the
 * whole point. A client that sends the whole jsonb object silently deletes
 * every key it does not know about — which is exactly how the president's app
 * loses a backfilled attendance register when somebody edits a past training.
 * The function merges the six fields it owns and leaves the rest alone, so a
 * key we have never heard of survives an edit here by construction.
 *
 * PT409 is the version conflict, distinct from 42704 (no such activity) and
 * 42501 (not staff), so the screen can tell "somebody else saved" from "it is
 * gone" and from "you may not".
 */
export async function saveTrainingDetail(input: TrainingDetailInput): Promise<TrainingDetail> {
  const { data, error } = await supabase.rpc('save_activity_details_v1', {
    p_activity_id: input.activityId,
    p_coach: input.coach,
    p_gear: input.gear,
    p_info: input.info,
    p_link: input.link,
    p_plan: input.plan,
    // Sent verbatim as the string PostgREST gave us. Rebuilding it through
    // `new Date(...).toISOString()` truncates microseconds to milliseconds, and
    // every save would then conflict with itself — the same trap the board
    // editor documents.
    p_expected_updated_at: input.expectedUpdatedAt,
  })
  if (error) throw error
  const row = (data ?? {}) as Record<string, unknown>
  return toTrainingDetail(row.details)
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

/**
 * Cascades to applications and attendance, so the caller confirms first.
 *
 * The .select() is not decoration. A delete that matches no row under RLS
 * returns no error — the same trap CancelButton documents — so a member who
 * reached this for somebody else's activity would otherwise be told it worked.
 * Nothing came back means nothing was deleted.
 */
export async function deleteActivity(activityId: string): Promise<void> {
  const { data, error } = await supabase
    .from('activities')
    .delete()
    .eq('id', activityId)
    .select('id')
  if (error) throw error
  if (!data || data.length === 0) throw new Error('삭제할 권한이 없거나 이미 삭제된 일정입니다')
}

/**
 * The viewer's own race history. Takes no member id — the server reads it from
 * the session, the same as attendance_my_history_v1.
 *
 * Unlike listSchedule, this is not filtered to a date window: a member's race
 * history is the whole point of the screen, so an old meet has to stay
 * reachable. The rows arrive newest first and already carry a Korean status the
 * server computed in Asia/Seoul.
 */
export async function getMyRaceHistory(): Promise<RaceHistoryRow[]> {
  const { data, error } = await supabase.rpc('race_my_history_v1')
  if (error) throw error
  return dedupeRaceHistory((data ?? []) as RaceHistoryRow[])
}
