import { describe, it, expect } from 'vitest'
import { filterRoster, matchesQuery } from './search'

const member = (
  nickname: string,
  short_name: string | null = null,
  team_role: string | null = null,
) => ({ nickname, short_name, team_role })

const ROSTER = [
  member('김철수', '철', '코치'),
  member('이영희', '영', '총무'),
  member('Park Jimin', 'JM', null),
]

describe('matchesQuery', () => {
  it('finds a nickname by a fragment of it', () => {
    expect(matchesQuery(member('김철수'), '철수')).toBe(true)
    expect(matchesQuery(member('김철수'), '영희')).toBe(false)
  })

  it('searches the short name and the team role too', () => {
    expect(matchesQuery(member('김철수', '철', '코치'), '코치')).toBe(true)
    expect(matchesQuery(member('김철수', 'CS', null), 'cs')).toBe(true)
  })

  // A Korean nickname gets written both ways, and somebody searching for one
  // form is looking for the same person either way.
  it('ignores spaces on both sides of the comparison', () => {
    expect(matchesQuery(member('김 철수'), '김철수')).toBe(true)
    expect(matchesQuery(member('김철수'), '김 철수')).toBe(true)
  })

  it('ignores case for a Latin nickname', () => {
    expect(matchesQuery(member('Park Jimin'), 'JIMIN')).toBe(true)
  })

  it('does not trip over a null short name or team role', () => {
    expect(matchesQuery(member('김철수', null, null), '철수')).toBe(true)
    expect(matchesQuery(member('김철수', null, null), '코치')).toBe(false)
  })

  // An empty box means "not searching", never "nothing matches" — the opposite
  // reading would blank the roster the moment somebody cleared the field.
  it('matches everything for an empty or blank query', () => {
    expect(matchesQuery(member('김철수'), '')).toBe(true)
    expect(matchesQuery(member('김철수'), '   ')).toBe(true)
  })
})

describe('filterRoster', () => {
  it('keeps only the matching rows', () => {
    expect(filterRoster(ROSTER, '코치').map((m) => m.nickname)).toEqual(['김철수'])
  })

  it('returns the whole roster when the box is empty', () => {
    expect(filterRoster(ROSTER, '')).toHaveLength(3)
    expect(filterRoster(ROSTER, '  ')).toHaveLength(3)
  })

  it('returns nothing when a real query matches nobody', () => {
    expect(filterRoster(ROSTER, '없는사람')).toEqual([])
  })

  it('preserves the order it was given', () => {
    expect(filterRoster(ROSTER, '이').map((m) => m.nickname)).toEqual(['이영희'])
  })
})
