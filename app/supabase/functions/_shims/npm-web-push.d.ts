/**
 * The one web-push export send.ts calls.
 *
 * web-push is a Deno `npm:` import fetched by the edge runtime; it is not in
 * package.json and not in node_modules, so there is nothing real for tsc to
 * read. This declares the call we make.
 *
 * The same caveat as deno.d.ts, and it bites harder here: this is our belief
 * about a third-party library's signature. If web-push's real
 * generateRequestDetails takes different options, the typecheck will not say
 * so — it will agree with us. send.ts already casts the result through
 * `unknown` to its own PushRequest type, so the return shape below is
 * documentation rather than a constraint.
 *
 * What it does earn: the ARGUMENTS are checked against what we pass, so a typo
 * in `vapidDetails` or a missing `TTL` is caught at the call site.
 */
declare module 'npm:web-push@3.6.7' {
  export interface WebPushSubscription {
    endpoint: string
    keys: { p256dh: string; auth: string }
  }

  export interface WebPushVapidDetails {
    subject: string
    publicKey: string
    privateKey: string
  }

  export interface WebPushRequestOptions {
    vapidDetails: WebPushVapidDetails
    TTL?: number
    contentEncoding?: string
  }

  export interface WebPushRequestDetails {
    endpoint: string
    headers: Record<string, string>
    body: Uint8Array | null
  }

  export function generateRequestDetails(
    subscription: WebPushSubscription,
    payload: string,
    options: WebPushRequestOptions,
  ): WebPushRequestDetails

  const webpush: {
    generateRequestDetails: typeof generateRequestDetails
  }
  export default webpush
}
