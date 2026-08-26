/**
 * push-notify — the half of web push that did not exist.
 *
 * Everything before this registered browsers and stored their subscriptions;
 * nothing ever wrote to them (src/features/push/api.ts said so in its header).
 * This is the sender.
 *
 * ---------------------------------------------------------------- what triggers
 *
 * The database does, through pg_net, from AFTER-INSERT and AFTER-UPDATE triggers
 * (migration 0022). Not the client, and the reason is not taste.
 *
 * For 대기자 알림 there is no client to call anything. `offer_status` is only ever
 * set to 'offered' by offer_seat_to_next_waitlister() (0020:101), and that is
 * reached from exactly three places: the pg_cron sweep every five minutes, an
 * AFTER DELETE trigger when somebody cancels, and an AFTER UPDATE trigger when
 * staff raise a capacity. The sweep runs at four in the morning with no browser
 * anywhere; the other two run inside the transaction of a *different* member —
 * the one who cancelled — who is not the person being offered the seat. A
 * client-side send would deliver a waitlist offer only when one member happened
 * to cancel while another member's app was open. That is not a rule, it is a
 * coincidence, and the offer expires in twelve hours.
 *
 * So the waitlist notification has to come from the database. And once one of the
 * three comes from the database, all three should: one mechanism, one place to
 * look, and — the property a client-side send cannot have — a notice inserted by
 * any path at all still notifies. Typed into the app, pasted into the SQL editor,
 * written by a future import script: the trigger is on the table, so all three
 * behave the same. The legacy app put this in the browser (index.html:2185 calls
 * sendPush right after the insert resolves), which is the pattern this project
 * keeps finding bugs in — a rule that holds only while the browser cooperates.
 *
 * The cost, stated plainly: a backfill that inserts old notices would notify the
 * whole club about years-old news. `set local eysl.suppress_push = 'on'` inside
 * that transaction turns the triggers off, and 0022 documents it where whoever
 * writes the backfill will be looking.
 *
 * ------------------------------------------------------------- who receives it
 *
 * This function decides, never the caller. A trigger passes an event name and one
 * row id; push_notify_context_v1() reads the row and returns both the facts and
 * the exact subscriptions to write to. There is no request shape that names a
 * recipient, so there is nothing for a client to abuse — and the notification
 * text is read from the row rather than accepted from the request, so nobody can
 * put a sentence of their own in front of the club under the club's name.
 *
 * --------------------------------------------------------------- who may call
 *
 * verify_jwt is off for this function (supabase/config.toml) because the two
 * callers authenticate differently, so both checks are made here, explicitly:
 *
 *   - the database, proving itself with PUSH_TRIGGER_SECRET, may raise any of
 *     the three real events;
 *   - a signed-in member, proving themselves with their own Supabase session,
 *     may raise `self_test` and nothing else — and its audience is their own
 *     devices, derived from their session rather than from what they sent.
 *
 * Anything else is refused. This endpoint is reachable by the whole internet;
 * that is exactly why nothing here trusts the request body.
 *
 * ------------------------------------------------------------ what it will fetch
 *
 * Not whatever a row happens to say. An approved member used to be able to
 * store any URL in push_subscriptions.endpoint and then press 테스트 알림
 * 보내기, which made this function — holding the service role, inside our
 * network — issue that request on their behalf. 0023 closes the write side
 * (a validating RPC, a CHECK constraint, a device cap) and endpoint.ts closes
 * this side: an endpoint that is not a known push service is skipped rather
 * than fetched, because rows written before that constraint still exist.
 *
 * self_test is also rate limited, in the database rather than in this process
 * (push_self_test_allow_v1). Proving push works takes one send.
 */

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.112.4'
import { buildPayload, type PushEvent } from './payload.ts'
import { sendToAll, type Recipient, type VapidDetails } from './send.ts'

/** The three the president asked for. `self_test` is not among them on purpose. */
const TRIGGER_EVENTS: readonly PushEvent[] = [
  'notice_created',
  'activity_created',
  'waitlist_offered',
]

