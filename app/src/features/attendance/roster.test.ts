import { describe, expect, it } from 'vitest'

import { isRegistered, rosterKey, type RosterIdentity } from './roster'

const member = (id: string, nickname = '회원'): RosterIdentity => ({ member_id: id, nickname })
const named = (nickname: string): RosterIdentity => ({ member_id: null, nickname })

describe('rosterKey', () => {
  it('uses the member id when there is one', () => {
    expect(rosterKey(member('11111111-2222-3333-4444-555555555555'))).toBe(
      '11111111-2222-3333-4444-555555555555',
    )
  })

  // The defect this function exists to prevent. Before 0051 every roster row had
  // a member id; now several can share null, and keying on it would give React
  // one key for all of them and collapse their save states onto one entry.
  it('keeps two unregistered people apart', () => {
    expect(rosterKey(named('김철수'))).not.toBe(rosterKey(named('박영희')))
  })

  it('is stable for the same person', () => {
    expect(rosterKey(named('김철수'))).toBe(rosterKey(named('김철수')))
  })

  // The reason for the prefix rather than a bare `member_id ?? nickname`. A
  // written-down name is free text, so nothing stops somebody typing a uuid into
  // it — and without the prefix that name would collide with the member whose id
  // it happens to be, silently merging two people's attendance on one screen.
  it('cannot collide with a member id, even when the name is one', () => {
    const id = '11111111-2222-3333-4444-555555555555'
    expect(rosterKey(named(id))).not.toBe(rosterKey(member(id)))
    expect(rosterKey(named(id))).toBe(`name:${id}`)
  })

  // A name is unique per activity by attendance_one_row_per_name, and
  // attendance_mark_name_v1 refuses a blank one, so an empty name cannot reach
  // here from the database. Pinned anyway so the function stays total rather
  // than depending on a guarantee made two layers away.
  it('still returns something for an empty name', () => {
    expect(rosterKey(named(''))).toBe('name:')
  })
})

describe('isRegistered', () => {
  it('is true only when a member id is present', () => {
    expect(isRegistered(member('11111111-2222-3333-4444-555555555555'))).toBe(true)
    expect(isRegistered(named('김철수'))).toBe(false)
  })

  // The two functions have to agree about what "has an account" means, because
  // the screen picks the RPC with one and the React key with the other. A row
  // that isRegistered() calls true must key by its id, not by its name.
  it('agrees with rosterKey about which space a row is in', () => {
    const m = member('11111111-2222-3333-4444-555555555555')
    const n = named('김철수')
    expect(rosterKey(m).startsWith('name:')).toBe(!isRegistered(m))
    expect(rosterKey(n).startsWith('name:')).toBe(!isRegistered(n))
  })
})
