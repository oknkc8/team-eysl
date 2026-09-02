import { supabase } from '../../lib/supabase'
import type { Role } from '../auth/schema'
import { getMemberRaceEvents } from '../records/api'
import type { AssignableTeamRole } from './teamRole'

// Avatars live in their own bucket, separate from team-files: an avatar is
// readable by every approved member, while a media file's object path also
// decides who may replace it.
// Exported so 마이페이지 writes to the same bucket this module reads from. Two
// spellings of a bucket name is the kind of drift that fails only at runtime,
// and only for the person whose photo went to the wrong place.
export const AVATAR_BUCKET = 'profile-images'

// Long enough that a roster of forty faces finishes painting on a slow phone,
// short enough that a URL copied out of the page stops working. Notices sign
// for 60s because a click follows immediately; here the browser is the caller.
const AVATAR_URL_TTL_SECONDS = 600

export type MemberStatus = 'pending' | 'approved' | 'rejected' | 'blocked'

// What set_member_role_v1() will actually accept. 'master_admin' is missing on
// purpose — the function refuses it, so offering it in a control would build
// something whose only outcome is an error.
export const ASSIGNABLE_ROLES: readonly Role[] = ['member', 'admin']

// Korean is a render-time concern; the database stores English tokens, the same
// split as schedule's KIND_LABEL. The wording is the legacy screen's own.
export const ROLE_LABEL: Record<Role, string> = {
  member: '일반회원',
  admin: '부관리자',
  master_admin: '총관리자',
}

export const STATUS_LABEL: Record<MemberStatus, string> = {
  pending: '승인 대기',
  approved: '승인됨',
  rejected: '거절됨',
  blocked: '내보낸 회원',
}

/** The fields member_public_v exposes — no 실명, 생년월일, 메모 or 연락처. */
export type RosterMember = {
  id: string
  nickname: string
  short_name: string | null
  team_role: string | null
  role: Role
  /** Signed on read; null when there is no avatar or the signature failed. */
  avatar_url: string | null
}

/** The columns only a staff viewer gets, straight off members. */
export type MemberPrivateFields = {
  real_name: string | null
  birth_date_text: string | null
  birth_year: number | null
  gender: string | null
  location: string | null
  join_date_text: string | null
  join_reason: string | null
  lesson_level: string | null
  swim_experience: string | null
  notes: string | null
  status: MemberStatus
  historical_attendance_count_legacy: number
  historical_late_count_legacy: number
}

export type MemberDetail = {
  member: RosterMember
  /** null for a viewer RLS did not hand the row to. */
  privateFields: MemberPrivateFields | null
}

/** One row of the approval queue. Staff-only by RLS, so private fields are fine. */
export type ApprovalCandidate = {
  id: string
  nickname: string
  real_name: string | null
  join_date_text: string | null
  join_reason: string | null
  lesson_level: string | null
  swim_experience: string | null
  status: MemberStatus
  role: Role
  created_at: string
}

export type ApprovalQueue = {
  pending: ApprovalCandidate[]
  /** Recently decided, so a staffer can see their click landed. */
  processed: ApprovalCandidate[]
}

/** A roster member plus the standing that decides whether they can still get in. */
export type MemberAccess = RosterMember & { status: MemberStatus }

/**
 * The two lists 회원 내보내기 works on.
 *
 * Split here rather than in the screen so the rule has one home: only an
 * approved member can be blocked and only a blocked member can be restored,
 * which is what set_member_blocked_v1 enforces. Anyone pending or rejected
 * belongs to the approval queue and appears on neither list.
 */
export type MemberAccessLists = {
  active: MemberAccess[]
  blocked: MemberAccess[]
}

const ROSTER_COLUMNS = 'id, nickname, short_name, avatar_path, team_role, role'
const APPROVAL_COLUMNS =
  'id, nickname, real_name, join_date_text, join_reason, lesson_level, swim_experience, status, role, created_at'
// Read off members rather than member_public_v, which is approved-only
// (0001:158-161) — a blocked member is precisely who this list has to show.
const ACCESS_COLUMNS = 'id, nickname, short_name, avatar_path, team_role, role, status'
const PRIVATE_COLUMNS =
  'real_name, birth_date_text, birth_year, gender, location, join_date_text, join_reason, lesson_level, swim_experience, notes, status, historical_attendance_count_legacy, historical_late_count_legacy'

// The club is around forty people; a roster that needed paging would be a
// different screen.
const ROSTER_LIMIT = 500
const PROCESSED_LIMIT = 10

