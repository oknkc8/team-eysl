import { supabase } from '../../lib/supabase'
import type { Role } from '../auth/schema'

// Avatars live in their own bucket, separate from team-files: an avatar is
// readable by every approved member, while a media file's object path also
// decides who may replace it.
const AVATAR_BUCKET = 'profile-images'

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

const ROSTER_COLUMNS = 'id, nickname, short_name, avatar_path, team_role, role'
const APPROVAL_COLUMNS =
  'id, nickname, real_name, join_date_text, join_reason, lesson_level, swim_experience, status, role, created_at'
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

// ------------------------------------------------------------------ writes
// Never an update against members — the table has no write policy at all
// (0001:171-175), so a direct update matches zero rows rather than raising.
// Both RPCs check the caller themselves and raise 42501 when they should.

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
