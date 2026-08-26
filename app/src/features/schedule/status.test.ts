import { describe, it, expect } from 'vitest'
import { myStatusTag } from './status'
import type { MyApplication } from './api'

// `import type` above is erased at compile time, so this file never loads the
// Supabase client — the same reason kinds.ts and order.ts were split out of
// api.ts in the first place.

const HOUR = 60 * 60 * 1000

function application(over: Partial<MyApplication> = {}): MyApplication {
  return {
    id: 'app-1',
    activity_id: 'act-1',
    application_type: 'participant',
    wait_order: null,
    offer_status: 'none',
    offer_expires_at: null,
    ...over,
  }
}

describe('myStatusTag', () => {
  it('says nothing when the viewer has not applied', () => {
    expect(myStatusTag(null)).toBeNull()
  })

  it('calls a confirmed seat 참가확정', () => {
    expect(myStatusTag(application())).toEqual({ label: '참가확정', tone: 'ok' })
  })

  it('numbers a waitlist place', () => {
    expect(myStatusTag(application({ application_type: 'waitlist', wait_order: 3 }))).toEqual({
      label: '대기 3번째',
      tone: 'wait',
    })
  })

  // wait_order is nullable, and a waiting member with no number is still
  // waiting — printing 대기 null번째 would be worse than saying less.
  it('still says 대기 중 when the order is unknown', () => {
    expect(myStatusTag(application({ application_type: 'waitlist', wait_order: null }))).toEqual({
      label: '대기 중',
      tone: 'wait',
    })
  })

  // A live offer outranks the waitlist place it was made from: that row is
  // still application_type 'waitlist', and what the member has to see is that a
  // seat is being held for them right now.
  it('puts a live offer ahead of the waitlist place', () => {
    const tag = myStatusTag(
      application({
        application_type: 'waitlist',
        wait_order: 1,
        offer_status: 'offered',
        offer_expires_at: new Date(Date.now() + 2 * HOUR).toISOString(),
      }),
    )
    expect(tag).toEqual({ label: '자리 났어요', tone: 'offer' })
  })

  // And an offer whose clock has run out is not an offer. The row still reads
  // 'offered' until the server moves it on, so the expiry is what decides —
  // this is the case that would otherwise leave 자리 났어요 on screen forever.
  it('drops back to the waitlist once the offer has expired', () => {
    const tag = myStatusTag(
      application({
        application_type: 'waitlist',
        wait_order: 1,
        offer_status: 'offered',
        offer_expires_at: new Date(Date.now() - HOUR).toISOString(),
      }),
    )
    expect(tag).toEqual({ label: '대기 1번째', tone: 'wait' })
  })
})
