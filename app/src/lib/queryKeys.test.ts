import { describe, it, expect } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { viewerKey } from './queryKeys'

describe('viewerKey', () => {
  it('separates two viewers', () => {
    expect(viewerKey(['my-records'], 'user-a')).not.toEqual(viewerKey(['my-records'], 'user-b'))
  })

  it('appends the viewer after the prefix', () => {
    expect(viewerKey(['my-records'], 'user-a')).toEqual(['my-records', 'user-a'])
    expect(viewerKey(['schedule-entry', 'act-1'], 'user-a')).toEqual([
      'schedule-entry',
      'act-1',
      'user-a',
    ])
  })

  // A signed-out reader is its own entry, not one shared with whoever was last
  // signed in.
  it('gives a signed-out reader a key of their own', () => {
    expect(viewerKey(['my-records'], undefined)).toEqual(['my-records', null])
    expect(viewerKey(['my-records'], undefined)).not.toEqual(viewerKey(['my-records'], 'user-a'))
  })

  it('keeps a multi-part prefix intact', () => {
    expect(viewerKey(['my-monthly-activity', 2026, 3], 'user-a')).toEqual([
      'my-monthly-activity',
      2026,
      3,
      'user-a',
    ])
  })
})

/*
 * The half that would break silently.
 *
 * Writers invalidate without knowing whose cache they touch: AdminCheckInPage
 * sends `['my-achievement']`, ActivityDetailPage sends
 * `['schedule-entry', activityId]`. react-query matches by prefix, so that only
 * reaches a keyed entry while the viewer sits AFTER everything the prefix names.
 *
 * Asserted against a real QueryClient rather than by reasoning about arrays,
 * because the claim is about react-query's matching and not about key shape.
 */
describe('prefix invalidation still reaches every viewer', () => {
  it('drops both viewers’ copies through the bare name', async () => {
    const client = new QueryClient()
    const a = viewerKey(['my-records'], 'user-a')
    const b = viewerKey(['my-records'], 'user-b')
    client.setQueryData(a, 'cached')
    client.setQueryData(b, 'cached')

    await client.invalidateQueries({ queryKey: ['my-records'] })
    expect(client.getQueryState(a)?.isInvalidated).toBe(true)
    expect(client.getQueryState(b)?.isInvalidated).toBe(true)
  })

  /*
   * The case that decided the ordering.
   *
   * `['schedule-entry', activityId]` has to be per-viewer (it carries `mine`)
   * AND droppable for everyone when the activity changes. Those requirements
   * look incompatible and are not — provided the viewer goes after the activity
   * id. An earlier helper put the viewer second, which would have compiled and
   * quietly narrowed all five of ActivityDetailPage's invalidations to one
   * person: no error, just a stale seat count for everybody else.
   */
  it('drops every viewer’s copy of one activity, and leaves other activities alone', async () => {
    const client = new QueryClient()
    const mineA = viewerKey(['schedule-entry', 'act-1'], 'user-a')
    const mineB = viewerKey(['schedule-entry', 'act-1'], 'user-b')
    const other = viewerKey(['schedule-entry', 'act-2'], 'user-a')
    for (const key of [mineA, mineB, other]) client.setQueryData(key, 'cached')

    await client.invalidateQueries({ queryKey: ['schedule-entry', 'act-1'] })
    expect(client.getQueryState(mineA)?.isInvalidated).toBe(true)
    expect(client.getQueryState(mineB)?.isInvalidated).toBe(true)
    expect(client.getQueryState(other)?.isInvalidated).toBe(false)
  })

  it('leaves a different name alone', async () => {
    const client = new QueryClient()
    const mine = viewerKey(['my-records'], 'user-a')
    const other = viewerKey(['my-races'], 'user-a')
    client.setQueryData(mine, 'cached')
    client.setQueryData(other, 'cached')

    await client.invalidateQueries({ queryKey: ['my-records'] })
    expect(client.getQueryState(mine)?.isInvalidated).toBe(true)
    expect(client.getQueryState(other)?.isInvalidated).toBe(false)
  })

  // The month sits inside the prefix, so a writer naming only the feature still
  // reaches every month of every viewer.
  it('reaches every month through the bare feature name', async () => {
    const client = new QueryClient()
    const march = viewerKey(['my-monthly-activity', 2026, 3], 'user-a')
    const april = viewerKey(['my-monthly-activity', 2026, 4], 'user-b')
    client.setQueryData(march, 'cached')
    client.setQueryData(april, 'cached')

    await client.invalidateQueries({ queryKey: ['my-monthly-activity'] })
    expect(client.getQueryState(march)?.isInvalidated).toBe(true)
    expect(client.getQueryState(april)?.isInvalidated).toBe(true)
  })
})
