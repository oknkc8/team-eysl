import { describe, it, expect } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { personalKey } from './queryKeys'

describe('personalKey', () => {
  it('separates two members', () => {
    expect(personalKey('my-records', 'user-a')).not.toEqual(personalKey('my-records', 'user-b'))
  })

  it('puts the name first and the member second', () => {
    expect(personalKey('my-records', 'user-a')).toEqual(['my-records', 'user-a'])
  })

  // A signed-out reader is its own entry, not one shared with whoever was last
  // signed in.
  it('gives a signed-out reader a key of their own', () => {
    expect(personalKey('my-records', undefined)).toEqual(['my-records', null])
    expect(personalKey('my-records', undefined)).not.toEqual(personalKey('my-records', 'user-a'))
  })

  it('keeps any further parts after the member', () => {
    expect(personalKey('my-monthly', 'user-a', 2026, 3)).toEqual(['my-monthly', 'user-a', 2026, 3])
  })
})

/*
 * The part that would break silently.
 *
 * AdminCheckInPage and the record screens invalidate with the bare name —
 * `['my-achievement']` — because a writer does not know whose cache it is
 * touching. react-query matches by prefix, so that only reaches a keyed entry
 * while the name stays the FIRST element. Putting the member id first would
 * compile, look tidier, and quietly stop every one of those invalidations
 * matching: no error, just a screen that never refreshes.
 *
 * Asserted against a real QueryClient rather than by reasoning about prefixes,
 * because the claim is about react-query's matching and not about array shape.
 */
describe('prefix invalidation still reaches a keyed entry', () => {
  it('invalidates one member’s entry through the bare name', async () => {
    const client = new QueryClient()
    const key = personalKey('my-records', 'user-a')

    client.setQueryData(key, 'cached')
    expect(client.getQueryState(key)?.isInvalidated).toBe(false)

    await client.invalidateQueries({ queryKey: ['my-records'] })
    expect(client.getQueryState(key)?.isInvalidated).toBe(true)
  })

  it('leaves a different name alone', async () => {
    const client = new QueryClient()
    const mine = personalKey('my-records', 'user-a')
    const other = personalKey('my-races', 'user-a')

    client.setQueryData(mine, 'cached')
    client.setQueryData(other, 'cached')

    await client.invalidateQueries({ queryKey: ['my-records'] })
    expect(client.getQueryState(mine)?.isInvalidated).toBe(true)
    expect(client.getQueryState(other)?.isInvalidated).toBe(false)
  })

  // Both members' entries go at once, which is what the write screens want: a
  // staffer correcting somebody's attendance has no way to name whose cache to
  // drop, so dropping all of them is the safe direction.
  it('reaches every member’s entry, not just the first', async () => {
    const client = new QueryClient()
    const a = personalKey('my-records', 'user-a')
    const b = personalKey('my-records', 'user-b')

    client.setQueryData(a, 'cached')
    client.setQueryData(b, 'cached')

    await client.invalidateQueries({ queryKey: ['my-records'] })
    expect(client.getQueryState(a)?.isInvalidated).toBe(true)
    expect(client.getQueryState(b)?.isInvalidated).toBe(true)
  })
})
