import { msUntil } from './countdown'
import type { MyApplication } from './api'

export type StatusTag = {
  label: string
  /** The `.tag` modifier class that carries the colour — never a colour itself. */
  tone: 'ok' | 'wait' | 'offer'
}

/**
 * What the viewer's own application says, in one vocabulary.
 *
 * Reads the viewer's own row and never the counts beside it. Whether they hold
 * a seat was decided by apply_to_activity() under a row lock; recomputing it
 * here from participant_count against capacity is exactly the legacy defect
 * (index.html:2384).
 *
 * Lives in its own module because two screens answer this question — the
 * schedule list and the home screen's 내가 참여하는 다음 일정 — and a member who
 * reads 참가확정 on one and 신청완료 on the other has to work out for themselves
 * whether those are the same thing. His app has exactly that split
 * (upstream:2473 prints 신청완료/대기완료 on home while his list says otherwise),
 * and it is not worth reproducing.
 *
 * Returns the tag's modifier class rather than a colour pair, so the palette
 * stays in components.css and this function decides only which state is true.
 */
export function myStatusTag(mine: MyApplication | null): StatusTag | null {
  if (!mine) return null

  if (mine.offer_status === 'offered' && msUntil(mine.offer_expires_at) > 0)
    return { label: '자리 났어요', tone: 'offer' }

  if (mine.application_type === 'participant') return { label: '참가확정', tone: 'ok' }

  return {
    label: mine.wait_order === null ? '대기 중' : `대기 ${mine.wait_order}번째`,
    tone: 'wait',
  }
}
