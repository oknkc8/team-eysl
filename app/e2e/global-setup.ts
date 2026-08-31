import { execFileSync, spawn } from 'node:child_process'
import { randomInt } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateRunPassword } from './runPassword'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Puts the four pwtest accounts and their content fixtures into the dev
 * database before any browser starts.
 *
 * Runs the SQL through scripts/psql.sh rather than through the Supabase client,
 * because the accounts cannot be created any other way: creating an auth user
 * through the API needs the service role key, which is not in .env and has no
 * business being there.
 *
 * scripts/_env.sh refuses to connect to anything but our dev project, so this is
 * also where a mistyped .env stops — before it can put a master_admin into the
 * club's live database.
 *
 * ON_ERROR_STOP is what turns a failed seed into a failed run. Without it psql
 * reports the error and exits 0, and the suite would then fail one test at a
 * time with "no such member" instead of once, here, with the real reason.
 */
/**
 * The one lock every worktree's suite contends for, held from before the seed
 * until teardown.
 *
 * THIS REPLACES AN AGE CHECK THAT WAS NOT A LOCK. The first version measured how
 * old the pwtest rows were, waited if they looked fresh, and seeded anyway after
 * two minutes. Three things were wrong with it and they are the same thing:
 *
 *   - Two runs reading "nothing there" in the same instant both passed, and
 *     several waiting runs released on the same poll tick. Nothing stood between
 *     the check and the seed, so it serialised nothing.
 *   - After the wait it seeded over fixtures it had just measured as LIVE. The
 *     outcome matched today's collisions; the character did not. Today two runs
 *     collide knowing nothing about each other. That one collided knowing.
 *   - A suite running longer than the staleness window was read as dead, so a
 *     new run did not wait at all.
 *
 * And worst: it was called a lease, so the next person would assume it protected
 * them.
 *
 * A session advisory lock fixes the first two: acquisition is atomic, and
 * waiting is the database's job rather than a poll loop over a shared tick.
 *
 * IT DOES NOT FIX THE THIRD, and the earlier version of this comment claimed it
 * did. "The lock is released when the connection dies" is true of PostgreSQL and
 * false of us: we reach the database through the session pooler, so killing the
 * local psql leaves Supavisor's backend holding the lock. See acquireSeedLock,
 * which records the backend pid for exactly this reason. Expiry is still handled
 * by a timeout — LOCK_HOLD_SECONDS — and teardown verifies it still holds the
 * lock rather than assuming the timeout has not fired.
 */
export const LOCK_KEY = 728193647

/**
 * How long to wait for another suite before giving up. A whole suite is about
 * thirty seconds; five minutes means something is genuinely wrong, and the
 * honest response is to fail rather than to seed over a live run.
 */
const LOCK_WAIT_MS = 300_000

/**
 * The holder exits on its own after this, so an orphan cannot hold the lock
 * forever. Long enough for any suite we have, short enough that a Playwright
 * process killed before teardown stops blocking everyone within the quarter
 * hour rather than until somebody notices.
 */
export const LOCK_HOLD_SECONDS = 900

const LOCK_HELD_MARKER = 'EYSL_E2E_SEED_LOCK_HELD'

/**
 * A second advisory lock, on a key nobody else will pick, taken by the same
 * session as the shared one.
 *
 * It exists to answer "is that backend still OURS?", which the shared key cannot
 * answer on its own: the pooler recycles backends, so a recorded pid may since
 * have become somebody else's work, and the shared key does not distinguish us
 * from the next run — which holds exactly the same key.
 *
 * Only one session can hold both, because both were taken by one psql. So "the
 * backend holding our shared key AND our nonce" identifies one session rather
 * than guessing at one.
 *
 * Precisely: it is an identity up to a nonce collision. There are about 2^31
 * candidates and randomInt is unbiased and cryptographic, so a later run drawing
 * this same nonce just as ours expired is remote — but it is not zero, and the
 * earlier wording ("an identity, not a guess") claimed a guarantee this does not
 * have. The consequence of that draw is bounded: a teardown mistakes the new
 * holder for itself, which is the pre-nonce behaviour rather than something
 * worse.
 *
 * Not application_name: the pooler overwrites that with `Supavisor`, which is
 * how the connection-death claim above was caught being false.
 *
 * Below 2^31 so the bigint form lands as classid 0 / objid <nonce>, matching how
 * LOCK_KEY is stored and keeping the pg_locks predicate uniform.
 */
function newNonceKey(): number {
  for (;;) {
    const candidate = randomInt(1, 2 ** 31 - 1)
    if (candidate !== LOCK_KEY) return candidate
  }
}

/** Where the holder's pid is left for global-teardown. Git-ignored with .auth. */
export const SEED_LOCK_PID_FILE = path.join(appDir, 'e2e', '.auth', 'seed-lock.pid')

