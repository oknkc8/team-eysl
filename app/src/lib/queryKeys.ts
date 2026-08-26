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
 * THE NAME STAYS FIRST. react-query matches by prefix, and the write screens
 * invalidate with the bare name — AdminCheckInPage sends `['my-achievement']`
 * without knowing whose it is. Putting the member id after the name keeps those
 * working; putting it first would silently stop every one of them matching, with
 * no error and a stale screen as the only symptom.
 */
export function personalKey(
  name: string,
  userId: string | undefined,
  ...rest: readonly (string | number | boolean | null)[]
): readonly unknown[] {
  // `null` rather than `undefined` for a signed-out reader: it is explicit, and
  // it keeps "nobody" from colliding with a member whose id is merely missing
  // from a render that has not resolved yet.
  return [name, userId ?? null, ...rest]
}
