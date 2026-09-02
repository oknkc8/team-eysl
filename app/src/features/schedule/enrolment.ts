/**
 * What a staffer reads when 명단 추가 refuses.
 *
 * Branched on the SQLSTATE rather than the message. 0042 raises three different
 * refusals and their messages are English, because they belong to the database
 * and are read by whoever is looking at a log. What belongs on the screen is
 * Korean, and it belongs here — mapping one to the other by matching message
 * text would break the moment somebody rewords a `raise exception`, silently,
 * into the generic case.
 *
 * The two codes are the ones 0042 actually raises:
 *   42501 insufficient_privilege — not staff, or the member can sign in and so
 *         applies for themselves, or the member is not approved
 *   22023 invalid_parameter_value — the activity is full, or the member is on
 *         the waitlist already
 *
 * They are collapsed into one sentence each rather than six. A staffer pressing
 * 추가 can act on "정원이 찼다"; distinguishing "this member is on the waitlist"
 * from "there is no seat" tells them nothing they would do differently, and the
 * list they pressed from already shows who is on the activity.
 */
export function explainEnrolFailure(error: unknown): string {
  const code = readCode(error)
  if (code === '22023') return '정원이 찼습니다. 정원을 늘린 뒤 다시 시도해 주세요.'
  if (code === '42501') return '권한이 없거나, 직접 신청할 수 있는 회원입니다.'
  return '처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'
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
