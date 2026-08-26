import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOCK_KEY, SEED_LOCK_PID_FILE } from './global-setup'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Removes everything global-setup created.
 *
 * FAILING HERE FAILS THE RUN, and that is a reversal. This used to be a
 * console.warn, on the reasoning that the tests had already finished and a
 * cleanup hiccup should not hide what they found. That reasoning was wrong about
 * what it was trading away: what survives a failed cleanup is a live account in a
 * shared database, and a warning in scrollback is not a control. Several agents'
 * orphan rows are the evidence — nobody read the warning, because a green run
 * does not get read.
 *
 * The thing it was protecting against is real but small: a red suite whose tests
 * all passed. That is recoverable in one command, which the message names. An
 * account nobody knows is there is not.
 *
 * Per-run passwords (runPassword.ts) reduce the damage of a leftover account but
 * do not remove it — the row still holds a seat in members, still carries
 * master_admin, and still has to be found by hand.
 */
/**
 * Release the seed lock by killing the psql that holds it.
 *
 * The lock is a session lock, so it goes when the connection does. Killing the
 * holder is the release; there is no separate unlock to forget, and a run that
 * dies without reaching here releases it the same way.
 */
function releaseSeedLock() {
  let localPid: number
  let backendPid: number
  try {
    const [local, backend] = fs.readFileSync(SEED_LOCK_PID_FILE, 'utf8').trim().split(/\s+/)
    localPid = Number(local)
    backendPid = Number(backend)
  } catch {
    return // Setup never got far enough to take it.
  }

  // The backend first, because it is the thing that owns the lock. Killing only
  // the local client leaves the pooler's backend — and the session lock with it
  // — alive until pg_sleep finishes, which is 15 minutes of every other suite
  // waiting. Measured, not assumed: that is exactly what happened the first time
  // this was written.
  if (Number.isInteger(backendPid) && backendPid > 0) {
    try {
      execFileSync(
        'bash',
        ['scripts/psql.sh', '-q', '-tAX', '-c', `select pg_terminate_backend(${backendPid})`],
        { cwd: appDir, stdio: 'pipe', encoding: 'utf8' },
      )
    } catch {
      // Already gone, or the pooler recycled it. The next check will say.
    }
  }

  if (Number.isInteger(localPid) && localPid > 0) {
    try {
      process.kill(localPid)
    } catch {
      /* already exited */
    }
  }

  try {
    fs.rmSync(SEED_LOCK_PID_FILE)
  } catch {
    /* nothing to clean up */
  }
}

/**
 * After cleanup, say whether any surviving pwtest rows are ours.
 *
 * A row count on this database is not an answer on its own. An agent read 18
 * pwtest rows straight after a clean run and almost filed a teardown leak; the
 * rows were another worktree's run, mid-flight. The count was correct and the
 * conclusion was wrong.
 *
 * THE FIRST VERSION OF THIS ANSWERED BACKWARDS. It compared each row's
 * created_at against the mtime of e2e/.auth/password — but that file is written
 * BEFORE the seed, so every row this run creates is newer than it, and our own
 * leaked fixtures were reported as somebody else's. It failed in the normal case
 * rather than an edge case, and it hid exactly what it was added to find. It
 * also compared a database clock against a filesystem clock, read `max()` as if
 * it described every row, and inherited the previous crash's mtime when a run
 * died before writing its own.
 *
 * The lock answers it exactly and without clocks. We have just released ours, so
 * if the lock is free, nobody is running and anything left is ours. If it is
 * held, another suite has it and the rows are theirs.
 *
 * It READS pg_locks rather than calling pg_try_advisory_lock, and that
 * distinction is not stylistic. try_advisory_lock TAKES the lock when it is
 * free, and through the session pooler that backend outlives the psql that made
 * it — so a diagnostic here would leave the lock held and block the next suite
 * for as long as the pooler kept the session. That happened while this was being
 * written: a probe run by hand took the lock, and the next run's seed failed
 * waiting on it. A question about who holds a lock must not answer by taking it.
 *
 * Reports rather than throws. Another worktree running is normal and must not
 * fail our suite; a real leak already fails loudly above, when cleanup errors.
 */
function reportSurvivingRows() {
  let out: string
  try {
    out = execFileSync(
      'bash',
      [
        'scripts/psql.sh',
        '-q',
        '-tAX',
        '-c',
        // `and granted` is load-bearing: pg_locks also lists backends WAITING
        // for the lock. Without it a suite queued behind us counts as a holder,
        // and a real leak of ours gets reported as somebody else's rows — the
        // same inversion the mtime version had, arrived at from a different
        // direction.
        "select (select count(*) from public.members where nickname like 'pwtest%')" +
          " || ' ' || (select count(*) = 0 from pg_locks" +
          ` where locktype = 'advisory' and objid = ${LOCK_KEY} and granted)`,
      ],
      { cwd: appDir, stdio: 'pipe', encoding: 'utf8' },
    ).trim()
  } catch {
    return // The count is a courtesy; failing to read it is not a run failure.
  }

  const [countText, freeText] = out.split(' ')
  const count = Number(countText)
  if (!Number.isFinite(count) || count === 0) return

  // Taking it proves nobody else holds it. The lock dies with this psql, so
  // there is nothing to release.
  const nobodyElseIsRunning = freeText === 't'
  if (!nobodyElseIsRunning) {
    console.log(
      `e2e: ${count} pwtest rows remain and another suite holds the seed lock — ` +
        'they are that run’s. Not a leak, and not ours to delete.',
    )
    return
  }
  console.warn(
    `e2e: ${count} pwtest rows remain and no suite holds the seed lock, so they are OURS. ` +
      'This is a leak. Remove them with: npm run db:psql -- -f e2e/cleanup.sql',
  )
}

export default function globalTeardown() {
  try {
    execFileSync(
      'bash',
      ['scripts/psql.sh', '-v', 'ON_ERROR_STOP=1', '-q', '-f', 'e2e/cleanup.sql'],
      { cwd: appDir, stdio: 'pipe', encoding: 'utf8' },
    )
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string }
    throw new Error(
      'e2e cleanup FAILED — pwtest rows are still in the shared dev database, ' +
        'including an approved master_admin.\n' +
        'Remove them with: npm run db:psql -- -f e2e/cleanup.sql\n' +
        'The tests themselves may well have passed; this failure is about what was left behind.\n' +
        `${e.stderr ?? ''}${e.stdout ?? ''}`,
    )
  } finally {
    // FINALLY, because the throw above is the case that most needs it: a failed
    // cleanup that also kept the lock would leave the next suite waiting five
    // minutes and then failing, for a fault that was not theirs. Releasing here
    // costs the diagnosis nothing — the rows are still there to look at.
    releaseSeedLock()
  }

  // Cleanup succeeded, so anything still here belongs to somebody. Say who.
  reportSurvivingRows()
}
