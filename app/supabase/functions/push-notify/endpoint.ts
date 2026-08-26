/**
 * Which URLs this sender will make a request to.
 *
 * The database answers the same question — is_push_endpoint() in migration
 * 0023, which the push_subscriptions CHECK constraint and the registration RPC
 * both call — and this is the copy that guards the fetch itself. Two copies of
 * one rule is not a design anybody wants; it is what a rule spanning SQL and
 * TypeScript costs. endpoint.rule.test.ts reads the migration and fails if the
 * two ever drift, so the duplication is at least loud.
 *
 * Why the fetch needs its own check when the constraint exists: the constraint
 * was added NOT VALID, so rows written before 0023 were never tested against
 * it. Those rows still reach this function through push_notify_context_v1,
 * which deliberately does not filter them — the thing that makes the request is
 * the thing that should decide whether to make it, and a row skipped here shows
 * up in the send report instead of vanishing silently.
 *
 * What this is and is not, so nobody mistakes it for more than it is:
 *
 *   - It is an allowlist of push service hosts. That is what makes it immune to
 *     the DNS problem a denylist has, where a hostname resolves to something
 *     harmless when checked and to 169.254.169.254 when fetched: to get past
 *     this, an attacker would have to control DNS for fcm.googleapis.com.
 *   - It is NOT a network egress control. If one of these hostnames were made
 *     to resolve elsewhere, nothing here would notice.
 *   - It does not stop traffic to the push services themselves. Bounding that
 *     is the device cap and the self_test rate limit, both in 0023.
 */

/**
 * The push services a subscription may name.
 *
 * Matched exactly or as a suffix after a dot, so web.push.apple.com passes and
 * notfcm.googleapis.com does not. Keep this list identical to the `allowed`
 * VALUES list in 0023 — the test that reads that migration is what enforces it.
 */
export const PUSH_ENDPOINT_HOSTS: readonly string[] = [
  // Chrome, Edge, Opera, Brave, and every Android browser using Play services.
  'fcm.googleapis.com',
  // The older Google endpoint, still held by long-lived subscriptions.
  'android.googleapis.com',
  // Firefox.
  'push.services.mozilla.com',
  // Windows notification service.
  'notify.windows.com',
  // Safari, and the only way an iPhone receives web push at all.
  'push.apple.com',
]

/** Bounds that rule out the absurd rather than describing a real endpoint. */
const MIN_LENGTH = 20
const MAX_LENGTH = 1000

/**
 * https, a dotted lower-case host, then a path.
 *
 * The characters this does NOT admit are the point of it: no '@', so
 * https://fcm.googleapis.com@evil.example/x cannot pretend to be Google; no
 * ':', so no port; no whitespace; and the host must be followed by '/', so
 * fcm.googleapis.com.evil.example is read as that whole name and fails the
 * allowlist below rather than matching a suffix of it.
 */
const ENDPOINT_SHAPE =
  /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+\/[^\s]*$/

const SCHEME = 'https://'

/** The host, given a string ENDPOINT_SHAPE has already accepted. */
function hostOf(endpoint: string): string {
  return endpoint.slice(SCHEME.length, endpoint.indexOf('/', SCHEME.length))
}

export function isAllowedPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string') return false
  if (endpoint.length < MIN_LENGTH || endpoint.length > MAX_LENGTH) return false
  if (!ENDPOINT_SHAPE.test(endpoint)) return false

  const host = hostOf(endpoint)
  return PUSH_ENDPOINT_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
}