// ---------------------------------------------------------------- narrowing
// Both columns are constrained by a CHECK in 0001, but the generated types
// widen them to `string`. Narrowing happens once, here, rather than as a cast
// at each render site.

// Leans to the least privileged reading, the same way schedule's
// toApplicationType does: a role token this client does not understand must
// never render as 총관리자 or unlock a control.
function toRole(value: string | null): Role {
  if (value === 'master_admin') return 'master_admin'
  if (value === 'admin') return 'admin'
  return 'member'
}

// Leans to 'pending' for the mirror-image reason: an unreadable status is not
// evidence that somebody was approved.
function toStatus(value: string | null): MemberStatus {
  if (value === 'approved') return 'approved'
  if (value === 'rejected') return 'rejected'
  if (value === 'blocked') return 'blocked'
  return 'pending'
}

// ------------------------------------------------------------------ avatars

/**
 * Signed URLs for a batch of avatar paths, best effort.
 *
 * One request for the whole roster rather than one per face. A path that fails
 * to sign is simply absent from the map and the row falls back to its initial —
 * which is a first-class rendering here, not a degraded one. Failing the whole
 * roster over a storage hiccup would trade forty names for forty faces.
 */
async function signAvatars(paths: string[]): Promise<Map<string, string>> {
  const signed = new Map<string, string>()
  if (paths.length === 0) return signed

  const { data, error } = await supabase.storage
    .from(AVATAR_BUCKET)
    .createSignedUrls(paths, AVATAR_URL_TTL_SECONDS)
  if (error) return signed

  for (const row of data ?? []) {
    if (row.error || !row.path || !row.signedUrl) continue
    signed.set(row.path, row.signedUrl)
  }
  return signed
}

type RosterRow = {
  id: string | null
  nickname: string | null
  short_name: string | null
  avatar_path: string | null
  team_role: string | null
  role: string | null
}

function toRoster(rows: RosterRow[], avatars: Map<string, string>): RosterMember[] {
  // Every column of a view is nullable in the generated types, so a row without
  // an id is skipped rather than cast into one.
  const members: RosterMember[] = []
  for (const row of rows) {
    if (!row.id) continue
    members.push({
      id: row.id,
      nickname: row.nickname ?? '이름 없는 회원',
      short_name: row.short_name,
      team_role: row.team_role,
      role: toRole(row.role),
      avatar_url: (row.avatar_path && avatars.get(row.avatar_path)) || null,
    })
  }
  return members
}

// ------------------------------------------------------------------- reads

/**
 * The roster, from member_public_v and never from members.
 *
 * The view exists precisely so a list of names cannot leak 실명, 생년월일, 메모
 * or 연락처, and it is already confined to approved members (0001:158-161).
 * Reading members here would also return almost nothing: members_read shows a
 * non-staff viewer only their own row.
 */
export async function listRoster(): Promise<RosterMember[]> {
  const { data, error } = await supabase
    .from('member_public_v')
    .select(ROSTER_COLUMNS)
    .order('nickname', { ascending: true })
    .limit(ROSTER_LIMIT)
  if (error) throw error

  const rows = data ?? []
  const paths = rows.map((row) => row.avatar_path).filter((path): path is string => !!path)
  return toRoster(rows, await signAvatars(paths))
}

/**
 * One member: the public fields for anyone, plus the private ones for a viewer
 * the database is willing to hand them to.
 *
 * `includePrivate` only decides whether the second request is worth making —
 * members_read is what decides whether it returns anything. A member who flips
 * the flag in a debugger gets their own row and nobody else's, so the screen
 * cannot be argued into showing 실명 by a client-side edit.
 */
export async function getMemberDetail(
  memberId: string,
  options: { includePrivate: boolean },
): Promise<MemberDetail> {
  const { data, error } = await supabase
    .from('member_public_v')
    .select(ROSTER_COLUMNS)
    .eq('id', memberId)
    .maybeSingle()
  if (error) throw error
  if (!data?.id) throw new Error('회원을 찾을 수 없습니다')

  const paths = data.avatar_path ? [data.avatar_path] : []
  const [member] = toRoster([data], await signAvatars(paths))
  if (!member) throw new Error('회원을 찾을 수 없습니다')

  if (!options.includePrivate) return { member, privateFields: null }

  const privateResult = await supabase
    .from('members')
    .select(PRIVATE_COLUMNS)
    .eq('id', memberId)
    .maybeSingle()
  if (privateResult.error) throw privateResult.error

  const row = privateResult.data
  return {
    member,
    // RLS answering with no row is the expected outcome for a viewer it does not
    // trust, not a failure — the screen simply shows the public half.
    privateFields: row ? { ...row, status: toStatus(row.status) } : null,
  }
}

