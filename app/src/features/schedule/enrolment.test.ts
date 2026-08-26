import { describe, expect, it } from 'vitest'
import { explainEnrolFailure } from './enrolment'

const FULL = '정원이 찼습니다. 정원을 늘린 뒤 다시 시도해 주세요.'
const REFUSED = '권한이 없거나, 직접 신청할 수 있는 회원입니다.'
const GENERIC = '처리하지 못했습니다. 잠시 후 다시 시도해 주세요.'

describe('explainEnrolFailure', () => {
  it('names the capacity refusal, which is the one a staffer can act on', () => {
    expect(explainEnrolFailure({ code: '22023', message: 'no free seat' })).toBe(FULL)
  })

  it('gives one sentence for every 42501, whichever of the three it was', () => {
    // 0042 raises 42501 for three different reasons and this deliberately does
    // not distinguish them: none of the three changes what the staffer does.
    expect(explainEnrolFailure({ code: '42501', message: 'staff only' })).toBe(REFUSED)
    expect(explainEnrolFailure({ code: '42501', message: 'that member can sign in' })).toBe(REFUSED)
    expect(explainEnrolFailure({ code: '42501', message: 'member is not approved' })).toBe(REFUSED)
  })

  it('falls back rather than guessing at a code it does not know', () => {
    expect(explainEnrolFailure({ code: '23503', message: 'no such activity' })).toBe(GENERIC)
    expect(explainEnrolFailure({ code: '', message: '' })).toBe(GENERIC)
  })

  // The point of readCode. A mutation's onError receives whatever was thrown,
  // and a network failure is a TypeError with no code at all — the branch has
  // to survive that rather than throwing a second error on top of the first.
  it('survives a thrown value that is not a PostgrestError', () => {
    expect(explainEnrolFailure(new TypeError('Failed to fetch'))).toBe(GENERIC)
    expect(explainEnrolFailure(null)).toBe(GENERIC)
    expect(explainEnrolFailure(undefined)).toBe(GENERIC)
    expect(explainEnrolFailure('22023')).toBe(GENERIC)
    expect(explainEnrolFailure(22023)).toBe(GENERIC)
  })

  // A numeric code is the interesting one: SQLSTATEs look like numbers and
  // '22023' == 22023 loosely, so a `code == '22023'` comparison would pass here
  // and a strict one must not.
  it('does not accept a numeric code that merely looks like a SQLSTATE', () => {
    expect(explainEnrolFailure({ code: 22023 })).toBe(GENERIC)
  })
})
