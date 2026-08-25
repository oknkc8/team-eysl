import { describe, expect, it } from 'vitest'
import {
  activityPayload,
  buildPayload,
  formatActivityDate,
  formatDeadline,
  formatStartTime,
  noticePayload,
  offerPayload,
  selfTestPayload,
} from './payload'

/**
 * Runs under the app's vitest suite rather than under Deno, because payload.ts
 * imports nothing — it is the part of the Edge Function that needs no runtime.
 * The rest of the function (send.ts, index.ts) is Deno, and is exercised against
 * a live push service and a live database instead.
 */

describe('formatActivityDate', () => {
  it('reads a date column as the day it names', () => {
    expect(formatActivityDate('2026-09-01')).toBe('9월 1일(화)')
  })

  // The bug this guards is silent and off by one day. activity_date is a
  // calendar day with no instant behind it; handing it to Date() invents UTC
  // midnight, which formats as the day before anywhere west of Greenwich.
  it('does not slip a day when the runtime clock is not UTC', () => {
    const original = process.env.TZ
    process.env.TZ = 'America/Los_Angeles'
    try {
      expect(formatActivityDate('2026-01-01')).toBe('1월 1일(목)')
    } finally {
      process.env.TZ = original
    }
  })

  it('leaves a value it does not recognise alone rather than inventing one', () => {
    expect(formatActivityDate('언젠가')).toBe('언젠가')
  })
})

describe('formatStartTime', () => {
  it('drops the seconds a time column carries', () => {
    expect(formatStartTime('18:30:00')).toBe('18:30')
  })

  it('is empty for an activity with no start time', () => {
    expect(formatStartTime(null)).toBe('')
  })
})

describe('formatDeadline', () => {
  // The club is in Korea and this runs on a UTC server. Nine hours early on a
  // twelve-hour offer is most of the offer.
  it('states the deadline in Seoul time rather than the server clock', () => {
    expect(formatDeadline('2026-09-01T09:00:00+00:00')).toBe('9월 1일 18:00')
  })

  it('crosses midnight into the next Korean day correctly', () => {
    expect(formatDeadline('2026-09-01T16:30:00+00:00')).toBe('9월 2일 01:30')
  })

  it('is empty rather than "Invalid Date" when the timestamp is unusable', () => {
    expect(formatDeadline('nonsense')).toBe('')
  })
})

describe('noticePayload', () => {
  it('carries the notice title and links to the notice', () => {
    const payload = noticePayload({ notice_id: 'n-1', title: '9월 훈련 일정 안내' })
    expect(payload.title).toBe('TEAM EYSL 새 공지')
    expect(payload.body).toBe('9월 훈련 일정 안내')
    expect(payload.url).toBe('/notices/n-1')
    // Keyed to the row so a resend replaces rather than stacks.
    expect(payload.tag).toBe('notice-n-1')
  })
})

describe('activityPayload', () => {
  it('names the kind in Korean and links to the activity', () => {
    const payload = activityPayload({
      activity_id: 'a-1',
      kind: 'race',
      title: '전국동호인수영대회',
      activity_date: '2026-09-01',
      start_time: '09:00:00',
    })
    expect(payload.title).toBe('TEAM EYSL 새 대회')
    expect(payload.body).toBe('9월 1일(화) 09:00 · 전국동호인수영대회')
    expect(payload.url).toBe('/schedule/a-1')
  })

  it('omits the time rather than printing an empty one', () => {
    const payload = activityPayload({
      activity_id: 'a-2',
      kind: 'event',
      title: '단합회',
      activity_date: '2026-09-05',
      start_time: null,
    })
    expect(payload.body).toBe('9월 5일(토) · 단합회')
    // 'event' reads 기타, matching the president's relabelling.
    expect(payload.title).toBe('TEAM EYSL 새 기타')
  })

  it('falls back to a neutral word for a kind it does not know', () => {
    const payload = activityPayload({
      activity_id: 'a-3',
      kind: 'something_new',
      title: '무언가',
      activity_date: '2026-09-05',
      start_time: null,
    })
    expect(payload.title).toBe('TEAM EYSL 새 일정')
  })
})

describe('offerPayload', () => {
  const fact = {
    activity_id: 'a-9',
    kind: 'training',
    title: '자유형 강화 훈련',
    activity_date: '2026-09-01',
    offer_expires_at: '2026-09-01T09:00:00+00:00',
  }

  // The deadline is the whole point of this notification. An offer that lapses
  // costs the member the seat, so it has to be on the lock screen.
  it('puts the deadline in the body', () => {
    expect(offerPayload(fact).body).toContain('9월 1일 18:00까지')
  })

  // Lands on the activity, where the 수락 button is (ActivityDetailPage), not on
  // the home screen — waking someone and then hiding the button loses the seat
  // just as thoroughly as not waking them.
  it('lands on the activity where the offer can be accepted', () => {
    expect(offerPayload(fact).url).toBe('/schedule/a-9')
  })

  it('does not repeat the kind when the title already contains it', () => {
    const payload = offerPayload(fact)
    expect(payload.title).toBe('TEAM EYSL 훈련 대기 자리가 났어요')
    expect(payload.body).toBe('9월 1일(화) 자유형 강화 훈련 · 9월 1일 18:00까지 수락해주세요.')
  })

  // A missing deadline must not become "까지 수락해주세요" with a hole in it.
  it('still urges acceptance when the deadline cannot be read', () => {
    const payload = offerPayload({ ...fact, offer_expires_at: '' })
    expect(payload.body).toContain('서둘러 수락해주세요.')
    expect(payload.body).not.toContain('까지 수락')
  })
})

describe('selfTestPayload', () => {
  it('uses a constant tag so repeated presses do not pile up', () => {
    expect(selfTestPayload().tag).toBe('push-test')
    expect(selfTestPayload().url).toBe('/settings/notifications')
  })
})

describe('buildPayload', () => {
  it('dispatches on the event name', () => {
    expect(buildPayload('notice_created', { notice_id: 'n', title: 't' }).url).toBe('/notices/n')
    expect(buildPayload('self_test', {}).title).toBe('TEAM EYSL 알림 테스트')
  })

  // Whatever the event, src/sw.js reads all six of these off event.data.json().
  // A payload missing one shows the worker's fallback text instead.
  it('always produces every field the service worker reads', () => {
    const payload = buildPayload('waitlist_offered', {
      activity_id: 'a',
      kind: 'training',
      title: 't',
      activity_date: '2026-09-01',
      offer_expires_at: '2026-09-01T09:00:00+00:00',
    })
    expect(Object.keys(payload).sort()).toEqual(['badge', 'body', 'icon', 'tag', 'title', 'url'])
    for (const value of Object.values(payload)) expect(value).not.toBe('')
  })
})
