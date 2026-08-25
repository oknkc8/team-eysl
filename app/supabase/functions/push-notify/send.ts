/**
 * Encrypting one payload for many devices and posting it to their push services.
 *
 * The crypto is web-push's, not ours. RFC 8291 payload encryption and RFC 8292
 * VAPID signing are the kind of thing that fails silently when written by hand —
 * a wrong salt and the browser drops the message with no error anyone can see.
 *
 * The transport is deliberately NOT web-push's. `sendNotification()` would post
 * through node:https, which puts delivery on Deno's Node compatibility shim;
 * `generateRequestDetails()` does the same crypto and hands back a plain request
 * to make with `fetch`, which the edge runtime implements natively. Same
 * signatures, one fewer layer that can differ between the machine this was
 * tested on and the one it runs on.
 */

import webpush from 'npm:web-push@3.6.7'

/** One row of push_subscriptions, as push_notify_context_v1() returns it. */
export type Recipient = {
  id: string
  endpoint: string
  p256dh: string
  auth: string
}

export type VapidDetails = {
  subject: string
  publicKey: string
  privateKey: string
}

export type SendReport = {
  /** Push services that accepted the message. */
  sent: number
  /** Rows deleted because the endpoint is gone for good. */
  pruned: number
  /** Everything else — the row stays, and the next event tries again. */
  failed: number
  /** Enough to diagnose from the function logs without naming the member. */
  errors: string[]
}

/**
 * How many endpoints are in flight at once.
 *
 * Not unbounded: a club-wide notice is one request per device, and firing two
 * hundred at a push service simultaneously is how a sender earns a rate limit
 * for everyone. Not one at a time either — that would put the whole club behind
 * whichever phone's push service is slowest today.
 */
const CONCURRENCY = 12

/**
 * How long a push service is given to answer.
 *
 * A hung endpoint must not hold the batch, and it must not hold the function
 * either: Supabase gives an Edge Function a wall-clock budget, and one
 * unresponsive host is not a reason for the other members to hear nothing.
 */
const REQUEST_TIMEOUT_MS = 10_000

/**
 * How long the push service should hold the message for a phone that is off.
 *
 * Six hours. Long enough for a phone charging overnight; short enough that a
 * waitlist offer never arrives after the twelve-hour deadline it names, which
 * would be worse than not arriving at all.
 */
const TTL_SECONDS = 6 * 60 * 60

/**
 * A subscription that will never work again, as opposed to one that failed today.
 *
 * 404 and 410 are the push service saying the endpoint does not exist — the
 * browser dropped it, the member reinstalled, the service expired it. Every
 * other status is transient by comparison: 429 is a rate limit, 500 is their
 * outage, 401 is our VAPID key being wrong, and not one of those is fixed by
 * throwing away the member's registration.
 */
export function isGone(status: number): boolean {
  return status === 404 || status === 410
}

/**
 * Send one payload to every recipient.
 *
 * `onGone` is called for each dead subscription rather than the row being
 * deleted here, because deleting is a database concern and this module holds no
 * client. It is awaited: a prune that quietly failed would leave the row to be
 * written to again on every future notice, forever.
 *
 * Nothing in here throws. A push failure is not a reason for the caller to fail —
 * the notice was posted and the offer was made before this ran.
 */
export async function sendToAll(input: {
  recipients: readonly Recipient[]
  payload: unknown
  vapid: VapidDetails
  onGone: (subscriptionId: string) => Promise<void>
}): Promise<SendReport> {
  const body = JSON.stringify(input.payload)
  const report: SendReport = { sent: 0, pruned: 0, failed: 0, errors: [] }

  const queue = [...input.recipients]
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const recipient = queue.shift()
      if (!recipient) return
      await deliver(recipient, body, input.vapid, input.onGone, report)
    }
  })

  await Promise.all(workers)
  return report
}

/**
 * What generateRequestDetails() hands back, as fetch needs to see it.
 *
 * `<ArrayBuffer>` is spelled out for the same reason vapidKeyToBytes does it in
 * src/features/push/support.ts: a bare `Uint8Array` means
 * `Uint8Array<ArrayBufferLike>`, which could be backed by a SharedArrayBuffer,
 * and BodyInit cannot be. Leaving it off fails the typecheck at the fetch call
 * with an error about URLSearchParams that has nothing to do with anything here.
 */
type PushRequest = {
  endpoint: string
  headers: Record<string, string>
  body: Uint8Array<ArrayBuffer> | null
}

async function deliver(
  recipient: Recipient,
  body: string,
  vapid: VapidDetails,
  onGone: (subscriptionId: string) => Promise<void>,
  report: SendReport,
): Promise<void> {
  let request: PushRequest
  try {
    request = webpush.generateRequestDetails(
      { endpoint: recipient.endpoint, keys: { p256dh: recipient.p256dh, auth: recipient.auth } },
      body,
      { vapidDetails: vapid, TTL: TTL_SECONDS, contentEncoding: 'aes128gcm' },
    ) as unknown as PushRequest
  } catch (error) {
    // A row whose stored keys are not keys. It cannot be encrypted to now or
    // ever, but this is not the push service saying the endpoint is gone, so it
    // is reported rather than deleted — deleting on our own misreading is how a
    // working registration disappears.
    report.failed += 1
    report.errors.push(`encrypt: ${describe(error)}`)
    return
  }

  try {
    const response = await fetch(request.endpoint, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    // Read and discard: an unconsumed body keeps the connection out of the pool,
    // and at two hundred devices that adds up to sockets the runtime will not
    // give back.
    await response.arrayBuffer().catch(() => undefined)

    if (response.ok) {
      report.sent += 1
      return
    }

    if (isGone(response.status)) {
      // Ordinary and frequent: browsers expire endpoints constantly. Removing
      // the row is the whole handling — the batch carries on, and the member's
      // other devices are untouched.
      try {
        await onGone(recipient.id)
        report.pruned += 1
      } catch (error) {
        // The endpoint is still dead; we simply failed to record that. Counting
        // it as pruned would report a cleanup that did not happen.
        report.failed += 1
        report.errors.push(`prune: ${describe(error)}`)
      }
      return
    }

    report.failed += 1
    report.errors.push(`HTTP ${response.status} ${host(recipient.endpoint)}`)
  } catch (error) {
    // A timeout, a DNS failure, a push service that hung up. Transient by
    // assumption, so the row stays.
    report.failed += 1
    report.errors.push(`network: ${describe(error)} ${host(recipient.endpoint)}`)
  }
}

/** The push service, without the endpoint token — which identifies the member. */
function host(endpoint: string): string {
  try {
    return new URL(endpoint).host
  } catch {
    return 'unknown-host'
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
