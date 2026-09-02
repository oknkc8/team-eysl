import { describe, it, expect } from 'vitest'
import type { CurrentUser, Role } from '../auth/schema'
import { ACTIVITY_KINDS, KIND_LABEL, toKind } from './kinds'
import { canCreateKind, canEditActivity, creatableKinds, MEMBER_KIND } from './permissions'

const MEMBER_A = '22222222-2222-4222-8222-222222222222'
const MEMBER_B = '33333333-3333-4333-8333-333333333333'
const STAFF = '11111111-1111-4111-8111-111111111111'

function user(id: string, role: Role, status: CurrentUser['status'] = 'approved'): CurrentUser {
  return { id, nickname: '테스트', real_name: null, avatar_path: null, role, status, team_role: null }
}

const memberA = user(MEMBER_A, 'member')
const memberB = user(MEMBER_B, 'member')
const admin = user(STAFF, 'admin')
const master = user(STAFF, 'master_admin')

const eventOfA = { kind: 'event', created_by: MEMBER_A } as const
const eventOfB = { kind: 'event', created_by: MEMBER_B } as const
const trainingOfStaff = { kind: 'training', created_by: STAFF } as const

describe('KIND_LABEL', () => {
  // The president relabelled this kind and moved the word 이벤트 onto a rankings
  // hub. Labelling an activity 이벤트 now names a different feature of his app.
  it('renders the third kind as 기타, never 이벤트', () => {
    expect(KIND_LABEL.event).toBe('기타')
    expect(Object.values(KIND_LABEL)).not.toContain('이벤트')
  })

  // The rename is a caption. activities.kind still stores 'event' in live rows
  // and 0001's CHECK still names it, so the token must not drift with the label.
  it('leaves the stored tokens alone', () => {
    expect(ACTIVITY_KINDS).toEqual(['training', 'race', 'event'])
    expect(MEMBER_KIND).toBe('event')
  })

  it('labels the two staff kinds unchanged', () => {
    expect(KIND_LABEL.training).toBe('훈련')
    expect(KIND_LABEL.race).toBe('대회')
  })
})

describe('toKind', () => {
  it('passes through every kind the CHECK constraint allows', () => {
    expect(toKind('training')).toBe('training')
    expect(toKind('race')).toBe('race')
    expect(toKind('event')).toBe('event')
  })

  // Unreachable while the CHECK holds, and the direction still matters: 'event'
  // is the one kind a member may create and edit, so a value this client does
  // not understand must not inherit those affordances.
  it('reads an unrecognised kind as staff-only rather than as 기타', () => {
    expect(toKind('workshop')).toBe('race')
    expect(toKind('')).toBe('race')
    expect(toKind('EVENT')).toBe('race')
  })
})

describe('creatableKinds', () => {
  it('offers staff all three kinds', () => {
    expect(creatableKinds(admin)).toEqual(['training', 'race', 'event'])
    expect(creatableKinds(master)).toEqual(['training', 'race', 'event'])
  })

  it('offers a member 기타 and nothing else', () => {
    expect(creatableKinds(memberA)).toEqual(['event'])
  })

  it('offers nothing to a signed-out or still-loading viewer', () => {
    expect(creatableKinds(null)).toEqual([])
    expect(creatableKinds(undefined)).toEqual([])
  })

  // current_member_id() answers null for anything but 'approved', so every
  // policy in 0015 refuses these three. Offering a form that cannot save is the
  // failure mode this mirror exists to avoid.
  it('offers nothing to a member who is not approved', () => {
    expect(creatableKinds(user(MEMBER_A, 'member', 'pending'))).toEqual([])
    expect(creatableKinds(user(MEMBER_A, 'member', 'blocked'))).toEqual([])
    expect(creatableKinds(user(MEMBER_A, 'member', 'rejected'))).toEqual([])
  })

  // isStaff() reads the role alone, so a blocked admin passes it. The database
  // stopped answering for them the moment their status changed.
  it('offers nothing to a blocked admin, despite the role', () => {
    expect(creatableKinds(user(STAFF, 'admin', 'blocked'))).toEqual([])
    expect(creatableKinds(user(STAFF, 'master_admin', 'blocked'))).toEqual([])
  })
})

