import { describe, expect, it } from 'vitest'

import { ACTIVITY_KINDS, KIND_LABEL, kindHasClock, toKind } from './kinds'

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
