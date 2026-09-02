import { useEffect } from 'react'
import { sweepPendingObjectDeletions } from './api'

/**
 * Finish any object deletion that was queued and never completed.
 *
 * Deleting a file removes its row and queues its object; removing the object is
 * a second request that can be interrupted by a closed tab or a lost network.
 * 0036 makes that interruption survivable rather than fatal — the queue entry
 * keeps the object visible to whoever may remove it — but something still has to
 * come back and finish, and on this project that something can only be a
 * signed-in session. The migration sets out why at length: a pg_cron job can
 * delete the storage.objects row without deleting the bytes behind it, which
 * would turn a visible backlog into an invisible one, and Supabase ships a
 * trigger that refuses the attempt for precisely that reason.
 *
 * So the sweeper is the screens. Whoever opens 미디어 or 자료실 drains what they
 * are permitted to drain: their own prefix, or everything if they are staff.
 * That also reaches the objects stranded before 0036, which the migration
 * adopted into the queue — nothing else can, because an unclaimed object is
 * invisible to every session including a 총관리자's.
 *
 * Fire and forget. It renders nothing, blocks nothing, and reports nothing: a
 * member has no use for a number about somebody else's leftovers, and the honest
 * place to read the backlog is the table.
 */
export function useObjectDeletionSweep(): void {
  useEffect(() => {
    void sweepPendingObjectDeletions()
  }, [])
}