type ApprovalRow = {
  id: string
  nickname: string
  real_name: string | null
  join_date_text: string | null
  join_reason: string | null
  lesson_level: string | null
  swim_experience: string | null
  status: string
  role: string
  created_at: string
}

const toCandidate = (row: ApprovalRow): ApprovalCandidate => ({
  ...row,
  status: toStatus(row.status),
  role: toRole(row.role),
})

/**
 * Everyone waiting, and the last few already decided.
 *
 * Read straight off members rather than through an RPC: members_read already
 * says `auth_user_id = auth.uid() or is_staff()`, so a non-staff caller sees
 * their own row at most and this list collapses to nothing. The queue does not
 * need a SECURITY DEFINER function to be safe; the writes do.
 */
export async function getApprovalQueue(): Promise<ApprovalQueue> {
  const [pendingResult, processedResult] = await Promise.all([
    supabase
      .from('members')
      .select(APPROVAL_COLUMNS)
      .eq('status', 'pending')
      .order('created_at', { ascending: true }),
    supabase
      .from('members')
      .select(APPROVAL_COLUMNS)
      .in('status', ['approved', 'rejected'])
      // A master admin is the person doing the deciding; listing them among the
      // decided is noise, and set_member_status_v1() refuses them anyway.
      .neq('role', 'master_admin')
      .order('updated_at', { ascending: false })
      .limit(PROCESSED_LIMIT),
  ])
  if (pendingResult.error) throw pendingResult.error
  if (processedResult.error) throw processedResult.error

  return {
    pending: (pendingResult.data ?? []).map(toCandidate),
    processed: (processedResult.data ?? []).map(toCandidate),
  }
}

/**
 * Everyone whose access is a live question: approved members and blocked ones.
 *
 * Off members rather than member_public_v, because the view is confined to
 * approved rows (0001:158-161) and a blocked member would simply be absent —
 * which is exactly the person this screen exists to show and restore.
 * members_read hands a non-staff caller only their own row, so the lists
 * collapse to nothing for anyone who should not have them.
 *
 * Avatars are signed for both lists in one request, the same as listRoster:
 * a blocked member is still a face somebody is deciding about.
 */
export async function getMemberAccessLists(): Promise<MemberAccessLists> {
  const { data, error } = await supabase
    .from('members')
    .select(ACCESS_COLUMNS)
    .in('status', ['approved', 'blocked'])
    .order('nickname', { ascending: true })
  if (error) throw error

  const rows = data ?? []
  const paths = rows.map((row) => row.avatar_path).filter((path): path is string => !!path)
  const avatars = await signAvatars(paths)

  const active: MemberAccess[] = []
  const blocked: MemberAccess[] = []
  for (const row of rows) {
    const [member] = toRoster([row], avatars)
    if (!member) continue
    const entry: MemberAccess = { ...member, status: toStatus(row.status) }
    // toStatus leans to 'pending' for a token it does not recognise, so an
    // unreadable status lands on neither list rather than on the one that
    // offers a 내보내기 button.
    if (entry.status === 'approved') active.push(entry)
    else if (entry.status === 'blocked') blocked.push(entry)
  }
  return { active, blocked }
}

// ------------------------------------------------- one member's activities
// The 활동 현황 drill-downs behind 회원 상세: 훈련, 대회, 기타.

/** The three buttons his rebuilt detail screen offers (index.html:3986-3988). */
export type MemberActivityKind = 'training' | 'race' | 'event'

export const ACTIVITY_KINDS: readonly MemberActivityKind[] = ['training', 'race', 'event']

/**
 * What each drill-down can honestly claim, which is not the same for all three.
 *
 * 훈련 is the odd one. His screen calls it 훈련 출석 현황 and fills it from
 * `member_history_v4(p_member_id)` — an RPC that takes an arbitrary member id
 * from the browser, which is exactly what 0001 refused to reproduce:
 * `attendance_my_history_v1` deliberately takes no id, and the `attendance`
 * table is deny-all with its grants revoked (0001:196-204). So there is no
 * server path to another member's attendance at all, and the title has to say
 * what the rows are — applications — rather than what his says they are.
 */
export const ACTIVITY_KIND_TITLE: Record<MemberActivityKind, string> = {
  training: '훈련 신청 내역',
  race: '대회 참가 현황',
  event: '기타 참여 현황',
}

