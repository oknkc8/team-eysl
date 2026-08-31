import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOCK_HOLD_SECONDS, LOCK_KEY, SEED_LOCK_PID_FILE } from './global-setup'
import { ownedSignupEnvironment, readOwnedSignups, resetOwnedSignups } from './ownedSignups'
import { FIXTURE_NS } from '../playwright.config'

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
type SeedLock = { localPid: number; backendPid: number; nonceKey: number }

/**
 * Every field is validated, localPid included.
 *
 * localPid used to be taken on trust while the other two were checked, and it is
 * the one that gets handed to process.kill() on this machine. A file left by a
 * crash an hour ago names a pid the OS has very likely reused by now, so the
 * unvalidated path could kill an unrelated local process — the same "a recorded
 * pid is not identity" mistake this file already fixed on the database side,
 * still live on the client side.
 */
function readSeedLock(): SeedLock | null {
  try {
    const [local, backend, nonce] = fs.readFileSync(SEED_LOCK_PID_FILE, 'utf8').trim().split(/\s+/)
    const lock = { localPid: Number(local), backendPid: Number(backend), nonceKey: Number(nonce) }
    if (
      !Number.isInteger(lock.localPid) ||
      lock.localPid <= 0 ||
      !Number.isInteger(lock.backendPid) ||
      !Number.isInteger(lock.nonceKey)
    ) {
      return null
    }
    return lock
  } catch {
    return null // Setup never got far enough to take it.
  }
}

/**
 * Is ANY session holding the shared seed key right now?
 *
 * Asked only when we have no pid file of our own, where the question is not
 * "is it ours" but "is anybody running at all". Deliberately ignores the nonce:
 * a run we cannot identify is exactly the case here.
 *
 * Returns true on error, because the failure has to be safe. Not knowing whether
 * somebody is running has to mean "do not delete", or this reintroduces the bug
 * it was added to close.
 */
// Deliberately gone: `sharedKeyHeldByAnyone()` used to answer "is anybody
// running" for the no-pid-file case. Asking it at all was the defect — the
// answer arrived on one connection and the delete went out on another, so it
// could only ever be true when it was read, not when it was acted on. The
// refusal in globalTeardown replaces it and needs no query.

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

/**
 * Returns true only if the shared key is provably no longer held by us.
 *
 * The caller has to know: a release that could not be confirmed leaves the next
 * run waiting on a lock nobody can name, and that is worth failing this run to
 * say out loud rather than exiting green.
 */
