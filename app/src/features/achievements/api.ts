import { supabase } from '../../lib/supabase'
import {
  parseAchievement,
  parseMonthlyActivity,
  type Achievement,
  type MonthlyActivity,
} from './achievements'

/**
 * 나의 성과. Takes no member id — 0034 derives the caller from the session and
 * refuses anyone who is not an approved member, the same shape as
 * race_my_history_v1 and attendance_my_history_v1.
 *
 * His client passes currentUser.memberId (upstream:2174); ours cannot, because
 * there is no parameter to pass it to. That is deliberate: a browser that can
 * name whose achievements it wants is a browser that can read everybody's.
 *
 * Both RPCs hand back a single jsonb object rather than a row set, so `data` is
 * the payload itself. It is narrowed rather than cast — see achievements.ts for
 * what that tolerates and what it refuses.
 */
export async function getMyAchievement(year?: number): Promise<Achievement> {
  // p_year defaults to the current Asia/Seoul year server-side. Omitting the key
  // is what asks for that default; an explicit null is what the generated types
  // reject, the same trap attendance_my_history_v1 documents.
  const { data, error } = await supabase.rpc(
    'my_achievement_v1',
    year === undefined ? {} : { p_year: year },
  )
  if (error) throw error
  return parseAchievement(data)
}

/** 월간 활동 요약 for one month. The server validates the range and raises in Korean. */
export async function getMyMonthlyActivity(year: number, month: number): Promise<MonthlyActivity> {
  const { data, error } = await supabase.rpc('my_monthly_activity_v1', {
    p_year: year,
    p_month: month,
  })
  if (error) throw error
  return parseMonthlyActivity(data)
}
