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

/**
 * Turn a failed name-only check-in into a sentence the admin can act on.
 *
 * The same shape as schedule/enrolment.ts's explainEnrolFailure, and for the
 * same reason: `attendance_mark_name_v1` raises three different things and one
 * message for all of them tells the reader to fix the wrong problem. A
 * permission failure shown as "이미 가입한 회원의 이름입니다" sends somebody off
 * to rename a person when the actual answer is that they are not staff.
 */
export function explainMarkNameFailure(error: unknown): string {
  const code = readCode(error)
  // 23505 — the name belongs to a member. They have to be marked by id, or the
  // two rows never merge and only one of them counts toward anything.
  if (code === '23505') return '이미 가입한 회원의 이름입니다. 위 명단에서 체크해 주세요.'
  // 22023 — blank after trimming. The button already refuses this, so reaching
  // it means the value arrived some other way.
  if (code === '22023') return '이름을 입력해 주세요.'
  if (code === '42501') return '출석을 기록할 권한이 없습니다.'
  return '저장하지 못했습니다. 잠시 후 다시 시도해 주세요.'
}

/**
 * PostgrestError carries the SQLSTATE on `code`. Read defensively because this
 * runs in a mutation's onError, which receives whatever was thrown: a network
 * failure arrives as a TypeError with no code at all, and a caller that threw a
 * string arrives as a string. Neither must become an unhandled read.
 */
function readCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}
