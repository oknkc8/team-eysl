// The signup rules, kept apart from api.ts so they can be tested without the
// Supabase client — the same split as schedule's kinds.ts against its api.ts.

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
 */
export function validateSignup(input: SignupInput): string | null {
  const nickname = input.nickname.trim()

  if (nickname.length < 2) return '닉네임은 2자 이상 입력해주세요.'
  if (nickname.length > NICKNAME_MAX) return `닉네임은 ${NICKNAME_MAX}자 이하로 입력해주세요.`
  if (input.password.length < PASSWORD_MIN)
    return `비밀번호는 ${PASSWORD_MIN}자 이상으로 설정해주세요.`
  if (byteLength(input.password) > PASSWORD_MAX_BYTES)
    return '비밀번호가 너무 깁니다. 조금 짧게 설정해주세요.'

  return null
}

/**
 * A Korean sentence for whatever Supabase Auth answered with.
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
  if (message.includes('already registered') || message.includes('already been registered'))
    return '이미 사용 중인 닉네임입니다. 다른 닉네임을 입력해주세요.'

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
