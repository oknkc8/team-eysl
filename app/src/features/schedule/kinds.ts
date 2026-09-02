export type ActivityKind = 'training' | 'race' | 'event'

export const ACTIVITY_KINDS: readonly ActivityKind[] = ['training', 'race', 'event']

/**
 * Korean is a render-time concern; the database stores English tokens, the same
 * split as attendance's STATUS_LABEL.
 *
 * 'event' reads 기타, not 이벤트. The president relabelled this kind and gave the
 * word 이벤트 to a rankings hub, which is a different feature entirely. The token
 * is untouched: activities.kind stores 'event' across live rows and the CHECK at
 * 0001:50 still names it, so renaming it would be a data migration for a caption.
 */
export const KIND_LABEL: Record<ActivityKind, string> = {
  training: '훈련',
  race: '대회',
  event: '기타',
}

/**
 * Narrows the kind column, which the generated types widen to `string`.
 *
 * The fallback leans to the less privileged reading, the same way api.ts's
 * toApplicationType and toOfferStatus do — and it matters more here since 0015,
 * because 'event' is now the one kind a member may create and edit. A value this
 * client does not understand must not be handed the affordances 기타 carries, so
 * an unrecognised kind reads as a staff-only one. The CHECK constraint means no
 * fourth value exists to reach this branch; it only decides which way to be wrong.
 */
export function toKind(value: string): ActivityKind {
  return (ACTIVITY_KINDS as readonly string[]).includes(value) ? (value as ActivityKind) : 'race'
}

/**
 * Whether a kind has a start and end time at all.
 *
 * A 대회 does not. A meet occupies a day and the times that matter are per-event
 * and live in the entry, so `activities.start_time`/`end_time` are meaningless
 * on it — the president reached the same conclusion in final124 and stopped
 * rendering the two boxes for races (`race-time-fields-v124.js`).
 *
 * This is a statement about the kind rather than about the form, which is why it
 * lives here next to KIND_LABEL: the edit screen uses it to decide what to
 * render AND what to send, and those two must not be allowed to disagree. A
 * screen that hides a control while still submitting its value is how a stale
 * time survives a kind change.
 *
 * 기타 keeps its clock. Only 대회 is special, and the shape is `!== 'race'`
 * rather than a list so a fourth kind — if the CHECK at 0001:50 ever gains one —
 * arrives with a clock rather than silently without one.
 */
export function kindHasClock(kind: ActivityKind): boolean {
  return kind !== 'race'
}