/**
 * A uuid in the one form Postgres emits: lowercase, hyphenated, 8-4-4-12.
 *
 * Deliberately narrower than what Postgres would *accept* on input — it also
 * takes uppercase and braces. Every id this function is given comes from
 * `jsonb_build_object('id', p_id)` over a uuid column, which renders canonically,
 * so the narrow form cannot refuse a real call and does refuse the shapes a
 * hand-written caller gets wrong.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Well-formed, and names nothing. Refused alongside the malformed ones. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000'

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', ...extra },
  })
}

/**
 * Whether this member may raise self_test right now.
 *
 * The counter is in the database (push_self_test_quota, 0023) rather than in
 * this process, because a function instance remembers nothing between
 * invocations — Supabase may run the next request somewhere else entirely, so
 * a limit held in memory is a limit that resets whenever the platform decides
 * to. Returns null when the send may proceed, or the refusal to return.
 */
/**
 * The SQLSTATE off a failed supabase-js call, or 'unknown'.
 *
 * Always a string, never absent: a body that sometimes omits the field cannot be
 * told from one written before this existed, and distinguishing those is the
 * entire job. 'unknown' is itself a useful answer — it means the failure never
 * reached PostgreSQL, so the fetch is the suspect rather than the SQL.
 */
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && code !== '' ? code : 'unknown'
}

async function selfTestRateLimit(db: SupabaseClient, memberId: string): Promise<Response | null> {
  const { data, error } = await db.rpc('push_self_test_allow_v1', { p_member: memberId })
  if (error) {
    // Refused rather than allowed. A limiter that fails open is not a limiter,
    // and the cost of being wrong here is one member not getting a test push.
    console.error('push-notify: rate limit check failed', error.message)
    return json({ ok: false, error: 'could not check the rate limit' }, 503)
  }

  const verdict = (data ?? {}) as { allowed?: boolean; reason?: string; retry_after_seconds?: number }
  if (verdict.allowed === true) return null

  const retryAfter = Math.max(1, Number(verdict.retry_after_seconds ?? 60))
  console.log(`push-notify self_test: refused (${verdict.reason ?? 'rate limited'}), retry in ${retryAfter}s`)
  // retry_after_seconds is what the settings screen turns into a sentence; the
  // header is there because 429 without one is a status code and not an answer.
  return json(
    {
      ok: false,
      error: 'too many test notifications',
      reason: verdict.reason ?? 'rate_limited',
      retry_after_seconds: retryAfter,
    },
    429,
    { 'Retry-After': String(retryAfter) },
  )
}

/**
 * The VAPID pair, or a sentence naming what is missing.
 *
 * Read per request rather than at module load so a missing secret is a 500 with
 * a reason in it, not a function that fails to boot and reports nothing. The
 * private half exists only here, in Supabase's function secrets — never in the
 * repository, never in a VITE_ variable, which ships to every visitor.
 */
function readVapid(): VapidDetails | string {
  const publicKey = Deno.env.get('VAPID_PUBLIC_KEY')?.trim()
  const privateKey = Deno.env.get('VAPID_PRIVATE_KEY')?.trim()
  // RFC 8292 wants a contact the push service can reach if our sending misbehaves.
  const subject = Deno.env.get('VAPID_SUBJECT')?.trim()

  if (!publicKey || !privateKey || !subject) {
    const missing = [
      publicKey ? null : 'VAPID_PUBLIC_KEY',
      privateKey ? null : 'VAPID_PRIVATE_KEY',
      subject ? null : 'VAPID_SUBJECT',
    ].filter((name): name is string => name !== null)
    return `push is not configured: ${missing.join(', ')} not set`
  }
  return { subject, publicKey, privateKey }
}

/**
 * Timing-safe comparison of the shared secret.
 *
 * `===` on a secret leaks its prefix through how long the comparison takes.
 * Cheap to avoid, and this one guards the ability to notify the entire club.
 */
