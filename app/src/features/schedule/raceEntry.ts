import type { Json } from '../../types/database'

/**
 * 대회 신청 — which events a member is entering.
 *
 * Ported from his `raceApply` screen and `submitRace()`. The stored shape is his
 * exactly: `{ group, s1, s2, relays[], noRelay }` on `activity_applications.details`.
 *
 * WHERE THE OPTIONS COME FROM, MEASURED RATHER THAN ASSUMED
 * His 그룹 and 개인종목 lists are hardcoded `<option>`s in the markup. The relay
 * choices are the only per-race part, and they come from `activities.details.relays`
 * — which **nothing in his UI writes**: his admin form has 14 controls and `relay`
 * appears zero times in it. The single write is `relays: old?.relays || []`, a
 * carry-forward on edit. So a race offers relays only if somebody seeded them
 * outside the app.
 *
 * We therefore read the same key and show nothing when it is absent, rather than
 * inventing a catalogue of events a race might open. That is a decision for the
 * president, not for us.
 */

/**
 * His three, verbatim.
 *
 * NOTE FOR REVIEW: his list is women-only — there is no 남자 group in his markup
 * at all. Our roster has both genders (the stroke rankings split 남/여), so a male
 * member has no correct answer here. Kept as-is because the instruction was to
 * port his shape and not to invent a better one, and isolated to this constant so
 * that extending it is a one-line change once the president says what the groups
 * should be.
 */
export const RACE_GROUPS = ['여자 20대', '여자 일반부', '여자 30대'] as const

/** His four individual events. */
export const RACE_EVENTS = ['자유형 50m', '배영 50m', '평영 50m', '접영 50m'] as const

/** His second-event list carries an explicit opt-out; the first does not. */
export const NO_SECOND_EVENT = '신청 안 함'

export type RaceEntry = {
  group: string
  s1: string
  s2: string
  /** Chosen relay events. Empty when `noRelay` is true. */
  relays: string[]
  /** Explicitly declining relays, which is not the same as not having chosen yet. */
  noRelay: boolean
}

export const EMPTY_ENTRY: RaceEntry = {
  group: RACE_GROUPS[0],
  s1: RACE_EVENTS[0],
  s2: NO_SECOND_EVENT,
  relays: [],
  noRelay: false,
}

/**
 * What a race offers, from `activities.details.relays`.
 *
 * Defensive because `details` is jsonb a human may have seeded by hand: anything
 * that is not an array of non-empty strings yields no options rather than
 * throwing on a screen the member came to read.
 */
export function relayOptions(details: unknown): string[] {
  if (!details || typeof details !== 'object') return []
  const raw = (details as { relays?: unknown }).relays
  if (!Array.isArray(raw)) return []
  return raw.filter((r): r is string => typeof r === 'string' && r.trim() !== '')
}

/**
 * Read a stored entry back, for pre-filling the form.
 *
 * Returns null when there is nothing stored, which is what tells the screen to
 * say 대회 신청하기 rather than 수정 완료 — the same distinction his form makes
 * off `raceApplication` being null.
 */
export function parseEntry(details: unknown): RaceEntry | null {
  if (!details || typeof details !== 'object') return null
  const d = details as Record<string, unknown>
  const has = ['group', 's1', 's2', 'relays', 'noRelay'].some((k) => k in d)
  if (!has) return null

  const text = (v: unknown, fallback: string) =>
    typeof v === 'string' && v.trim() !== '' ? v : fallback

  return {
    group: text(d.group, EMPTY_ENTRY.group),
    s1: text(d.s1, EMPTY_ENTRY.s1),
    s2: text(d.s2, EMPTY_ENTRY.s2),
    relays: Array.isArray(d.relays)
      ? d.relays.filter((r): r is string => typeof r === 'string')
      : [],
    noRelay: d.noRelay === true,
  }
}

/**
 * Normalise before sending.
 *
 * Two rules, both his. Declining relays clears the chosen list, so the stored row
 * cannot say "no relays" and list three. And a relay that the race no longer
 * offers is dropped — otherwise editing an entry after the offered list changed
 * would silently resubmit an event that is gone.
 */
