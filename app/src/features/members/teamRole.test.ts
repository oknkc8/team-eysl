import { describe, it, expect } from 'vitest'
import {
  ASSIGNABLE_TEAM_ROLES,
  grantsRecordUpload,
  isAssignableTeamRole,
  RECORD_MANAGER_TEAM_ROLE,
  teamRoleChoice,
} from './teamRole'

describe('isAssignableTeamRole', () => {
  it('accepts exactly what set_member_team_role_v1 accepts', () => {
    expect(ASSIGNABLE_TEAM_ROLES).toEqual(['코치', '부관리자'])
    expect(isAssignableTeamRole('코치')).toBe(true)
    expect(isAssignableTeamRole('부관리자')).toBe(true)
  })

  // The whole reason this is a list and not a text field. '코 치' saves without
  // complaint into a free-text column and then matches nothing in
  // can_manage_records(), so somebody loses 결과지 업로드 with no error anywhere.
  it('rejects the typo that silently removes upload access', () => {
    expect(isAssignableTeamRole('코 치')).toBe(false)
    expect(isAssignableTeamRole('코치코치')).toBe(false)
  })

  it('rejects a value the club may use but this app does not assign', () => {
    expect(isAssignableTeamRole('총무')).toBe(false)
  })

  it('rejects nothing-at-all rather than throwing on it', () => {
    expect(isAssignableTeamRole(null)).toBe(false)
    expect(isAssignableTeamRole(undefined)).toBe(false)
    expect(isAssignableTeamRole('')).toBe(false)
  })
})

describe('teamRoleChoice', () => {
  it('reads null, empty and whitespace all as 지정 안 함', () => {
    // The database agrees: set_member_team_role_v1 runs nullif(btrim(...)), so
    // a value of '   ' can never have been stored in the first place.
    expect(teamRoleChoice(null)).toEqual({ kind: 'none' })
    expect(teamRoleChoice('')).toEqual({ kind: 'none' })
    expect(teamRoleChoice('   ')).toEqual({ kind: 'none' })
  })

  it('selects an assignable value in the picker', () => {
    expect(teamRoleChoice('코치')).toEqual({ kind: 'assignable', value: '코치' })
    // Trimmed the way the function trims it, so a stored ' 코치' still shows as
    // selected rather than as somebody else's vocabulary.
    expect(teamRoleChoice(' 코치 ')).toEqual({ kind: 'assignable', value: '코치' })
  })

  // A value from the president's roster that this app never offers. Rendering
  // it as 지정 안 함 would tell a master admin the field is empty immediately
  // before they overwrite somebody's real label.
  it('keeps a value it does not recognise visible as itself', () => {
    expect(teamRoleChoice('총무')).toEqual({ kind: 'unknown', value: '총무' })
    expect(teamRoleChoice('코 치')).toEqual({ kind: 'unknown', value: '코 치' })
  })
})

describe('grantsRecordUpload', () => {
  // Mirrors can_manage_records() (0004:167):
  //   role in ('admin','master_admin') or team_role = '코치'
  it('lets staff upload regardless of team role', () => {
    expect(grantsRecordUpload({ role: 'admin', teamRole: null })).toBe(true)
    expect(grantsRecordUpload({ role: 'master_admin', teamRole: null })).toBe(true)
  })

  it('lets a plain member upload once they are 코치 — the branch that was dead', () => {
    expect(RECORD_MANAGER_TEAM_ROLE).toBe('코치')
    expect(grantsRecordUpload({ role: 'member', teamRole: '코치' })).toBe(true)
  })

  it('does not let the other assignable team role upload anything', () => {
    // '부관리자' as a team_role is a label only; the account role is what
    // can_manage_records() reads for staff.
    expect(grantsRecordUpload({ role: 'member', teamRole: '부관리자' })).toBe(false)
  })

  it('does not let a typo through', () => {
    expect(grantsRecordUpload({ role: 'member', teamRole: '코 치' })).toBe(false)
    expect(grantsRecordUpload({ role: 'member', teamRole: null })).toBe(false)
  })
})
