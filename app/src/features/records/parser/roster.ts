// Name matching — the one place this port deliberately departs from the legacy.
//
// The legacy (index.html:2908-2909) did `memberMap.find(m => m.realName === name)`
// and `continue`d when it found nobody: a swimmer whose 실명 is spelled with a
// space, or who is not on the roster yet, vanished from the upload with no
// trace. Worse, `.find` takes the first of several members sharing a 실명, so
// two 김민수 would have quietly filed one swimmer's time against the other.
//
// Here the match is a *state* carried on the row instead of a filter applied to
// it. Nothing is dropped for being unrecognised and nothing is guessed: the
// screen shows every EYSL row and the admin resolves the ones the roster could
// not decide. A row with no member attached cannot be saved, which is the point
// — a wrong personal best is worse than a missing one.

/** A member a parsed name can be filed against. */
export type RosterEntry = {
  memberId: string
  nickname: string
  /** 실명 as the club records it. Members without one never reach this list. */
  realName: string
}

export type MatchState =
  /** Exactly one roster 실명 equals the printed name. */
  | { kind: 'matched'; memberId: string; nickname: string }
  /** Several members share that 실명; only a person can say which one swam. */
  | { kind: 'ambiguous'; candidates: RosterEntry[] }
  /** Nobody on the roster is spelled that way. */
  | { kind: 'unmatched' }

/**
 * Exact equality on the printed 실명, same as the legacy.
 *
 * Deliberately not fuzzy. Loosening it here would trade a visible unmatched row
 * — which costs the admin one click — for an invisible wrong one. The strictness
 * is only safe *because* unmatched rows now surface: '김 철수' with a space
 * lands in front of a person instead of in the bin.
 */
export function matchRealName(name: string, roster: RosterEntry[]): MatchState {
  const candidates = roster.filter((entry) => entry.realName === name)
  const [only] = candidates
  if (!only) return { kind: 'unmatched' }
  if (candidates.length > 1) return { kind: 'ambiguous', candidates }
  return { kind: 'matched', memberId: only.memberId, nickname: only.nickname }
}
