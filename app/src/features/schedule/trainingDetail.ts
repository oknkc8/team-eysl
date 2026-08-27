/**
 * The training-detail view of `activities.details`.
 *
 * `details` is a shared jsonb bag. Besides the fields this feature owns it also
 * carries the importer's `source`, the backfilled `historical_participants` and
 * `historical_attendance` registers, and whatever a later migration adds. This
 * module is the narrowing: six named keys in, everything else dropped.
 *
 * That is a boundary rather than a convenience. Handing the raw object to a
 * screen means a key somebody else stored can end up rendered on a training
 * page by accident, and the first anyone hears of it is a member asking what it
 * is. Naming the keys makes that impossible without an edit here.
 */
export type TrainingDetail = {
  coach: string | null
  gear: string | null
  info: string | null
  link: string | null
  plan: string | null
  /** Member id, set by 0048 from the session. Never a nickname. */
  plan_by: string | null
  plan_at: string | null
}

/**
 * Empty string reads as absent.
 *
 * 0048 stores absent fields by omitting them, so '' should not arrive — but a
 * row written before that function existed, or by hand, can hold one. Treating
 * '' and null the same here means the screens have a single case to render
 * instead of two that look identical.
 */
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

export function toTrainingDetail(raw: unknown): TrainingDetail {
  const d = (raw ?? {}) as Record<string, unknown>
  return {
    coach: str(d.coach),
    gear: str(d.gear),
    info: str(d.info),
    link: str(d.link),
    plan: str(d.plan),
    plan_by: str(d.plan_by),
    plan_at: str(d.plan_at),
  }
}

/** True when there is nothing worth drawing a card for. */
export function isEmptyTrainingDetail(d: TrainingDetail): boolean {
  return !d.coach && !d.gear && !d.info && !d.link && !d.plan
}
