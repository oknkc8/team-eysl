/**
 * Identity for a register row, member or not.
 *
 * Its own module for the reason kinds.ts gives: api.ts loads the Supabase client
 * at import time, so anything a test needs to reach has to live out from under
 * it. Re-exported from api.ts so call sites keep a single import.
 */

/** The two fields identity is derived from. Narrow so a test can build one. */
export type RosterIdentity = {
  member_id: string | null
  nickname: string
}

/**
 * A stable key for one row of the check-in roster.
 *
 * `member_id` stopped being unique across the roster in 0051: every person on
 * the register without an account has null there. Keying on it directly would
 * hand React the same key to every one of them, and would collapse them onto a
 * single entry in the save-state map — one person's spinner painting on
 * another's row.
 *
 * The `name:` prefix separates the two spaces permanently. A uuid cannot begin
 * with it, so no member key can ever equal a name key however the name is
 * spelled — including a name that is itself a uuid, which is the case a bare
 * `member_id ?? nickname` would get wrong.
 *
 * Within one activity this is as stable as the uuid it stands in for, because
 * `attendance_one_row_per_name` makes the name unique there. Across activities
 * it is not unique and does not need to be: the roster is always one activity's.
 */
export function rosterKey(row: RosterIdentity): string {
  return row.member_id ?? `name:${row.nickname}`
}

/**
 * Whether this row belongs to somebody with an account.
 *
 * A named predicate rather than `row.member_id === null` at each site, because
 * the screen asks this question more than once — for the badge and for which
 * RPC to call — and each of those reads better as a question than as a null
 * check.
 */
export function isRegistered(row: RosterIdentity): boolean {
  return row.member_id !== null
}
