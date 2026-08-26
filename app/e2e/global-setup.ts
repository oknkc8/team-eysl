import { execFileSync, spawn } from 'node:child_process'
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
 * A session advisory lock has none of those properties. Acquisition is atomic,
 * waiting is the database's job rather than a poll loop, and the lock is bound
 * to a connection — so a run that crashes releases it by dying, which is the
 * staleness problem solved by construction instead of by a guessed timeout.
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
const LOCK_HOLD_SECONDS = 900

const LOCK_HELD_MARKER = 'EYSL_E2E_SEED_LOCK_HELD'

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

  // Both pids: the local process to stop, and the backend that actually owns the
  // lock. Teardown needs the second one — see the comment on the marker above.
  fs.writeFileSync(SEED_LOCK_PID_FILE, `${holder.pid} ${backendPid}`, { encoding: 'utf8' })
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
}
