import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOCK_HOLD_SECONDS, LOCK_KEY, SEED_LOCK_PID_FILE } from './global-setup'

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
type SeedLock = { localPid: number; backendPid: number; nonceKey: number }

function readSeedLock(): SeedLock | null {
  try {
    const [local, backend, nonce] = fs.readFileSync(SEED_LOCK_PID_FILE, 'utf8').trim().split(/\s+/)
    const lock = { localPid: Number(local), backendPid: Number(backend), nonceKey: Number(nonce) }
    if (!Number.isInteger(lock.backendPid) || !Number.isInteger(lock.nonceKey)) return null
    return lock
  } catch {
    return null // Setup never got far enough to take it.
  }
}

/**
 * The backend holding BOTH our keys, or null if we no longer hold the lock.
 *
 * This is the question the two review findings were both answering by
 * inference. "We took it and have not finished" is not a fact about now:
 * LOCK_HOLD_SECONDS may have fired and the holder exited, in which case another
 * run legitimately owns the fixtures. And a recorded pid is not identity either,
 * because the pooler recycles backends — that pid may since have become somebody
 * else's work, and the shared key alone cannot tell us apart from the next run,
 * which holds exactly the same key.
 *
 * Both keys together can only be held by one session, so this is a check rather
 * than a belief. Which is the whole reason this PR replaced the age heuristic —
 * it would be a poor joke to use the lock and then go on guessing.
 *
 * classid and objsubid are matched as well as objid: the bigint form of
 * pg_advisory_lock stores the key as classid 0 / objsubid 1, and the two-int
 * form uses objsubid 2, so objid alone could collide with an unrelated lock.
 */
function heldBackendPid(lock: SeedLock): number | null {
  const sql =
    'select coalesce((select l.pid from pg_locks l' +
    " where l.locktype = 'advisory' and l.classid = 0 and l.objsubid = 1 and l.granted" +
    `   and l.objid = ${LOCK_KEY}` +
    '   and exists (select 1 from pg_locks n' +
    `                where n.pid = l.pid and n.locktype = 'advisory' and n.classid = 0` +
    `                  and n.objsubid = 1 and n.granted and n.objid = ${lock.nonceKey})` +
    ' limit 1), 0)'
  try {
    const out = execFileSync('bash', ['scripts/psql.sh', '-q', '-tAX', '-c', sql], {
      cwd: appDir,
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim()
    const pid = Number(out)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function releaseSeedLock(lock: SeedLock, verifiedBackendPid: number | null) {
  const { localPid } = lock
  const backendPid = verifiedBackendPid

  // The backend first, because it is the thing that owns the lock. Killing only
  // the local client leaves the pooler's backend — and the session lock with it
  // — alive until pg_sleep finishes, which is 15 minutes of every other suite
  // waiting. Measured, not assumed: that is exactly what happened the first time
  // this was written.
  //
  // NULL MEANS TERMINATE NOTHING, deliberately. It says we no longer hold the
  // lock, so the pid we recorded is no longer proof of anything — the pooler may
  // have handed it to somebody else's work, and killing it would take a stranger
  // down. Only a pid that just answered "holds both our keys" is ours to end.
  if (backendPid !== null && backendPid > 0) {
    try {
      execFileSync(
        'bash',
        ['scripts/psql.sh', '-q', '-tAX', '-c', `select pg_terminate_backend(${backendPid})`],
        { cwd: appDir, stdio: 'pipe', encoding: 'utf8' },
      )
    } catch {
      // Raced with its own expiry between the check and here. Nothing to do:
      // the lock is gone either way, which is the outcome we wanted.
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
        // classid and objsubid alongside objid: the bigint form of
        // pg_advisory_lock stores its key as classid 0 / objsubid 1, and the
        // two-int form uses objsubid 2 — so objid on its own could match an
        // unrelated advisory lock that happens to share the low half.
        "select (select count(*) from public.members where nickname like 'pwtest%')" +
          " || ' ' || (select count(*) = 0 from pg_locks" +
          ` where locktype = 'advisory' and classid = 0 and objsubid = 1` +
          ` and objid = ${LOCK_KEY} and granted)`,
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
  const lock = readSeedLock()
  // Asked BEFORE cleanup, because cleanup deletes fixed ids and cannot tell our
  // fixtures from the fixtures of whoever legitimately took the lock after ours
  // expired. If a suite outlives LOCK_HOLD_SECONDS, the next run seeds and then
  // this teardown would delete THEIR accounts mid-suite — silently, and the
  // symptom would land on them rather than on us.
  //
  // Expiry is not the defect; deleting without re-checking is. One question
  // turns it into a failure somebody can see.
  const heldPid = lock ? heldBackendPid(lock) : null

  if (lock && heldPid === null) {
    releaseSeedLock(lock, null)
    throw new Error(
      'e2e: this run no longer holds the seed lock, so its fixtures were NOT removed.\n' +
        `The holder expired after ${LOCK_HOLD_SECONDS}s (the suite ran longer than that), or it ` +
        'was terminated. Another run may own the pwtest rows now, and deleting them would break ' +
        'that run instead.\n' +
        'Remove them by hand once nothing is running: npm run db:psql -- -f e2e/cleanup.sql',
    )
  }

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
    if (lock) releaseSeedLock(lock, heldPid)
  }

  // Cleanup succeeded, so anything still here belongs to somebody. Say who.
  reportSurvivingRows()
}
