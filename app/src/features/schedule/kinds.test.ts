import { describe, expect, it } from 'vitest'

import {
  ACTIVITY_KINDS,
  clearsExistingTimes,
  KIND_LABEL,
  kindHasClock,
  timesForKind,
  toKind,
} from './kinds'

describe('kindHasClock', () => {
  it('gives 훈련 and 기타 a clock', () => {
    expect(kindHasClock('training')).toBe(true)
    expect(kindHasClock('event')).toBe(true)
  })

  // The whole point of the rule. A meet occupies a day and its real times are
  // per-event, in the entry — so activities.start_time/end_time say nothing
  // about it. Matches the president's final124.
  it('does not give 대회 a clock', () => {
    expect(kindHasClock('race')).toBe(false)
  })

  // Only one kind is special, and the implementation says `!== 'race'` rather
  // than listing the two that qualify. This test is what makes that choice
  // load-bearing: a fourth kind added to the CHECK at 0001:50 arrives WITH a
  // clock, which is the recoverable direction. Arriving without one would hide
  // two inputs on a screen nobody thought to look at.
  it('gives every kind except 대회 a clock', () => {
    const withClock = ACTIVITY_KINDS.filter(kindHasClock)
    expect(withClock).toEqual(ACTIVITY_KINDS.filter((k) => k !== 'race'))
    expect(withClock).not.toContain('race')
  })
})

describe('timesForKind', () => {
  it('keeps the typed times for a kind that has a clock', () => {
    expect(timesForKind('training', '19:00', '20:30')).toEqual({
      start_time: '19:00',
      end_time: '20:30',
    })
    expect(timesForKind('event', '10:00', '')).toEqual({ start_time: '10:00', end_time: null })
  })

  it('reads an empty box as null, not as an empty string', () => {
    // A `time` column refuses '', so this is not cosmetic — it is the difference
    // between "no end time" and a 400 from PostgREST.
    expect(timesForKind('training', '', '')).toEqual({ start_time: null, end_time: null })
  })

  // The half nobody sees, and the reason this function was pulled out of the
  // form. Hiding the inputs is visible on screen; sending null is visible only
  // in the row afterwards. A member fills in a training's times, switches the
  // kind to 대회, and saves — React still holds '19:00' in state.
  it('sends null for a race even when the form still holds times', () => {
    expect(timesForKind('race', '19:00', '20:30')).toEqual({
      start_time: null,
      end_time: null,
    })
  })

  // And the state is kept rather than cleared, so switching back restores what
  // the user typed. This asserts the pair: the same two inputs give times again
  // the moment the kind has a clock.
  it('gives the times back when the kind changes away from 대회', () => {
    expect(timesForKind('training', '19:00', '20:30').start_time).toBe('19:00')
  })
})

describe('clearsExistingTimes', () => {
  const withTimes = { start_time: '09:00:00', end_time: '17:00:00' }
  const withoutTimes = { start_time: null, end_time: null }

  // The finding this answers: a 대회 that already has times loses them when
  // somebody edits the title. The save still happens — 대회 having no clock is
  // the decision — but the screen has to say so first.
  it('is true for a race whose row still has times', () => {
    expect(clearsExistingTimes('race', withTimes)).toBe(true)
    expect(clearsExistingTimes('race', { start_time: '09:00:00', end_time: null })).toBe(true)
  })

  it('is false when there is nothing to lose', () => {
    expect(clearsExistingTimes('race', withoutTimes)).toBe(false)
    // Creating: no existing row at all.
    expect(clearsExistingTimes('race', undefined)).toBe(false)
  })

  // A kind that keeps its clock never warns, however the row looks — otherwise
  // every training edit would carry a notice about times it is about to keep.
  it('is false for any kind that has a clock', () => {
    expect(clearsExistingTimes('training', withTimes)).toBe(false)
    expect(clearsExistingTimes('event', withTimes)).toBe(false)
  })
})

describe('the labels this pairs with', () => {
  // Guards the caption that made 이벤트 ambiguous: the president reassigned that
  // word to a rankings hub and the third kind now reads 기타, while the stored
  // token stays 'event'. A test rather than a comment because the label is what
  // a reader compares against his app.
  it('reads 기타 for the event token, not 이벤트', () => {
    expect(KIND_LABEL.event).toBe('기타')
    expect(KIND_LABEL.race).toBe('대회')
    expect(KIND_LABEL.training).toBe('훈련')
  })
})

describe('toKind', () => {
  it('passes through the three real tokens', () => {
    expect(toKind('training')).toBe('training')
    expect(toKind('race')).toBe('race')
    expect(toKind('event')).toBe('event')
  })

  // The fallback leans to the least privileged reading on purpose: since 0015,
  // 'event' is the one kind a member may create and edit, so an unrecognised
  // value must not inherit those affordances.
  it('reads an unknown value as the staff-only kind', () => {
    expect(toKind('')).toBe('race')
    expect(toKind('EVENT')).toBe('race')
    expect(toKind('회식')).toBe('race')
  })

  // And the fallback must not accidentally hand back a kind with no clock for a
  // value that was meant to have one — this pins the interaction between the two
  // functions, which is the pair a screen actually uses.
  it('leaves an unknown value without a clock, matching its staff-only reading', () => {
    expect(kindHasClock(toKind('nonsense'))).toBe(false)
  })
})