export type MemberActivityRow = {
  id: string
  title: string
  /** 'YYYY-MM-DD'. Formatted at render time, never parsed into a Date. */
  date: string
  /** 참가 / 대기 / 5개 종목 — what this particular row attests to. */
  note: string
}

export type MemberActivityView = {
  /** False when RLS would answer with nothing; see `getMemberRecords`. */
  allowed: boolean
  rows: MemberActivityRow[]
  /**
   * Said on screen when the rows answer a narrower question than the heading
   * implies. Null when they answer it exactly.
   */
  caveat: string | null
}

const APPLICATION_NOTE: Record<string, string> = {
  participant: '신청',
  waitlist: '대기',
}

const NOT_ALLOWED: MemberActivityView = { allowed: false, rows: [], caveat: null }

/**
 * Training and 기타: what this member signed up for.
 *
 * Straight off `activity_applications` rather than through an RPC, because
 * `applications_read` (0001:188-190) already says
 * `member_id = current_member_id() or is_staff()` — a viewer it refuses gets
 * nothing back, so the entitlement is checked first and reported rather than
 * rendering as an empty history.
 *
 * Two queries rather than one `activities!inner(...)` embed, deliberately.
 * PostgREST returns an embedded to-one relationship as an object or as an array
 * depending on how it infers the relationship, and the generated types do not
 * pin it down — so a join here would need a hand-written cast that nothing in
 * this repo exercises, and if the guess were wrong every row would silently
 * render as 제목 없는 일정 rather than failing. Both halves below are shapes the
 * generated types already describe. A member's applications number in the
 * dozens, so the second round trip is not worth a cast nobody can check.
 */
async function getApplications(
  memberId: string,
  kind: 'training' | 'event',
): Promise<MemberActivityRow[]> {
  const applications = await supabase
    .from('activity_applications')
    .select('activity_id, application_type')
    .eq('member_id', memberId)
  if (applications.error) throw applications.error

  const rows = applications.data ?? []
  if (rows.length === 0) return []

  // The kind filter lands here rather than on the applications query, which
  // carries no kind of its own.
  const activities = await supabase
    .from('activities')
    .select('id, title, activity_date')
    .in(
      'id',
      rows.map((row) => row.activity_id),
    )
    .eq('kind', kind)
  if (activities.error) throw activities.error

  const byId = new Map((activities.data ?? []).map((activity) => [activity.id, activity]))

  const out: MemberActivityRow[] = []
  for (const row of rows) {
    const activity = byId.get(row.activity_id)
    // Absent means the activity is of another kind, which is the filter doing
    // its job — not a row to render with a placeholder title.
    if (!activity) continue
    out.push({
      id: row.activity_id,
      title: activity.title,
      date: activity.activity_date,
      // An unrecognised application_type is shown as itself rather than dropped
      // or renamed — the same reasoning as teamRoleChoice's `unknown` branch.
      note: APPLICATION_NOTE[row.application_type] ?? row.application_type,
    })
  }

  return out.sort((a, b) => b.date.localeCompare(a.date))
}

/**
 * One member's 활동 현황 for one kind.
 *
 * The three kinds read three different sources, and each carries its own
 * entitlement because the database gates them differently: races come out of
 * `records` (can_manage_records), applications out of `activity_applications`
 * (is_staff). A viewer may hold one and not the other — a 코치 who is not an
 * admin is exactly that person — so the answer is per-kind rather than one
 * blanket "운영진" check that would be wrong in both directions.
 */
export async function getMemberActivities(
  memberId: string,
  kind: MemberActivityKind,
): Promise<MemberActivityView> {
  if (kind === 'race') {
    const { allowed, events } = await getMemberRaceEvents(memberId)
    if (!allowed) return NOT_ALLOWED
    return {
      allowed: true,
      rows: events.map((event) => ({
        id: event.id,
        title: event.title,
        date: event.date,
        note: `${event.swimCount}개 종목`,
      })),
      caveat: null,
    }
  }

  const [mine, staff] = await Promise.all([
    supabase.rpc('current_member_id'),
    supabase.rpc('is_staff'),
  ])
  if (mine.error) throw mine.error
  if (staff.error) throw staff.error
  if (staff.data !== true && mine.data !== memberId) return NOT_ALLOWED

  return {
    allowed: true,
    rows: await getApplications(memberId, kind),
    caveat:
      kind === 'training'
        ? '출석 체크 결과는 본인만 조회할 수 있어, 이 화면에는 신청 내역만 표시됩니다.'
        : null,
  }
}

