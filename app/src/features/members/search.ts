/**
 * Client-side roster search.
 *
 * The whole club is around forty people and listRoster() already has every row
 * in hand, so filtering in the browser answers instantly and costs no request.
 * A server-side `ilike` would also have to run against member_public_v, which
 * deliberately holds no 실명 to search on.
 */

type Searchable = {
  nickname: string
  short_name: string | null
  team_role: string | null
}

// toLowerCase before stripping spaces, not after: the order does not matter for
// Korean but does for a Latin nickname typed in caps.
const fold = (value: string) => value.toLowerCase().replace(/\s+/g, '')

/**
 * Case-folded, whitespace-insensitive containment across the three public
 * fields.
 *
 * Spaces are stripped from both sides rather than split into terms: Korean
 * nicknames are frequently written with an inconsistent space ("김 철수" vs
 * "김철수"), and somebody typing one form should still find the other. An empty
 * query matches everything, so a cleared box restores the full roster rather
 * than emptying it.
 */
export function matchesQuery(member: Searchable, query: string): boolean {
  const needle = fold(query)
  if (needle === '') return true

  return (
    fold(member.nickname).includes(needle) ||
    fold(member.short_name ?? '').includes(needle) ||
    fold(member.team_role ?? '').includes(needle)
  )
}

/** The same test applied to a list, returning the original array when idle. */
export function filterRoster<T extends Searchable>(members: T[], query: string): T[] {
  if (fold(query) === '') return members
  return members.filter((member) => matchesQuery(member, query))
}