function secretMatches(given: string | null, expected: string): boolean {
  if (given === null) return false
  const encoder = new TextEncoder()
  const a = encoder.encode(given)
  const b = encoder.encode(expected)
  // Length is not secret — it is visible in the header the caller sent — so an
  // early return here gives away nothing the request did not already carry.
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

/**
 * Who is asking, and what they are allowed to ask for.
 *
 * Returns the event and the row id to look up, or a refusal. The member branch
 * never reads an id from the request: the member is resolved from the session
 * token the caller presented, so a member can only ever test their own devices.
 */
async function authorize(
  request: Request,
  body: Record<string, unknown>,
  db: SupabaseClient,
): Promise<{ event: PushEvent; id: string } | Response> {
  const triggerSecret = Deno.env.get('PUSH_TRIGGER_SECRET')?.trim() ?? ''
  const event = typeof body.event === 'string' ? body.event : ''

  // ------------------------------------------------------------- the database
  // The empty check is load-bearing: an unset secret must not turn into a header
  // anyone can match by also sending nothing.
  if (
    triggerSecret !== '' &&
    secretMatches(request.headers.get('x-eysl-push-secret'), triggerSecret)
  ) {
    if (!TRIGGER_EVENTS.includes(event as PushEvent)) {
      return json({ ok: false, error: `unknown event: ${event}` }, 400)
    }
    const id = typeof body.id === 'string' ? body.id : ''
    if (id === '') return json({ ok: false, error: 'id is required' }, 400)
    // push_notify_context_v1's second parameter is `uuid`, so anything else is
    // refused by PostgREST when the cast fails — which arrives here as an RPC
    // error and leaves as a 500. A caller's malformed id is a 400; only our own
    // failures are 500s.
    //
    // THIS IS NOT WHAT CAUSED THE 500s IN net._http_response. Every one of those
    // came through request_push_notify(text, uuid), whose second parameter is a
    // uuid column, so a non-uuid cannot reach the function that way — verified
    // against the three triggers, and no script queues a hand-built body. The
    // cause of those is still unknown; this closes a different hole that
    // produces a byte-identical response, which is exactly why the discriminator
    // below exists.
    //
    // Canonical form only, which is what Postgres renders a uuid as, so this
    // cannot refuse a call the triggers actually make.
    if (!UUID_PATTERN.test(id)) return json({ ok: false, error: 'id must be a uuid' }, 400)
    // The nil uuid is well-formed and identifies nothing. Downstream it is
    // already harmless — the RPC finds no row and answers 200 {skipped:true} —
    // so this closes a hole in what this check CLAIMS rather than a defect in
    // what the function does. Worth closing anyway: what is being refused here
    // is "an id that cannot name a row", and the nil uuid is the clearest
    // example of one. It is also what an uninitialised variable serialises to,
    // which is precisely the caller mistake this check exists for.
    if (id === NIL_UUID) return json({ ok: false, error: 'id must not be the nil uuid' }, 400)
    return { event: event as PushEvent, id }
  }

  // ----------------------------------------------------------------- a member
  const authorization = request.headers.get('Authorization') ?? ''
  if (!authorization.startsWith('Bearer ')) {
    return json({ ok: false, error: 'unauthorized' }, 401)
  }
  if (event !== 'self_test') {
    // Deliberately the same refusal a bad token gets. A member probing for which
    // events exist learns nothing from the difference between the two.
    return json({ ok: false, error: 'unauthorized' }, 401)
  }

  // The token is checked against the Auth server rather than merely decoded
  // here: a JWT is only a claim until something with the signing key agrees.
  const { data: auth, error: authError } = await db.auth.getUser(
    authorization.slice('Bearer '.length),
  )
  if (authError || !auth.user) return json({ ok: false, error: 'unauthorized' }, 401)

  // The same two conditions current_member_id() applies — auth_user_id matches
  // and status is 'approved' — spelled out rather than delegated to the RPC,
  // because calling that RPC would need a client bound to the member's session,
  // and that client needs an anon key this function is not guaranteed to have:
  // a project issuing sb_publishable_ keys may never populate SUPABASE_ANON_KEY.
  // Reading the row with the service key depends on nothing but the service key,
  // which the platform always injects.
  const { data: member, error: memberError } = await db
    .from('members')
    .select('id')
    .eq('auth_user_id', auth.user.id)
    .eq('status', 'approved')
    .maybeSingle()
  if (memberError) return json({ ok: false, error: 'unauthorized' }, 401)
  // Signed in but pending, rejected or blocked. Refused by name, because this is
  // the one refusal on this endpoint a member can act on.
  if (!member) return json({ ok: false, error: 'not an approved member' }, 403)

  return { event: 'self_test', id: member.id }
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS })
  if (request.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405)

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return json({ ok: false, error: 'body must be JSON' }, 400)
  }

  // Service role. Reading another member's devices is the whole job here, and no
  // RLS policy could permit it without permitting everyone. Nothing
  // member-supplied ever reaches this client as an identifier: the ids it is
  // given come from a trigger or from a verified session, never from the body.
  const db = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } },
  )

  const authorized = await authorize(request, body, db)
  if (authorized instanceof Response) return authorized

  // Only self_test, and before anything expensive. It is the one event a member
  // can raise directly; the other three come from the database, which does not
  // need protecting from itself.
  if (authorized.event === 'self_test') {
    const limited = await selfTestRateLimit(db, authorized.id)
    if (limited) return limited
  }

  const vapid = readVapid()
  if (typeof vapid === 'string') return json({ ok: false, error: vapid }, 500)

  const { data: context, error } = await db.rpc('push_notify_context_v1', {
    p_event: authorized.event,
    p_id: authorized.id,
  })
  if (error) {
    // The message stays here and only here: it can quote a value or name a
    // relation, and this endpoint answers anyone holding the trigger secret.
    console.error('push-notify: context lookup failed', error.message)
    // The code goes in the body, and that is the whole point of this branch.
    //
    // Eight of these 500s sat in net._http_response with no way to tell them
    // apart — a uuid cast failure, a permission change and a dropped connection
    // all produce the identical sentence, and the real message exists only in a
    // function log nobody investigating had access to. `content` is the only
    // forensic record that survives, so it has to carry enough to sort the next
    // one into a family: 22P02 is a malformed id, 42501 is a grant that moved,
    // 08xxx is the connection. A SQLSTATE is a five-character class name — it
    // discloses no table, column or value, which is why it can be said out loud
    // when the message cannot.
    return json({ ok: false, error: 'could not read the event', code: errorCode(error) }, 500)
  }

  // push_notify_context_v1 answers null when the event describes nothing to
  // send: no such row, a waitlist offer that lapsed between the queue insert
  // and now, or an activity whose creator is not staff (0023). Distinguished
  // from an empty audience because they are different facts — "there is nothing
  // to notify about" and "nobody has a device" would otherwise read the same in
  // the log, which is the confusion this whole feature keeps producing.
  if (context === null) {
    console.log(`push-notify ${authorized.event}: nothing to notify about`)
    return json({
      ok: true,
      event: authorized.event,
      skipped: true,
      sent: 0,
      pruned: 0,
      refused: 0,
      failed: 0,
      subscription_count: 0,
      member_count: 0,
      errors: [],
    })
  }

  const facts = (context ?? {}) as {
    fact?: unknown
    recipients?: Recipient[]
    member_count?: number
  }
  const recipients = facts.recipients ?? []

  // Not an error, and not a silence worth hiding: a notice posted while nobody in
  // the club has notifications on is a successful send to zero devices, and the
  // log should be able to say exactly that.
  if (recipients.length === 0) {
    console.log(`push-notify ${authorized.event}: no registered devices in the audience`)
    return json({
      ok: true,
      event: authorized.event,
      sent: 0,
      pruned: 0,
      refused: 0,
      failed: 0,
      subscription_count: 0,
      member_count: facts.member_count ?? 0,
      errors: [],
    })
  }

  const report = await sendToAll({
    recipients,
    payload: buildPayload(authorized.event, facts.fact),
    vapid,
    onGone: async (subscriptionId) => {
      const { error: deleteError } = await db
        .from('push_subscriptions')
        .delete()
        .eq('id', subscriptionId)
      if (deleteError) throw new Error(deleteError.message)
    },
  })

  // Logged as well as returned. A trigger's pg_net call throws the response away —
  // net._http_response keeps it, but nobody reads that — so the function log is
  // where the club's actual delivery record lives.
  console.log(
    `push-notify ${authorized.event}: sent=${report.sent} pruned=${report.pruned} ` +
      `refused=${report.refused} failed=${report.failed} of ${recipients.length}`,
  )
  if (report.errors.length > 0) console.warn('push-notify errors:', report.errors.join('; '))

  return json({
    ok: true,
    event: authorized.event,
    sent: report.sent,
    pruned: report.pruned,
    refused: report.refused,
    failed: report.failed,
    subscription_count: recipients.length,
    member_count: facts.member_count ?? 0,
    errors: report.errors,
  })
})