describe('canCreateKind', () => {
  it('lets staff file any kind', () => {
    expect(canCreateKind(admin, 'training')).toBe(true)
    expect(canCreateKind(admin, 'race')).toBe(true)
    expect(canCreateKind(admin, 'event')).toBe(true)
  })

  // activities_member_event_insert accepts kind = 'event' and nothing else; a
  // 훈련 or 대회 sent by a member comes back 42501, verified against the dev
  // database.
  it('lets a member file 기타 only', () => {
    expect(canCreateKind(memberA, 'event')).toBe(true)
    expect(canCreateKind(memberA, 'training')).toBe(false)
    expect(canCreateKind(memberA, 'race')).toBe(false)
  })

  it('lets nobody file anything without an approved member row', () => {
    for (const kind of ACTIVITY_KINDS) {
      expect(canCreateKind(null, kind)).toBe(false)
      expect(canCreateKind(user(MEMBER_A, 'member', 'pending'), kind)).toBe(false)
    }
  })
})

describe('canEditActivity', () => {
  it('lets staff change anything, including a member 기타', () => {
    expect(canEditActivity(admin, trainingOfStaff)).toBe(true)
    expect(canEditActivity(admin, eventOfA)).toBe(true)
    expect(canEditActivity(master, eventOfB)).toBe(true)
  })

  it('lets the creator change their own 기타', () => {
    expect(canEditActivity(memberA, eventOfA)).toBe(true)
    expect(canEditActivity(memberB, eventOfB)).toBe(true)
  })

  // The whole point of created_by being derived server-side. With a
  // client-supplied column, filing an activity in somebody else's name was one
  // request away from editing it as its owner.
  it('does not let one member change another member 기타', () => {
    expect(canEditActivity(memberA, eventOfB)).toBe(false)
    expect(canEditActivity(memberB, eventOfA)).toBe(false)
  })

  it('does not let a member change a 훈련 or 대회', () => {
    expect(canEditActivity(memberA, trainingOfStaff)).toBe(false)
    expect(canEditActivity(memberA, { kind: 'race', created_by: STAFF })).toBe(false)
  })

  // The case that makes the USING clause test kind as well as ownership: a
  // member who created a 훈련 while they were staff still owns the row after
  // being demoted, and must not keep editing it. Live check: UPDATE 0.
  it('does not let a demoted member keep editing a 훈련 they created', () => {
    expect(canEditActivity(memberA, { kind: 'training', created_by: MEMBER_A })).toBe(false)
    expect(canEditActivity(memberA, { kind: 'race', created_by: MEMBER_A })).toBe(false)
  })

  // A row filed before anyone was attributed belongs to staff, not to whoever
  // opens it. `null === user.id` is false, and this pins that down.
  it('treats an unowned 기타 as staff-only', () => {
    expect(canEditActivity(memberA, { kind: 'event', created_by: null })).toBe(false)
    expect(canEditActivity(admin, { kind: 'event', created_by: null })).toBe(true)
  })

  it('refuses a signed-out, pending or blocked viewer outright', () => {
    expect(canEditActivity(null, eventOfA)).toBe(false)
    expect(canEditActivity(undefined, eventOfA)).toBe(false)
    expect(canEditActivity(user(MEMBER_A, 'member', 'pending'), eventOfA)).toBe(false)
    expect(canEditActivity(user(MEMBER_A, 'member', 'blocked'), eventOfA)).toBe(false)
    expect(canEditActivity(user(STAFF, 'admin', 'blocked'), trainingOfStaff)).toBe(false)
  })
})