/**
 * Take the seed lock, and do not come back until it is held.
 *
 * The lock lives in a psql that stays running: a session advisory lock is
 * released when its connection closes, so the connection has to outlive the
 * seed. It signals acquisition by printing a marker — waiting on the marker
 * rather than on a timer is what makes this a lock and not another guess.
 *
 * `lock_timeout` bounds the wait inside PostgreSQL, so a queue of suites drains
 * in arrival order with no polling and no thundering herd on a shared tick.
 */
async function acquireSeedLock(): Promise<void> {
  fs.mkdirSync(path.dirname(SEED_LOCK_PID_FILE), { recursive: true })
  const nonceKey = newNonceKey()

  const holder = spawn(
    'bash',
    [
      'scripts/psql.sh',
      '-q',
      '-tAX',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `set lock_timeout = '${LOCK_WAIT_MS}ms'`,
      // THE NONCE IS TAKEN FIRST, AND THE ORDER IS THE POINT.
      //
      // These are sequential -c statements on one session, so there is a window
      // between them. Taken the other way round, a client that died in that
      // window left the SHARED key held with no nonce, no pid file and no
      // pg_sleep — an orphan outside the LOCK_HOLD_SECONDS bound, holding the
      // one key every future run waits on, until the pooler happened to reap it.
      //
      // This way the only orphan the window can produce is a nonce with no
      // shared key. The dangerous state is unreachable rather than merely
      // unlikely.
      //
      // "Nobody waits on a nonce" is the right expectation but not a theorem: a
      // later run that happens to draw the same 31-bit value would wait out
      // LOCK_WAIT_MS on it and fail. That is the same remote collision Low 5
      // names, and the comparison that matters is with what this replaced — an
      // orphaned SHARED key blocks every subsequent run, with certainty, until
      // the pooler reaps it. Trading a certainty for a one-in-two-billion is the
      // whole of the argument.
      //
      // No wait is possible on this one: the key is random and unheld.
      '-c',
      `select pg_advisory_lock(${nonceKey})`,
      // The shared key, in the same session and therefore the same backend.
      '-c',
      `select pg_advisory_lock(${LOCK_KEY})`,
      // The BACKEND pid, not this process's. Killing the local psql does not
      // release the lock: we reach the database through the session pooler
      // (scripts/_env.sh — direct connections are IPv6-only and unreachable from
      // here), so closing the client socket leaves the pooler's backend, its
      // session, and this lock exactly where they were. Verified: after the
      // client was killed, pg_stat_activity still showed `select pg_sleep(900)`
      // holding the advisory lock under application_name=Supavisor, and
      // pg_try_advisory_lock kept answering f. pg_terminate_backend on this pid
      // is what actually frees it.
      '-c',
      `select '${LOCK_HELD_MARKER} ' || pg_backend_pid()`,
      // Holds the connection, and therefore the lock, until teardown kills it.
      '-c',
      `select pg_sleep(${LOCK_HOLD_SECONDS})`,
    ],
    { cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'] },
  )

  const backendPid = await new Promise<string>((resolve, reject) => {
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      holder.kill()
      reject(new Error(`e2e: waited ${LOCK_WAIT_MS / 1000}s for the seed lock and gave up.`))
    }, LOCK_WAIT_MS + 30_000)

    holder.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
      const marked = out.split('\n').find((line) => line.startsWith(LOCK_HELD_MARKER))
      if (!marked) return
      clearTimeout(timer)
      resolve(marked.slice(LOCK_HELD_MARKER.length).trim())
    })
    holder.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString()
    })
    // Exiting before the marker means it never got the lock — a lock_timeout, or
    // the database refusing the connection. Either way, seeding now would be the
    // exact thing this function exists to prevent.
    holder.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`e2e: could not take the seed lock (psql exited ${code}). ${err.trim()}`))
    })
    holder.on('error', (cause) => {
      clearTimeout(timer)
      reject(cause)
    })
  })

  // The local process to stop, the backend that owns the lock, and the nonce
  // that proves that backend is still the one we started. Teardown needs all
  // three: the third is what turns "this pid was ours 15 minutes ago" into
  // something it can check now.
  fs.writeFileSync(SEED_LOCK_PID_FILE, `${holder.pid} ${backendPid} ${nonceKey}`, {
    encoding: 'utf8',
  })
  // The suite, not this process, is what the lock is waiting on.
  holder.unref()
}

/**
 * SERIALISES rather than isolates. Namespacing the fixture ids per worktree
 * would let runs overlap, but it means rewriting ~200 `pwtest` literals across
 * ten files, six of them spec files — a diff that would conflict with every
 * branch in flight, to save thirty seconds of waiting. Deferred deliberately;
 * it is the better end state and belongs in its own change.
 */
/**
 * The signup limiter's cap, from 0038:96. Mirrored rather than read back because
 * a limit the suite disagrees with should be visible as a wrong number here, not
 * silently adopted from the database it is supposed to be checking.
 */
const SIGNUP_CAP_PER_KEY = 60