// ------------------------------------------------------------------ writes
// Never an update against members — the table has no write policy at all
// (0001:171-175), so a direct update matches zero rows rather than raising.
// Verified again for 0011: as an `admin`, `update members set team_role = …`
// reported UPDATE 0. Every RPC below checks the caller itself and raises 42501.

export async function setMemberStatus(input: {
  memberId: string
  status: 'approved' | 'rejected'
}): Promise<void> {
  const { error } = await supabase.rpc('set_member_status_v1', {
    p_member_id: input.memberId,
    p_status: input.status,
  })
  if (error) throw error
}

/**
 * Grant or revoke 부관리자.
 *
 * Master-admin only, and the function is where that holds: RequireMasterAdmin
 * decides what renders, set_member_role_v1() decides what happens. It also
 * refuses to touch a master admin's row, so there is no path here that leaves
 * the club without one.
 */
export async function setMemberRole(input: { memberId: string; role: Role }): Promise<void> {
  const { error } = await supabase.rpc('set_member_role_v1', {
    p_member_id: input.memberId,
    p_role: input.role,
  })
  if (error) throw error
}

/**
 * Set or clear a member's 팀 역할.
 *
 * The one that matters is '코치': can_manage_records() (0004:167) reads it to
 * decide who may upload 결과지, and until 0011 nothing in the schema could
 * write the column at all — so that branch had never once been true.
 *
 * `null` here means 지정 안 함, and it goes over the wire as '' because the
 * generated Args type declares p_team_role as a plain string — plpgsql has no
 * way to say "nullable text" in a signature. That is not a workaround: the
 * function runs nullif(btrim(...)) precisely so the two spellings of empty
 * arrive at the same NULL, and it never stores '' — a value that would read as
 * set everywhere and match nothing.
 */
export async function setMemberTeamRole(input: {
  memberId: string
  teamRole: AssignableTeamRole | null
}): Promise<void> {
  const { error } = await supabase.rpc('set_member_team_role_v1', {
    p_member_id: input.memberId,
    p_team_role: input.teamRole ?? '',
  })
  if (error) throw error
}

/**
 * 회원 내보내기, and its undo.
 *
 * Blocking is what actually ends somebody's access: current_member_id()
 * (0001:123-129) only answers for an approved row, so every RLS policy and
 * every RPC stops recognising them at once. It deletes nothing — the member,
 * their records and their attendance all stay — which is why the same call
 * with `blocked: false` puts them back exactly as they were.
 */
export async function setMemberBlocked(input: {
  memberId: string
  blocked: boolean
}): Promise<void> {
  const { error } = await supabase.rpc('set_member_blocked_v1', {
    p_member_id: input.memberId,
    p_blocked: input.blocked,
  })
  if (error) throw error
}

// ------------------------------------------------------------------ 회원 연결
// The screen behind /members/link. Two jobs that look like one: giving a roster
// member a way past the signup guard, and moving a new login onto the row that
// already holds their history.

/**
 * One roster row as the link screen sees it.
 *
 * The field list is decided by member_link_summary_v1 (0035) and deliberately
 * stops short of a dossier — no 생년월일, 메모, 가입 사유, 강습 or 수력. The
 * three counts are the weight of what a 연결 would move, and they are why this
 * type exists rather than reusing RosterMember: an admin about to do something
 * irreversible needs to see what is at stake on the same card as the button.
 */
export type MemberLinkSummary = {
  id: string
  nickname: string
  short_name: string | null
  real_name: string | null
  join_date_text: string | null
  birth_year: number | null
  gender: string | null
  status: MemberStatus
  /**
   * ISO timestamp, or null when no pass stands.
   *
   * A DATE rather than a boolean, and that is not a detail. 0037 does not
   * consume a pass on a successful signup — it stays live for its whole window
   * so an applicant whose first attempt failed is not stranded — so a row keeps
   * reading as 허용됨 until this moment passes. Rendering that as a bare
   * "가입 허용됨" would be true on the first day and a lie on the eighth.
   */
  signup_pass_expires_at: string | null
  attendance_count: number
  record_count: number
  application_count: number
}

/** A pending signup, with every roster row the guard's rule matches. */
export type MemberLinkSignup = {
  id: string
  nickname: string
  created_at: string
  /**
   * Plural on purpose. Two roster rows can share a name, birth year and gender
   * — that collision is the whole reason the nickname format carries 지역 — so
   * the screen offers the list and the admin picks. Taking [0] would be a guess
   * dressed as an answer, on the one operation that cannot be undone.
   */
  candidates: MemberLinkSummary[]
}

