import { describe, expect, it } from 'vitest'
import {
  EMPTY_ENTRY,
  NO_SECOND_EVENT,
  formatRelayInput,
  genderFromNickname,
  hasGroupFor,
  parseRelayInput,
  withRelays,
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


describe('parseRelayInput', () => {
  it('one event per line, trimmed', () => {
    expect(parseRelayInput(' 계영 200m \n혼계영 200m\n')).toEqual(['계영 200m', '혼계영 200m'])
  })

  it('drops blanks and repeats', () => {
    expect(parseRelayInput('계영 200m\n\n계영 200m\n   \n혼계영 200m')).toEqual([
      '계영 200m',
      '혼계영 200m',
    ])
  })

  it('round-trips through the box', () => {
    const list = ['계영 200m', '혼성계영 200m']
    expect(parseRelayInput(formatRelayInput(list))).toEqual(list)
  })
})

describe('withRelays', () => {
  it('keeps every other key', () => {
    // The legacy defect this guards: registerSchedule rebuilt details from
    // scratch and dropped historical_participants. Our imported rows carry
    // provenance no form here knows about.
    const before = { source: 'import', half: 2, label: '상반기' }
    expect(withRelays(before, ['계영 200m'])).toEqual({
      source: 'import',
      half: 2,
      label: '상반기',
      relays: ['계영 200m'],
    })
  })

  it('removes the key rather than storing an empty list', () => {
    expect(withRelays({ source: 'import', relays: ['계영 200m'] }, [])).toEqual({
      source: 'import',
    })
  })

  it('survives details that is not an object', () => {
    expect(withRelays(null, ['계영 200m'])).toEqual({ relays: ['계영 200m'] })
    expect(withRelays('nonsense', ['계영 200m'])).toEqual({ relays: ['계영 200m'] })
    expect(withRelays(['a'], ['계영 200m'])).toEqual({ relays: ['계영 200m'] })
  })
})

describe('genderFromNickname', () => {
  it('reads the signup format', () => {
    expect(genderFromNickname('민선/97/여/강남')).toBe('여')
    expect(genderFromNickname('철수/88/남/관악')).toBe('남')
  })

  it('is null when it cannot tell, including every fixture nickname', () => {
    expect(genderFromNickname('pwtestmember')).toBeNull()
    expect(genderFromNickname('')).toBeNull()
    expect(genderFromNickname(null)).toBeNull()
    expect(genderFromNickname('이름/97')).toBeNull()
    expect(genderFromNickname('이름/97/x/강남')).toBeNull()
  })
})

describe('hasGroupFor', () => {
  it('his list has nothing for a male member', () => {
    expect(hasGroupFor('남')).toBe(false)
    expect(hasGroupFor('여')).toBe(true)
  })

  it('says nothing when the gender is unknown', () => {
    // Warning every fixture account, and every member whose nickname predates
    // the format, would be noise rather than information.
    expect(hasGroupFor(null)).toBe(true)
  })

  it('goes quiet once the list gains a male group', () => {
    expect(hasGroupFor('남', ['여자 일반부', '남자 일반부'])).toBe(true)
  })
})
