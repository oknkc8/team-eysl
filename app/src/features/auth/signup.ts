// The signup rules, kept apart from api.ts so they can be tested without the
// Supabase client — the same split as schedule's kinds.ts against its api.ts.

import { canonicalNickname, checkNicknameFormat } from './nickname'

/** What the president's form asks for, and all it asks for (upstream:1064-1068). */
export type SignupInput = { nickname: string; password: string }

export const NICKNAME_MAX = 30
export const PASSWORD_MIN = 8

/**
 * Why a byte length and not a character count.
 *
 * bcrypt silently truncates at 72 bytes, and a Korean character is three bytes
 * in UTF-8 — so 25 Korean characters is already past the limit while reading as
 * a short password. Rejecting it here is the difference between a clear sentence
 * now and a password whose tail quietly does not count. The legacy app checks
 * the same bound (upstream:1885-1888).
 */
export const PASSWORD_MAX_BYTES = 72

const byteLength = (value: string) => new TextEncoder().encode(value).length

/**
 * The refusal to show, or null when the form may be submitted.
 *
 * A sentence rather than a field name and a code, because this is the first
 * screen anyone outside the club ever sees.
 *
 * The order matches register_member_v1() (0032) exactly — length, then format,
 * then the password — so the screen and a direct RPC call answer the same
 * complaint about the same input. A screen that refused a different thing first
 * would have people fixing one problem and being handed another.
 */
export function validateSignup(input: SignupInput): string | null {
  // Trim AND normalise. A decomposed nickname renders identically to its
  // precomposed twin and would otherwise be judged here, sent, stored, and
  // compared against a precomposed roster — see nickname.ts's header.
  const nickname = canonicalNickname(input.nickname)

  if (nickname.length < 2) return '닉네임은 2자 이상 입력해주세요.'
  if (nickname.length > NICKNAME_MAX) return `닉네임은 ${NICKNAME_MAX}자 이하로 입력해주세요.`

  // 이름/출생년도/성별/지역. The rule is enforced in the RPC; this call is what
  // makes it a sentence naming the wrong part rather than a flat rejection.
  const badFormat = checkNicknameFormat(nickname)
  if (badFormat) return badFormat.message

  if (input.password.length < PASSWORD_MIN)
    return `비밀번호는 ${PASSWORD_MIN}자 이상으로 설정해주세요.`
  if (byteLength(input.password) > PASSWORD_MAX_BYTES)
    return '비밀번호가 너무 깁니다. 조금 짧게 설정해주세요.'

  return null
}

/** Why a signup was turned down, in a form the screen can show as-is. */
export type SignupRefusal = {
  /** Machine-readable: `already_registered`, `password_short`, `rate_limited`, … */
  reason: string
  /** The Korean sentence to display. Always non-empty. */
  message: string
  /** Only set for `rate_limited`. */
  retryAfterSeconds: number | null
}

/**
 * Read what register_member_v1 (0028) answered.
 *
 * Returns null when the account was created, and the refusal otherwise. The RPC
 * deliberately answers an expected refusal with a 200 and `ok:false` rather than
 * raising: a RAISE would abort the transaction PostgREST opened and roll back
 * the rate-limit counter along with it, so the refusals arrive here as data.
 *
 * The Korean sentence comes from the server rather than being re-derived here.
 * There is one rule about a refusal and it now lives in one place — the function
 * that made the decision — instead of being restated in a client that could
 * drift out of step with it.
 *
 * Throws on a shape this version does not understand. That is deliberately not
 * treated as a refusal: answering "거절되었습니다" to something we cannot read
 * would be asserting the account was not created, which we do not know.
 */
export function readSignupResult(value: unknown): SignupRefusal | null {
  if (typeof value !== 'object' || value === null)
    throw new Error('register_member_v1 returned something that is not an object')

  const row = value as Record<string, unknown>
  if (row.ok === true) return null
  if (row.ok !== false)
    throw new Error('register_member_v1 returned no usable `ok` field')

  return {
    reason: typeof row.reason === 'string' && row.reason !== '' ? row.reason : 'unknown',
    // A refusal with no sentence would render as an empty red line, which reads
    // as a broken screen rather than as an answer.
    message:
      typeof row.message === 'string' && row.message.trim() !== ''
        ? row.message
        : '가입 신청에 실패했습니다. 잠시 후 다시 시도해주세요.',
    retryAfterSeconds:
      typeof row.retry_after_seconds === 'number' ? row.retry_after_seconds : null,
  }
}

/**
 * A Korean sentence for whatever the signup call *threw*.
 *
 * Since 0028 the refusals a person can act on no longer come through here — they
 * arrive as data and readSignupResult() carries the server's own sentence. What
 * is left for this function is the transport: a dropped connection, a PostgREST
 * error, an answer nobody could parse. The GoTrue branches below are kept
 * because auth.signUp is still what a stale cached bundle would call, and an
 * English message reaching a member is worse than a branch that rarely fires.
 *
 * Never the raw message: GoTrue replies in English, and two of its replies are
 * about our own configuration rather than anything the applicant did wrong.
 * Reaching this function at all means the signup failed, so every branch has to
 * end in something a person can act on.
 */
export function signupErrorMessage(error: { message?: string; status?: number }): string {
  const message = (error.message ?? '').toLowerCase()

  // GoTrue's own duplicate check. The address is derived from the nickname, so
  // a duplicate address is a duplicate nickname.
  //
  // No longer says "다른 닉네임을 입력해주세요": since 0032 the nickname is
  // 이름/출생년도/성별/지역, so there is nothing for the applicant to change
  // except where they claim to live. Byte-identical to register_member_v1's own
  // sentence, which it shares with the roster-guard refusal — the server gives
  // one answer for "already registered" however it worked that out.
  if (message.includes('already registered') || message.includes('already been registered'))
    return '이미 등록된 회원 정보입니다. 새로 가입하지 마시고 관리자에게 문의해주세요.'

  // handle_new_auth_user() raising inside GoTrue's transaction — a nickname
  // collision our unique index caught. GoTrue flattens it to this one string,
  // so the specific reason cannot be recovered here; the likeliest cause is
  // what gets named.
  if (message.includes('database error')) return '이미 사용 중인 닉네임일 수 있습니다.'

  if (error.status === 429 || message.includes('rate limit'))
    return '요청이 너무 잦습니다. 잠시 후 다시 시도해주세요.'

  // The one that is ours, not theirs: this project's GoTrue refuses to create an
  // account at a domain it cannot deliver mail to, and emailForNickname() builds
  // an address at eysl.local. Nothing the applicant types will get past it, so
  // the sentence points them at a person instead of at the form.
  //
  // Checked before the generic password branch below, since this message names
  // the address rather than the password.
  if (message.includes('email') && message.includes('invalid'))
    return '지금은 가입 신청을 받을 수 없습니다. 클럽 관리자에게 문의해주세요.'

  if (message.includes('password')) return '비밀번호를 다시 확인해주세요.'

  return '가입 신청에 실패했습니다. 잠시 후 다시 시도해주세요.'
}
