import { describe, it, expect } from 'vitest'
import {
  validateSignup,
  signupErrorMessage,
  readSignupResult,
  PASSWORD_MAX_BYTES,
} from './signup'

// 홍길동 until 0032, which is the change in one line: a nickname is now
// 이름/출생년도/성별/지역. The length and password rules below are unchanged and
// are still what this file is about — the shape has its own file,
// nickname.test.ts, including the proof that 영희 and 철수 still work everywhere
// they already appear.
const ok = { nickname: '홍길동/98/남/관악', password: 'swimclub2026' }

describe('validateSignup', () => {
  it('accepts what the president’s form accepts', () => {
    expect(validateSignup(ok)).toBeNull()
  })

  // Was '민수' — two characters, the shortest his form allowed. The format makes
  // nine the real floor (`가/98/남/가`), so that is what the shortest acceptable
  // nickname looks like now. The 2-character rule below still exists and still
  // fires first; it is simply no longer reachable on its own.
  it('accepts the shortest nickname the format allows', () => {
    expect(validateSignup({ ...ok, nickname: '가/98/남/가' })).toBeNull()
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

// The payloads below are the ones register_member_v1 (0028) actually returned,
// copied from a live drive against the dev project rather than invented — a
// parser tested against a made-up shape proves nothing about the server.
describe('readSignupResult', () => {
  it('reads a created account as no refusal', () => {
    expect(readSignupResult({ ok: true })).toBeNull()
  })

  // `already_registered` covers both server arms since 0032 — a match against
  // the club roster, and a real unique violation. They answer identically on
  // purpose: an anonymous caller who could tell them apart could ask which
  // people are club members.
  it('carries the server’s own sentence for an already-registered member', () => {
    expect(
      readSignupResult({
        ok: false,
        reason: 'already_registered',
        message: '이미 등록된 회원 정보입니다. 새로 가입하지 마시고 관리자에게 문의해주세요.',
      }),
    ).toEqual({
      reason: 'already_registered',
      message: '이미 등록된 회원 정보입니다. 새로 가입하지 마시고 관리자에게 문의해주세요.',
      retryAfterSeconds: null,
    })
  })

  it('keeps retry_after_seconds when the caller is rate limited', () => {
    expect(
      readSignupResult({
        ok: false,
        reason: 'rate_limited',
        message: '가입 신청이 너무 많습니다. 60분 후에 다시 시도해주세요.',
        retry_after_seconds: 3600,
      }),
    ).toMatchObject({ reason: 'rate_limited', retryAfterSeconds: 3600 })
  })

  // A refusal with no sentence would paint an empty red line, which reads as a
  // broken screen rather than as an answer.
  it('substitutes a sentence when a refusal arrives without one', () => {
    const result = readSignupResult({ ok: false, reason: 'password_short' })
    expect(result?.message).toBe('가입 신청에 실패했습니다. 잠시 후 다시 시도해주세요.')
    expect(result?.reason).toBe('password_short')
  })

  // Deliberately a throw and not a refusal. "거절되었습니다" would assert the
  // account was not created, and an answer we cannot read does not tell us that.
  it('throws rather than inventing a refusal it cannot read', () => {
    for (const answer of [null, undefined, 'ok', 42, {}, { ok: 'true' }, []]) {
      expect(() => readSignupResult(answer)).toThrow()
    }
  })
})

describe('signupErrorMessage', () => {
  // Since 0032 this no longer tells them to pick another nickname: the format
  // leaves nothing to pick. It sends them to an admin, like the server does.
  it('names the duplicate nickname rather than the address behind it', () => {
    expect(signupErrorMessage({ message: 'User already registered', status: 422 })).toBe(
      '이미 등록된 회원 정보입니다. 새로 가입하지 마시고 관리자에게 문의해주세요.',
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
