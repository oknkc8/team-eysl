import { supabase } from '../../lib/supabase'

export type AttendanceStatus = 'present' | 'late' | 'absent'

// Korean is a render-time concern; the database stores English tokens so a
// label change never rewrites data.
export const STATUS_LABEL: Record<AttendanceStatus, string> = {
  present: '출석',
  late: '지각',
  absent: '불참',
}

export type RosterRow = {
  /**
   * Null for somebody on the register who has no account (0051).
   *
   * Widened deliberately, and the widening is the point: it was `string` while
   * `attendance_for_activity_v1` could already return null, so every call site
   * that indexes by it was wrong and nothing said so. Making it nullable turns
   * three silent bugs — a duplicated React key, a row-state map collapsing
   * several people onto one entry, and `attendance_mark_v1` being handed null —
   * into compile errors that have to be answered.
   */
  member_id: string | null
  /** The member's nickname, or the written-down name of an unregistered person. */
  nickname: string
  avatar_path: string | null
  status: AttendanceStatus | null
  late_fee_paid: boolean
  marked_at: string | null
}

// Row identity lives in roster.ts, which imports nothing: this module loads the
// Supabase client at import time, so anything testable had to move out from
// under it. Same split as schedule/kinds.ts, and re-exported for the same
// reason — call sites keep a single import.
export { explainMarkNameFailure, isRegistered, rosterKey } from './roster'

export type HistoryRow = {
  activity_id: string
  activity_date: string
  title: string
  status: AttendanceStatus
  late_fee_paid: boolean
}

export type ActivityRow = {
  id: string
  title: string
  activity_date: string
  kind: string
  place: string | null
}

export async function listActivities(): Promise<ActivityRow[]> {
  const { data, error } = await supabase
    .from('activities')
    .select('id, title, activity_date, kind, place')
    .order('activity_date', { ascending: false })
    .limit(50)
  if (error) throw error
  return (data ?? []) as ActivityRow[]
}

export async function getRoster(activityId: string): Promise<RosterRow[]> {
  const { data, error } = await supabase.rpc('attendance_for_activity_v1', {
    p_activity_id: activityId,
  })
  if (error) throw error
  return (data ?? []) as RosterRow[]
}

// The whole point of slice 1: this write reaches the database. The legacy
// equivalent mutated an in-memory object and was lost on refresh.
export async function markAttendance(input: {
  activityId: string
  memberId: string
  status: AttendanceStatus
  lateFeePaid?: boolean
}) {
  const { error } = await supabase.rpc('attendance_mark_v1', {
    p_activity_id: input.activityId,
    p_member_id: input.memberId,
    p_status: input.status,
    p_late_fee_paid: input.lateFeePaid ?? false,
  })
  if (error) throw error
}

/**
 * Mark somebody who is on the register by name and has no account (0051).
 *
 * A separate function rather than a nullable `memberId` on the one above, for
 * the same reason the database has two entry points: the two write different
 * partial indexes and refuse different things. One call taking "either an id or
 * a name" would branch on which arrived, and a caller passing neither would get
 * whichever branch happened to be tested.
 */
export async function markNameAttendance(input: {
  activityId: string
  displayName: string
  status: AttendanceStatus
  lateFeePaid?: boolean
}) {
  const { error } = await supabase.rpc('attendance_mark_name_v1', {
    p_activity_id: input.activityId,
    p_display_name: input.displayName,
    p_status: input.status,
    p_late_fee_paid: input.lateFeePaid ?? false,
  })
  if (error) throw error
}

// `attendance_link_name_v1` (0051) attaches a name-only row to the member it
// turned out to be, merging when that member already has a row for the same
// activity. Its wrapper is deliberately NOT here yet: nothing calls it, and an
// exported function with no caller is a claim the next reader has to check.
// It arrives with the screen that uses it.

// Takes no member id — the server derives it from the session.
export async function getMyHistory(): Promise<HistoryRow[]> {
  // Both bounds default to null server-side, so omitting them asks for the full
  // history — passing an explicit null is what the generated types reject.
  const { data, error } = await supabase.rpc('attendance_my_history_v1', {})
  if (error) throw error
  return (data ?? []) as HistoryRow[]
}
