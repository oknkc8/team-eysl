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
