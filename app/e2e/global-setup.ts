import { execFileSync } from 'node:child_process'
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
 * How long a set of pwtest accounts can exist before we stop believing a run
 * owns them. A whole suite is about 30 seconds, so five minutes means the run
 * that made these is dead rather than busy.
 */
const LEASE_STALE_MS = 5 * 60_000
/** Past this we seed anyway — see waitForForeignRun. */
const MAX_WAIT_MS = 120_000
const POLL_MS = 3_000

/** Age of the newest pwtest account in ms, or null when there are none. */
function foreignRunAgeMs(): number | null {
  const out = execFileSync(
    'bash',
    [
      'scripts/psql.sh',
      '-q',
      '-tAX',
      '-c',
      'select coalesce(extract(epoch from now() - max(created_at)) * 1000, -1) ' +
        "from public.members where nickname like 'pwtest%'",
    ],
    { cwd: appDir, stdio: 'pipe', encoding: 'utf8' },
  ).trim()
  const ms = Number(out)
  return Number.isFinite(ms) && ms >= 0 ? ms : null
}

/**
 * Wait for another worktree's run to finish before wiping its fixtures.
 *
 * seed.sql opens with `\i e2e/cleanup.sql`, and cleanup names fixed ids — so a
 * second run starting while a first is mid-suite deletes the first's accounts
 * out from under it. That is not hypothetical: it wedged a teardown with
 * `notices_created_by_fkey ... Key (id)=(aaaaaaaa-…) is still referenced`, and
 * because auth.users.email is UNIQUE, every subsequent seed then failed too.
 * One agent's run breaks the next agent's, and neither one's tests are at fault.
 *
 * The lease is the fixtures' own age: nothing else needs to exist, and there is
 * no migration behind it. A clean run removes its accounts at teardown, so a
 * pwtest account that exists is either a live run or a crashed one.
 *
 * It gives up and seeds anyway rather than failing. Waiting forever on a crashed
 * run's leftovers would make one agent's crash everybody's outage — and seeding
 * regardless is exactly today's behaviour, so the worst case is no worse than
 * before. The message says which happened.
 *
 * SERIALISES rather than isolates. Namespacing the fixture ids per worktree
 * would let runs overlap, but it means rewriting ~200 `pwtest` literals across
 * ten files, six of them spec files — a diff that would conflict with every
 * branch in flight, to save thirty seconds of waiting.
 */
function waitForForeignRun() {
  const startedAt = Date.now()
  let waited = false

  for (;;) {
    const age = foreignRunAgeMs()
    if (age === null || age > LEASE_STALE_MS) {
      if (waited) console.log('e2e: the other run finished; seeding now')
      return
    }
    if (Date.now() - startedAt > MAX_WAIT_MS) {
      console.warn(
        `e2e: pwtest accounts are still here after ${Math.round(MAX_WAIT_MS / 1000)}s ` +
          `(newest is ${Math.round(age / 1000)}s old). Assuming a crashed run left them ` +
          'and seeding over the top.',
      )
      return
    }
    if (!waited) {
      console.log('e2e: another worktree is mid-run — waiting rather than deleting its fixtures')
      waited = true
    }
    // Synchronous sleep: globalSetup is sync, and a busy loop here would spin a
    // core for two minutes.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, POLL_MS)
  }
}

export default function globalSetup() {
  // Before anything is deleted. seed.sql's first act is to run cleanup.
  waitForForeignRun()

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