export function normaliseEntry(entry: RaceEntry, offered: readonly string[]): RaceEntry {
  const relays = entry.noRelay ? [] : entry.relays.filter((r) => offered.includes(r))
  return { ...entry, relays }
}

/** Toggle one relay, preserving the order the race offers them in. */
export function toggleRelay(
  entry: RaceEntry,
  relay: string,
  offered: readonly string[],
): RaceEntry {
  const chosen = entry.relays.includes(relay)
    ? entry.relays.filter((r) => r !== relay)
    : [...entry.relays, relay]
  return {
    ...entry,
    // Choosing a relay is itself a statement that they are not opting out.
    noRelay: false,
    relays: offered.filter((r) => chosen.includes(r)),
  }
}

/** A one-line summary for the detail screen, e.g. 「여자 일반부 · 자유형 50m · 계영 200m」. */
export function summarise(entry: RaceEntry): string {
  const parts = [entry.group, entry.s1]
  if (entry.s2 && entry.s2 !== NO_SECOND_EVENT) parts.push(entry.s2)
  if (entry.noRelay) parts.push('단체전 없음')
  else parts.push(...entry.relays)
  return parts.filter(Boolean).join(' · ')
}


/**
 * The admin's relay-options box, one event per line.
 *
 * Newlines rather than commas because these names contain no commas but do get
 * pasted from a meet programme, which is already one per line.
 */
export function parseRelayInput(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const name = raw.trim()
    // Silently dropping a duplicate is right here: the same event listed twice
    // is a paste artefact, not a statement that it runs twice.
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/** The stored list back into the box. */
export function formatRelayInput(relays: readonly string[]): string {
  return relays.join('\n')
}

/**
 * Merge a relay list into an activity's existing `details`, keeping every other
 * key.
 *
 * Replacing the object wholesale is the legacy defect this project already
 * catalogued: `registerSchedule` rebuilt `details` from scratch on every save
 * and dropped `historical_participants`, destroying a backfilled attendance
 * register with one edit. Our own rows carry import provenance -- `source`,
 * `half`, `label`, `date_source`, `record_category` -- and none of it belongs to
 * this form.
 */
export function withRelays(
  details: unknown,
  relays: readonly string[],
): Record<string, Json> {
  const base =
    details && typeof details === 'object' && !Array.isArray(details)
      ? { ...(details as Record<string, Json>) }
      : {}
  if (relays.length === 0) {
    // Removed rather than stored as [], so "this race opens no relays" and
    // "nobody has said" stay the same absent key the reader already handles.
    delete base.relays
    return base
  }
  base.relays = [...relays]
  return base
}

/**
 * 남 / 여 from the nickname, which our signup format encodes as
 * `닉네임/생년/성별/지역` -- e.g. `민선/97/여/강남`.
 *
 * Read from the nickname rather than by widening the session query: the member
 * row the app already holds carries it, and a screen that needs one more column
 * to show one sentence is not worth another round trip.
 *
 * Null for anything that does not match, which includes every pwtest fixture.
 * Null means "we do not know", and the caller must treat that as "say nothing"
 * rather than guessing.
 */
export function genderFromNickname(nickname: string | null | undefined): '남' | '여' | null {
  if (!nickname) return null
  const parts = nickname.split('/')
  if (parts.length < 3) return null
  const g = parts[2]?.trim()
  return g === '남' || g === '여' ? g : null
}

/**
 * Does the offered group list have anything for this member?
 *
 * His list is women-only -- 여자 20대 · 여자 일반부 · 여자 30대, with no 남자
 * entry at all -- so a male member has no truthful answer. We do not invent the
 * missing groups (his list is the spec) but we do not let the gap pass silently
 * either: the screen says so, which is reporting an absence rather than
 * fabricating data.
 */
export function hasGroupFor(gender: '남' | '여' | null, groups: readonly string[] = RACE_GROUPS): boolean {
  // Unknown gender: assume the list is fine, because warning everybody whose
  // nickname is not in the standard format would be noise.
  if (gender === null) return true
  return groups.some((g) => g.startsWith(gender === '남' ? '남자' : '여자'))
}
