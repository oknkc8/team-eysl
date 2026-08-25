import { isStaff, type CurrentUser } from '../auth/schema'
import { ACTIVITY_KINDS, type ActivityKind } from './kinds'

/**
 * Who may create and change which kind of activity.
 *
 * Every function here mirrors 0015's RLS policies and enforces nothing. The
 * database is what refuses: activities_member_event_insert accepts only
 * kind = 'event' with created_by = current_member_id(), and the _update/_delete
 * pair tests that on both the row as it stands and the row as it would become.
 * These exist so a screen offers only what would succeed — the legacy app's whole
 * class of bug was the opposite, a hidden drawer link standing in for a check.
 *
 * The shape is the president's, from his index.html:3761-3762:
 *
 *   canCreateActivityType(kind){ return kind==='event' ? !!currentUser.memberId : isAdminUser() }
 *   canEditActivityItem(item,kind){ return kind==='event' ? item.createdBy===currentUser.memberId : isAdminUser() }
 */

/** The one kind a member may file for themselves. */
export const MEMBER_KIND: ActivityKind = 'event'

// Approval is checked rather than assumed. is_staff() and current_member_id()
// both require status = 'approved' (0001:123-141), while isStaff() in schema.ts
// reads only the role — so a blocked admin still satisfies isStaff() and would
// otherwise be offered buttons the database has already stopped answering for.
function isApproved(user: CurrentUser | null | undefined): user is CurrentUser {
  return !!user && user.status === 'approved'
}

/** The kinds this viewer may file, in the order the form should offer them. */
export function creatableKinds(user: CurrentUser | null | undefined): readonly ActivityKind[] {
  if (!isApproved(user)) return []
  return isStaff(user) ? ACTIVITY_KINDS : [MEMBER_KIND]
}

export function canCreateKind(user: CurrentUser | null | undefined, kind: ActivityKind): boolean {
  return creatableKinds(user).includes(kind)
}

/**
 * Just enough of an activity to answer the question. Structural rather than the
 * imported Activity type, so this module stays clear of api.ts and the Supabase
 * client it loads at import time.
 */
export type OwnedActivity = { kind: ActivityKind; created_by: string | null }

/**
 * Whether this viewer may edit **or delete** the activity. One answer for both,
 * because 0015 gives activities_member_event_update and _delete the same USING
 * expression, and the president's client asks the same single question.
 */
export function canEditActivity(
  user: CurrentUser | null | undefined,
  activity: OwnedActivity,
): boolean {
  if (!isApproved(user)) return false
  if (isStaff(user)) return true
  // created_by is null on any row filed before anyone was attributed. Comparing
  // it against a string id is false, which is the reading we want: an unowned row
  // belongs to staff, not to whoever happens to open it.
  return activity.kind === MEMBER_KIND && activity.created_by === user.id
}
