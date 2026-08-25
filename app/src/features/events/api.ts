import { supabase } from '../../lib/supabase'
import { parseRankings, type TeamEventRankings } from './rankings'

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
