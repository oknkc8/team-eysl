import { supabase } from '../../lib/supabase'
import {
  parseRankings,
  parseStrokeRankings,
  type StrokeRankings,
  type TeamEventRankings,
} from './rankings'

/**
 * Takes no arguments — the server derives the caller from the session and
 * refuses anyone who is not an approved member, the same shape as
 * attendance_my_history_v1.
 *
 * The RPC hands back a single jsonb object rather than a row set, so `data` is
 * the payload itself. It is narrowed rather than cast: see rankings.ts for what
 * that tolerates and what it refuses.
 */
export async function getTeamEventRankings(): Promise<TeamEventRankings> {
  const { data, error } = await supabase.rpc('team_event_rankings_v1')
  if (error) throw error
  return parseRankings(data)
}

/**
 * 영법별 랭킹 (0041). A second RPC rather than a field on the first: his app
 * splits them the same way (`get_team_fun_event_rankings_v2` beside
 * `get_team_event_rankings`), and the two screens are reached separately, so
 * opening 출석왕 should not pay for a records scan it will not render.
 */
export async function getStrokeRankings(): Promise<StrokeRankings> {
  const { data, error } = await supabase.rpc('stroke_rankings_v1')
  if (error) throw error
  return parseStrokeRankings(data)
}
