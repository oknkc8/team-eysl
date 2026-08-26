/**
 * Query keys for data that belongs to the viewer rather than to the club.
 *
 * Every RPC behind these takes no member id — each derives the caller from the
 * session through current_member_id(), which is the right shape for the server
 * and precisely what makes two members' payloads indistinguishable once cached.
 * With a fixed key they share one cache entry, and on a shared phone the second
 * member reads the first one's data without a request being sent.
 *
 * SessionProvider clears the whole cache on an identity change, which closes the
 * hole today. This is the half that does not depend on anyone remembering to: a
 * key that names its owner cannot be answered for somebody else, whatever else
 * changes around it.
 *
 * THE VIEWER GOES LAST — after every element any invalidation prefix uses.
 *
 * react-query matches by prefix, and the write screens invalidate without
 * knowing whose cache they are touching: AdminCheckInPage sends
 * `['my-achievement']`, ActivityDetailPage sends `['schedule-entry', activityId]`.
 * Appending the viewer keeps both working and reaches EVERY viewer's entry,
 * which is what a staffer correcting somebody else's attendance needs.
 *
 * Putting the viewer earlier would compile, read more naturally, and silently
 * stop those invalidations matching — no error, just a screen that never
 * refreshes, blamed on caching in general weeks later.
 *
 * This supersedes an earlier `personalKey(name, userId, ...rest)`, which put the
 * viewer second. That was a special case of this rule — correct only while the
 * longest invalidation prefix was the bare name — stated as though it were
 * general. `['schedule-entry', activityId]` is the case that shows the
 * difference: the old helper would have narrowed six invalidations to one user.
 */
export function viewerKey(
  prefix: readonly (string | number | boolean | null)[],
  viewerId: string | undefined,
): readonly unknown[] {
  // `null` rather than `undefined` for a signed-out reader: it is explicit, and
  // it keeps "nobody" from colliding with a member whose id is merely missing
  // from a render that has not resolved yet.
  return [...prefix, viewerId ?? null]
}
