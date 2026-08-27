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
