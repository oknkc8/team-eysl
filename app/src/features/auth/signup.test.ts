import { describe, it, expect } from 'vitest'
import { validateSignup, signupErrorMessage, PASSWORD_MAX_BYTES } from './signup'

const ok = { nickname: '홍길동', password: 'swimclub2026' }

describe('validateSignup', () => {
  it('accepts what the president’s form accepts', () => {
    expect(validateSignup(ok)).toBeNull()
  })

  it('accepts a two-character nickname, the shortest his form allows', () => {
    expect(validateSignup({ ...ok, nickname: '민수' })).toBeNull()
  })

  it('refuses a one-character nickname', () => {
    expect(validateSignup({ ...ok, nickname: '수' })).toBe('닉네임은 2자 이상 입력해주세요.')
  })

  // Surrounding space is trimmed before the length is measured, because
  // emailForNickname() trims too — a nickname that passes here and fails there
  // would be a refusal with no visible cause.
  it('refuses a nickname that is only whitespace around one character', () => {
    expect(validateSignup({ ...ok, nickname: '  수  ' })).toBe('닉네임은 2자 이상 입력해주세요.')
  })

  it('refuses a nickname past 30 characters', () => {
    expect(validateSignup({ ...ok, nickname: '가'.repeat(31) })).toBe(
      '닉네임은 30자 이하로 입력해주세요.',
    )
  })

  it('refuses a password under 8 characters', () => {
    expect(validateSignup({ ...ok, password: 'swim123' })).toBe(
      '비밀번호는 8자 이상으로 설정해주세요.',
    )
  })

  it('accepts a password of exactly 8 characters', () => {
    expect(validateSignup({ ...ok, password: 'swim1234' })).toBeNull()
  })

  // The branch that only exists because the club types Korean. Twenty-four
  // Korean characters is 72 bytes — the bcrypt limit — and twenty-five is over
  // it while still reading as a perfectly short password.
  it('measures the password in bytes, not characters', () => {
    const twentyFour = '가'.repeat(24)
    expect(new TextEncoder().encode(twentyFour).length).toBe(PASSWORD_MAX_BYTES)
    expect(validateSignup({ ...ok, password: twentyFour })).toBeNull()

    expect(validateSignup({ ...ok, password: '가'.repeat(25) })).toBe(
      '비밀번호가 너무 깁니다. 조금 짧게 설정해주세요.',
    )
  })
})

describe('signupErrorMessage', () => {
  it('names the duplicate nickname rather than the address behind it', () => {
    expect(signupErrorMessage({ message: 'User already registered', status: 422 })).toBe(
      '이미 사용 중인 닉네임입니다. 다른 닉네임을 입력해주세요.',
    )
  })

  // What a nickname collision inside handle_new_auth_user() looks like by the
  // time GoTrue has flattened it.
  it('reads a database error as the collision it almost always is', () => {
    expect(signupErrorMessage({ message: 'Database error saving new user', status: 500 })).toBe(
      '이미 사용 중인 닉네임일 수 있습니다.',
    )
  })

  it('tells someone to wait when the project is rate limiting', () => {
    expect(signupErrorMessage({ message: 'email rate limit exceeded', status: 429 })).toBe(
      '요청이 너무 잦습니다. 잠시 후 다시 시도해주세요.',
    )
  })

  // The refusal nothing the applicant types can get past: this project's GoTrue
  // will not create an account at eysl.local. Sending them to the form again
  // would be a loop, so the sentence sends them to a person. The exact message
  // is the one the dev project answered with.
  it('points at a person when the address itself is refused', () => {
    expect(
      signupErrorMessage({ message: 'Email address "hong@eysl.local" is invalid', status: 400 }),
    ).toBe('지금은 가입 신청을 받을 수 없습니다. 클럽 관리자에게 문의해주세요.')
  })

  it('never returns an empty string or an English message', () => {
    for (const error of [{}, { message: '' }, { message: 'unexpected failure', status: 500 }]) {
      const result = signupErrorMessage(error)
      expect(result.length).toBeGreaterThan(0)
      expect(result).toMatch(/[가-힣]/)
    }
  })
})
