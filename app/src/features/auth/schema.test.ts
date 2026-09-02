import { describe, expect, it } from 'vitest'
import { canManageRecords, isStaff, type CurrentUser } from './schema'

// canManageRecords is the client half of can_manage_records() (0004:159-169),
// and the two must not drift: the database admits admin, master_admin, or a
// member whose team_role is 코치, and a screen that disagrees either hides a
// button that would have worked or shows one the server refuses.

function member(over: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    nickname: '철수/95/남/관악',
    real_name: null,
    avatar_path: null,
    role: 'member',
    status: 'approved',
    team_role: null,
    ...over,
  }
}

describe('canManageRecords', () => {
  it('admits admin and master_admin, exactly as isStaff does', () => {
    for (const role of ['admin', 'master_admin'] as const) {
      expect(canManageRecords(member({ role }))).toBe(true)
      expect(isStaff(member({ role }))).toBe(true)
    }
  })

  it('admits a 코치 who is only a member — the case isStaff refuses', () => {
    const coach = member({ role: 'member', team_role: '코치' })
    expect(canManageRecords(coach)).toBe(true)
    // The whole reason this predicate exists. If these two ever agree here,
    // the screens have silently narrowed back to staff.
    expect(isStaff(coach)).toBe(false)
  })

  it('refuses a plain member and any other 팀 역할', () => {
    expect(canManageRecords(member())).toBe(false)
    expect(canManageRecords(member({ team_role: '주장' }))).toBe(false)
    expect(canManageRecords(member({ team_role: '' }))).toBe(false)
  })

  it('refuses a signed-out caller rather than throwing', () => {
    expect(canManageRecords(null)).toBe(false)
    expect(canManageRecords(undefined)).toBe(false)
  })

  // 코치 is matched exactly, not by inclusion: a 팀 역할 that merely contains
  // the word must not inherit the permission.
  it('matches 코치 exactly and does not accept a containing string', () => {
    expect(canManageRecords(member({ team_role: '코치보조' }))).toBe(false)
    expect(canManageRecords(member({ team_role: '수석 코치' }))).toBe(false)
  })
})
