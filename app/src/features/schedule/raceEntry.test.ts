import { describe, expect, it } from 'vitest'
import {
  EMPTY_ENTRY,
  NO_SECOND_EVENT,
  normaliseEntry,
  parseEntry,
  relayOptions,
  summarise,
  toggleRelay,
  type RaceEntry,
} from './raceEntry'

const OFFERED = ['계영 200m', '혼계영 200m', '혼성계영 200m']

describe('relayOptions', () => {
  it('reads the list a race offers', () => {
    expect(relayOptions({ relays: OFFERED })).toEqual(OFFERED)
  })

  // `details` is jsonb somebody seeds by hand -- his app has no UI that writes
  // it -- so every one of these is a shape a real row could actually have.
  it('yields nothing rather than throwing on a shape it cannot use', () => {
    expect(relayOptions(null)).toEqual([])
    expect(relayOptions(undefined)).toEqual([])
    expect(relayOptions({})).toEqual([])
    expect(relayOptions({ relays: '계영 200m' })).toEqual([])
    expect(relayOptions({ relays: 42 })).toEqual([])
    expect(relayOptions('relays')).toEqual([])
  })

  it('drops entries that are not usable names', () => {
    expect(relayOptions({ relays: ['계영 200m', '', '   ', 7, null, '혼계영 200m'] })).toEqual([
      '계영 200m',
      '혼계영 200m',
    ])
  })
})

describe('parseEntry', () => {
  it('is null when nothing has been entered, which is what picks the button label', () => {
    expect(parseEntry(null)).toBeNull()
    expect(parseEntry({})).toBeNull()
    // A row carrying unrelated keys has still not been entered.
    expect(parseEntry({ source: 'import' })).toBeNull()
  })

  it('reads a full entry back', () => {
    expect(
      parseEntry({
        group: '여자 일반부',
        s1: '배영 50m',
        s2: '자유형 50m',
        relays: ['계영 200m'],
        noRelay: false,
      }),
    ).toEqual({
      group: '여자 일반부',
      s1: '배영 50m',
      s2: '자유형 50m',
      relays: ['계영 200m'],
      noRelay: false,
    })
  })

  it('fills the gaps in a partial row instead of rendering blanks', () => {
    const parsed = parseEntry({ s1: '평영 50m' })
    expect(parsed).toEqual({
      group: EMPTY_ENTRY.group,
      s1: '평영 50m',
      s2: NO_SECOND_EVENT,
      relays: [],
      noRelay: false,
    })
  })

  it('treats only a real true as declining relays', () => {
    expect(parseEntry({ noRelay: true })?.noRelay).toBe(true)
    // A string is not a boolean, and 'false' is famously truthy.
    expect(parseEntry({ noRelay: 'false' })?.noRelay).toBe(false)
    expect(parseEntry({ noRelay: 1 })?.noRelay).toBe(false)
  })
})

describe('normaliseEntry', () => {
  const base: RaceEntry = { ...EMPTY_ENTRY, relays: ['계영 200m', '혼계영 200m'] }

  it('declining relays clears the chosen list', () => {
    // Otherwise the stored row says "no relays" and lists two, and whichever
    // half a screen happens to read decides what the member appears to have said.
    expect(normaliseEntry({ ...base, noRelay: true }, OFFERED).relays).toEqual([])
  })

  it('drops a relay the race no longer offers', () => {
    const stale = { ...base, relays: ['계영 200m', '사라진 종목'] }
    expect(normaliseEntry(stale, OFFERED).relays).toEqual(['계영 200m'])
  })

  it('leaves a valid selection alone', () => {
    expect(normaliseEntry(base, OFFERED).relays).toEqual(['계영 200m', '혼계영 200m'])
  })
})

describe('toggleRelay', () => {
  it('adds and removes', () => {
    const one = toggleRelay(EMPTY_ENTRY, '계영 200m', OFFERED)
    expect(one.relays).toEqual(['계영 200m'])
    expect(toggleRelay(one, '계영 200m', OFFERED).relays).toEqual([])
  })

  it('keeps the order the race offers, not the order they were tapped', () => {
    let e = toggleRelay(EMPTY_ENTRY, '혼성계영 200m', OFFERED)
    e = toggleRelay(e, '계영 200m', OFFERED)
    expect(e.relays).toEqual(['계영 200m', '혼성계영 200m'])
  })

  it('choosing one un-declines, because both cannot be true at once', () => {
    const declined: RaceEntry = { ...EMPTY_ENTRY, noRelay: true }
    expect(toggleRelay(declined, '계영 200m', OFFERED).noRelay).toBe(false)
  })
})

describe('summarise', () => {
  it('omits the second event when it is the opt-out', () => {
    expect(summarise({ ...EMPTY_ENTRY, group: '여자 일반부', s1: '자유형 50m' })).toBe(
      '여자 일반부 · 자유형 50m',
    )
  })

  it('names both events and the relays', () => {
    expect(
      summarise({
        group: '여자 30대',
        s1: '배영 50m',
        s2: '평영 50m',
        relays: ['계영 200m'],
        noRelay: false,
      }),
    ).toBe('여자 30대 · 배영 50m · 평영 50m · 계영 200m')
  })

  it('says so when relays were declined, rather than showing nothing', () => {
    expect(summarise({ ...EMPTY_ENTRY, noRelay: true })).toContain('단체전 없음')
  })
})