export type MemberLinkBoard = {
  signups: MemberLinkSignup[]
  /** Every roster row with no login, whether or not a signup matched it. */
  roster: MemberLinkSummary[]
}

/** What link_member_login_v1 hands back, so the screen can say what it moved. */
export type MemberLinkResult = { member: MemberLinkSummary | null }

// The RPCs return jsonb, which the generated types describe as `Json` — a union
// that says nothing about shape. Narrowing happens here, once, rather than as a
// cast at each render site. Every reader below tolerates a missing key instead
// of throwing: a board that failed to parse would leave an admin at an error
// screen where the honest answer is "this one row is incomplete".
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

// jsonb renders count(*) as a JSON number, but bigint over the wire has bitten
// enough projects that a string is worth tolerating. Anything unreadable
// collapses to 0 rather than rendering as "NaN회" on a card somebody is about
// to act on.
function asCount(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

function toSummary(value: unknown): MemberLinkSummary | null {
  const row = asRecord(value)
  const id = asText(row.id)
  if (!id) return null
  const birthYear = Number(row.birth_year)
  return {
    id,
    nickname: asText(row.nickname) ?? '이름 없는 회원',
    short_name: asText(row.short_name),
    real_name: asText(row.real_name),
    join_date_text: asText(row.join_date_text),
    birth_year: Number.isFinite(birthYear) ? birthYear : null,
    gender: asText(row.gender),
    status: toStatus(asText(row.status)),
    signup_pass_expires_at: asText(row.signup_pass_expires_at),
    attendance_count: asCount(row.attendance_count),
    record_count: asCount(row.record_count),
    application_count: asCount(row.application_count),
  }
}

function toSummaries(value: unknown): MemberLinkSummary[] {
  if (!Array.isArray(value)) return []
  const out: MemberLinkSummary[] = []
  for (const entry of value) {
    const summary = toSummary(entry)
    if (summary) out.push(summary)
  }
  return out
}

/**
 * Everything the link screen needs, in one round trip.
 *
 * Master-admin only, and member_link_board_v1 is where that holds — it raises
 * 42501 for anyone else, verified against the dev database. RequireMasterAdmin
 * on the route decides what renders; this call decides what exists.
 */
export async function getMemberLinkBoard(): Promise<MemberLinkBoard> {
  const { data, error } = await supabase.rpc('member_link_board_v1')
  if (error) throw error

  const board = asRecord(data)
  const signups = Array.isArray(board.signups) ? board.signups : []

  return {
    signups: signups.flatMap((entry) => {
      const row = asRecord(entry)
      const id = asText(row.id)
      if (!id) return []
      return [
        {
          id,
          nickname: asText(row.nickname) ?? '이름 없는 신청',
          created_at: asText(row.created_at) ?? '',
          candidates: toSummaries(row.candidates),
        },
      ]
    }),
    roster: toSummaries(board.roster),
  }
}

/**
 * Move a pending signup's login onto an existing member row.
 *
 * The most dangerous write in this app, and none of that safety lives here:
 * link_member_login_v1 (0035) checks the caller, refuses a target that already
 * has a login, refuses anything but a pending signup, and proves the discarded
 * row is empty by walking every foreign key that references members. This
 * function's only job is to carry the two ids and hand back the receipt.
 */
export async function linkMemberLogin(input: {
  signupMemberId: string
  targetMemberId: string
}): Promise<MemberLinkResult> {
  const { data, error } = await supabase.rpc('link_member_login_v1', {
    p_signup_member_id: input.signupMemberId,
    p_target_member_id: input.targetMemberId,
  })
  if (error) throw error
  return { member: toSummary(asRecord(data).member) }
}

/**
 * 가입 허용: let one applicant matching this roster row past the signup guard.
 *
 * It grants nothing else — not a login, not an approval. The pending row it
 * permits is worth what any other pending row is worth, which is nothing until
 * an admin decides about it. Withdrawing is the same call with `allowed: false`,
 * the shape set_member_blocked_v1 established.
 */
export async function setSignupPass(input: {
  memberId: string
  allowed: boolean
}): Promise<void> {
  const { error } = await supabase.rpc('set_signup_pass_v1', {
    p_member_id: input.memberId,
    p_allowed: input.allowed,
  })
  if (error) throw error
}