function releaseSeedLock(lock: SeedLock, verifiedBackendPid: number | null): boolean {
  let terminated = false
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
  //
  // THE PREDICATE TRAVELS WITH THE KILL. Passing a bare pid to
  // pg_terminate_backend meant the answer came from an earlier statement on an
  // earlier connection: true when it was asked, not necessarily true now. The
  // hold can lapse in that gap and the pooler can hand the backend to somebody
  // else, so the bare form could kill a stranger's work using a pid that was
  // ours a moment ago. Selecting the pid and terminating it in ONE statement
  // collapses that gap: a backend that has stopped holding both our keys is not
  // selected, so it is not signalled.
  //
  // NOT ZERO, AND WORTH SAYING SO. pg_locks reads live shared memory rather than
  // an MVCC snapshot, and the terminate runs per output row, so a backend could
  // in principle exit and have its pid reused between the scan and the signal.
  // What the one-statement form buys is the size of the window — from a round
  // trip across two connections down to the inside of a single statement — not
  // its elimination. The honest claim is "narrowed to where OS pid reuse would
  // have to land", not "closed".
  if (backendPid !== null && backendPid > 0) {
    const sql =
      'select pg_terminate_backend(l.pid) from pg_locks l' +
      " where l.locktype = 'advisory' and l.classid = 0 and l.objsubid = 1 and l.granted" +
      `   and l.objid = ${LOCK_KEY} and l.pid = ${backendPid}` +
      '   and exists (select 1 from pg_locks n' +
      `                where n.pid = l.pid and n.locktype = 'advisory' and n.classid = 0` +
      `                  and n.objsubid = 1 and n.granted and n.objid = ${lock.nonceKey})`
    // A FAILED TERMINATE IS NOT A RELEASE, AND USED TO BE TREATED AS ONE. The
    // catch below swallowed connection errors, and the code then went on to kill
    // the local psql and delete the pid file — leaving the pooled backend holding
    // the shared key with nothing left that could name it. That is the exact
    // state this file measured and documented twenty lines up: killing the client
    // does not release a pooled session's lock.
    //
    // Three outcomes, and only one of them is a failure:
    //   't'   the backend was ours and is now gone      -> released
    //   ''    nothing matched, so it is not holding      -> already released
    //   throw we could not ask                          -> UNKNOWN, assume held
    // The empty result is the ordinary "it expired on its own" case and must not
    // be confused with the error case, which is why the output is read rather
    // than the call merely being made.
    try {
      const out = execFileSync('bash', ['scripts/psql.sh', '-q', '-tAX', '-c', sql], {
        cwd: appDir,
        stdio: 'pipe',
        encoding: 'utf8',
      }).trim()
      terminated = out === 't' || out === ''
    } catch {
      // NOT "raced with its own expiry" — that case returns an empty result
      // above, not an exception. Reaching here means the question could not be
      // asked at all, so the backend may well still be holding the key.
      terminated = false
    }
  }

  // THE SAME RULE AS THE BACKEND, WHICH THIS DID NOT USED TO FOLLOW. A null
  // verifiedBackendPid means we could not prove the lock is still ours — and if
  // the backend is not ours, the local pid recorded beside it is no better. Our
  // psql exits when its pg_sleep returns, which is precisely how the hold lapses,
  // so on that path the recorded pid usually belongs to a process that ended and
  // an id the OS is free to have reused. Killing it was a coin flip on somebody
  // else's process, taken on the one path that had already concluded it knows
  // nothing.
  //
  // Format validation cannot help here: 12345 is a well-formed pid whoever owns
  // it. Only the lock answers ownership, and when it declines to, the answer is
  // to do nothing.
  // Gated on `terminated`, not merely on having had a pid. If the terminate
  // could not be confirmed, the local psql is the one thing still tying a name
  // to that backend — killing it discards the last handle on a lock we may still
  // be holding.
  if (terminated && Number.isInteger(localPid) && localPid > 0) {
    try {
      process.kill(localPid)
    } catch {
      /* already exited */
    }
  }

  // THE FILE OUTLIVES A FAILED RELEASE, ON PURPOSE. Removing it unconditionally
  // was the sharper half of the same defect as the local kill above: on the path
  // where ownership could not be verified — a lapsed hold, but equally a
  // transient query error, since heldBackendPid() collapses both to null — we
  // would terminate nothing, correctly, and then throw away the only record of
  // the backend that may still be holding the lock. A pooled backend outlives
  // its client, which this file proved the hard way; forgetting its pid leaves it
  // holding the shared key with nobody able to name it, and the next run waits
  // out LOCK_WAIT_MS for a holder it can no longer identify.
  //
  // Keeping it is safe because identity is checked, not assumed: a later
  // teardown reading a stale file asks heldBackendPid() for a backend holding
  // BOTH keys, and a stale nonce matches no current holder, so it refuses rather
  // than acting on the old pid. The cost of keeping it is a file to delete by
  // hand; the cost of removing it is an unnameable lock.
  // Widened from `backendPid === null` to "did not provably release". The
  // narrower test missed the case the fifth review found: a non-null pid whose
  // terminate FAILED. That path had a pid, so it deleted the record, and the
  // backend it could not kill went on holding the shared key anonymously.
  if (!terminated) return false

  try {
    fs.rmSync(SEED_LOCK_PID_FILE)
  } catch {
    /* nothing to clean up */
  }
  return true
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
        "select (select count(*) from public.members where nickname like 'pwtest" +
          FIXTURE_NS +
          "%')" +
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

  // NO PID FILE IS NOT PERMISSION TO DELETE. The guard above was gated on
  // `lock`, so a null lock fell straight past it into cleanup — which recreated,
  // through the one path that skips the check, exactly the bug this file exists
  // to prevent.
  //
  // The path is not hypothetical: a run that waits out LOCK_WAIT_MS and fails to
  // acquire never writes the pid file, and Playwright runs global teardown even
  // when global setup threw. So the run that lost the race would delete the
  // fixtures of the run that won it, mid-suite.
  //
  // AND THE ANSWER IS NOT "ASK WHETHER ANYONE ELSE HOLDS IT". That was the first
  // fix here, and it kept the defect in a smaller shape: the question ran on one
  // connection and the delete on another, so a run that answered "nobody" and
  // then lost the race deleted the winner's fixtures anyway — with the
  // after-the-fact check disabled on that very path, because it was written as
  // `lock !== null && …`. It deleted and could not even tell you.
  //
  // There is no case where a run that does not hold the lock should delete. If we
  // never acquired, we never seeded, so nothing here is ours whether or not
  // anybody else is running right now. Refusing outright removes the gap rather
  // than narrowing it — the same move as taking the nonce before the shared key,
  // and for the same reason: a state that cannot be reached needs no argument
  // about how likely it is.
  if (!lock) {
    throw new Error(
      'e2e: this run cannot prove it holds the seed lock, so nothing was removed.\n' +
        'No usable lock record was found. Either setup never acquired one, or the record was ' +
        'unreadable — readSeedLock() returns null for a missing file and for a malformed one ' +
        'alike, and this refusal deliberately does not guess which.\n' +
        'Either way this run cannot show that any row here is its own.\n' +
        'Any pwtest rows belong to a run that is still going, or are a leak from an older one.\n' +
        'Once you are certain nothing is running: npm run db:psql -- -f e2e/cleanup.sql',
    )
  }

  // The ledger is the only authority for test-created signup accounts. A bad
  // local record is a safe failure: release our lock, leave every database row
  // intact, and require repair rather than falling back to a name predicate.
  let ownedSignupEnv: Record<string, string>
  try {
    ownedSignupEnv = ownedSignupEnvironment(readOwnedSignups())
  } catch (error) {
    releaseSeedLock(lock, heldPid)
    throw error
  }

  // Checked again AFTER cleanup, while the lock is still held, because the check
  // above and the delete below are separate statements on separate connections
  // and the hold can lapse between them.
  //
  // THIS DETECTS, IT DOES NOT PREVENT. Closing the race outright would mean
  // running cleanup.sql on the holder's own session, so the delete cannot
  // outlive the lock that authorises it — the honest fix, and a larger change
  // than this PR should make while it is under review. What this buys is that
  // the survivor finds out: without it, deleting a live run's fixtures is
  // silent and the symptom lands on them with no way back to the cause.
  let lostLockDuringCleanup = false
  // Seeded with the pre-cleanup answer so the `finally` has something usable if
  // cleanup throws before the re-check runs.
  let postCleanupHeldPid: number | null = heldPid
  let released = false
  try {
    execFileSync(
      'bash',
      ['scripts/psql.sh', '-v', 'ON_ERROR_STOP=1', '-q', '-f', 'e2e/cleanup.sql'],
      // The same namespace the seed used. Without it cleanup.sql refuses, which
      // is the point: a cleanup that ran with an empty namespace would delete by
      // the old shared ids and take other worktrees' fixtures with it.
      {
        cwd: appDir,
        stdio: 'pipe',
        encoding: 'utf8',
        env: { ...process.env, PWTEST_NS: FIXTURE_NS, ...ownedSignupEnv },
      },
    )
    // No `lock !== null` guard: the refusal above makes that unreachable. It used
    // to be here, and it was the reason the one path that wrongly deleted was
    // also the one path that could not report it.
    postCleanupHeldPid = heldBackendPid(lock)
    lostLockDuringCleanup = postCleanupHeldPid === null
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
    //
    // The POST-cleanup answer, not the pre-cleanup one. We re-ask who holds the
    // lock immediately after cleanup and then used to throw that answer away,
    // releasing against a reading from before the delete. Passing the fresh one
    // means a hold that lapsed during cleanup arrives here as null, which
    // terminates nothing — the correct action for a backend that is no longer
    // ours.
    released = releaseSeedLock(lock, postCleanupHeldPid)
  }

  // A release we could not confirm fails the run. Exiting green here is what
  // would strand the next suite: it waits out LOCK_WAIT_MS on a key whose holder
  // nobody can name, and the fault would look like theirs.
  if (!released) {
    throw new Error(
      'e2e: the seed lock could not be provably released, so this run is failing rather than ' +
        'reporting success.\n' +
        'Terminating the holding backend either failed or could not be attempted, and killing ' +
        'the local psql does NOT release a pooled session lock.\n' +
        `The lock record was kept at ${SEED_LOCK_PID_FILE} so the backend can still be named:\n` +
        `  <localPid> <backendPid> <nonceKey> — terminate it with ` +
        `select pg_terminate_backend(<backendPid>)\n` +
        'Until it is gone or its pg_sleep expires, the next run will wait and then fail.',
    )
  }

  if (lostLockDuringCleanup) {
    throw new Error(
      'e2e: the seed lock lapsed WHILE cleanup was running, so the rows just deleted may have ' +
        'belonged to another run rather than this one.\n' +
        'This run held the lock when teardown began and no longer held it when cleanup ' +
        `finished, which means the suite outran LOCK_HOLD_SECONDS (${LOCK_HOLD_SECONDS}s) and ` +
        'another run may have seeded in the gap.\n' +
        'If a suite is running elsewhere, expect it to fail with missing fixtures — it is this ' +
        'run that broke it, not their change. Re-seed and re-run that suite.',
    )
  }

  // A normal teardown consumed every recorded id. Keep the ledger only when a
  // run crashes or cleanup refuses, so the next seed can safely retry it.
  resetOwnedSignups()

  // Cleanup succeeded, so anything still here belongs to somebody. Say who.
  reportSurvivingRows()
}