/**
 * What one suite spends. Measured, not guessed: a full run took the two live
 * keys from 39 to 44 and 39 to 47 — five and eight, thirteen in total.
 *
 * THIRTEEN IS THE TOTAL, AND THE THRESHOLD USES IT PER KEY ANYWAY. The split
 * across egress addresses is incidental — whichever address a worker's request
 * happens to leave by — so nothing stops a run from putting all thirteen on one
 * key. Requiring thirteen free on EVERY key is the conservative reading of the
 * same measurement, and the cost of being wrong in this direction is a run that
 * waits, rather than one that fails eight tests for a reason it cannot name.
 */
const SIGNUP_COST_PER_RUN = 13

/**
 * Fail in one line when the signup budget cannot cover this run.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT ABOUT THE QUOTA BEING SMALL. When the cap
 * is reached, register_member_v1 refuses, and the refusal surfaces four layers
 * down as eight signup assertions failing on their own terms — none of which
 * says "rate limited". A day was spent reading those before anybody read the
 * quota table. What is expensive is not the limit, it is the distance between
 * the cause and the symptom.
 *
 * RUN AFTER THE SEED, NOT BEFORE, AND THAT ORDER IS THE POINT. cleanup.sql
 * deletes every quota row and seed.sql runs it first, so a check placed before
 * the seed would read residue this run is about to remove and refuse for a
 * condition that was already being fixed. Asked afterwards, it verifies the
 * state signup.spec.ts actually depends on — which is also what makes it able
 * to fail: rows here after a delete mean something outside this suite is
 * writing them, and that is precisely the case the delete cannot help with.
 *
 * Reports every key rather than the first bad one, because "which address" is
 * the question anybody debugging this asks next.
 */
function assertSignupBudget() {
  const sql =
    "select coalesce(string_agg(left(md5(client_key), 6) || ' ' || attempts_in_window, ' | '), '')" +
    ' from public.signup_attempt_quota' +
    ` where ${SIGNUP_CAP_PER_KEY} - attempts_in_window < ${SIGNUP_COST_PER_RUN}`
  let short: string
  try {
    short = execFileSync('bash', ['scripts/psql.sh', '-q', '-tAX', '-c', sql], {
      cwd: appDir,
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim()
  } catch (err) {
    // Not fatal. The seed just succeeded against this database, so a failure to
    // read one small table is a hiccup, and refusing the run over it would trade
    // a clear diagnostic for a new flake.
    //
    // BUT IT SAYS SO. Returning in silence would make a check that stopped
    // running indistinguishable from a check that ran and found nothing — the
    // exact shape this function was written to avoid one paragraph up. A rename
    // of the table or a change of grants would disable it permanently and
    // nobody would learn that from a green run.
    const e = err as { stderr?: string; message?: string }
    process.stderr.write(
      'e2e: could not read signup_attempt_quota, so the signup budget was NOT checked. ' +
        'Continuing anyway — if signup.spec fails, read that table by hand before believing ' +
        `the assertions.\n  ${(e.stderr ?? e.message ?? '').trim().split('\n')[0]}\n`,
    )
    return
  }

  if (short === '') return

  throw new Error(
    'e2e: the signup rate limit does not have room for this run, so it is stopping here ' +
      'rather than failing inside signup.spec.\n' +
      `Keys with less than ${SIGNUP_COST_PER_RUN} attempts left (md5 prefix, attempts used of ` +
      `${SIGNUP_CAP_PER_KEY}): ${short}\n` +
      'cleanup.sql empties this table and the seed just ran it, so rows here mean something ' +
      'outside this suite is spending the budget — another checkout, or an agent driving signup ' +
      'by hand.\n' +
      'The window is one hour from window_started_at (0038:95). Wait for it, or find the other ' +
      'writer; re-running now spends what is left and fails the same way.',
  )
}

export default async function globalSetup() {
  // Before anything is deleted, and held until teardown. seed.sql's first act is
  // `\i e2e/cleanup.sql`, which deletes fixed ids — so without this, a second
  // run starting mid-suite removes the first run's accounts underneath it. That
  // wedged a teardown with `notices_created_by_fkey ... Key (id)=(aaaaaaaa-…)
  // is still referenced`, and because auth.users.email is UNIQUE every seed
  // after it failed too.
  await acquireSeedLock()

  // Before the seed, because the seed hashes it.
  const password = generateRunPassword()

  try {
    execFileSync('bash', ['scripts/psql.sh', '-v', 'ON_ERROR_STOP=1', '-q', '-f', 'e2e/seed.sql'], {
      cwd: appDir,
      stdio: 'pipe',
      encoding: 'utf8',
      // Through the environment, which seed.sql picks up with `\getenv`, rather
      // than as `-v pwtest_password=...`. A command line is world-readable in
      // /proc on Linux; an environment block is readable only by the same user.
      // Neither matters much for a throwaway dev credential, but the cheaper one
      // is also the safer one.
      env: { ...process.env, PWTEST_PASSWORD: password },
    })
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string }
    throw new Error(
      'e2e seed failed. The dev database has to be reachable for these tests.\n' +
        `${e.stderr ?? ''}${e.stdout ?? ''}`,
    )
  }

  assertSignupBudget()
}
