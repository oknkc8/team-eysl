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
  member_id: string
  nickname: string
  avatar_path: string | null
  status: AttendanceStatus | null
  late_fee_paid: boolean
  marked_at: string | null
}

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

// Takes no member id — the server derives it from the session.
export async function getMyHistory(): Promise<HistoryRow[]> {
  // Both bounds default to null server-side, so omitting them asks for the full
  // history — passing an explicit null is what the generated types reject.
  const { data, error } = await supabase.rpc('attendance_my_history_v1', {})
  if (error) throw error
  return (data ?? []) as HistoryRow[]
}
