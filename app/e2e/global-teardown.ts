import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PASSWORD_FILE } from './runPassword'

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
 * After cleanup, say whether any surviving pwtest rows are ours.
 *
 * A row count on this database is not an answer on its own. An agent read 18
 * pwtest rows straight after a clean run and almost filed a teardown leak; the
 * rows were another worktree's run, mid-flight. The count was correct and the
 * conclusion was wrong, and every "left the database at 0" any of us reported
 * today was true by luck rather than by checking.
 *
 * The marker needs no column and no migration: generateRunPassword() writes
 * e2e/.auth/password at the start of THIS run, so its mtime is the moment we
 * seeded. A pwtest member created after that cannot be ours — nothing else in
 * this run creates one. Older or equal, and it is ours and did leak.
 *
 * Reports rather than throws. Another worktree running is normal and must not
 * fail our suite; a real leak already fails loudly above, when cleanup errors.
 */
function reportSurvivingRows() {
  let seededAt: number
  try {
    seededAt = fs.statSync(PASSWORD_FILE).mtimeMs
  } catch {
    return // No password file, so no run of ours to compare against.
  }

  let out: string
  try {
    out = execFileSync(
      'bash',
      [
        'scripts/psql.sh',
        '-q',
        '-tAX',
        '-c',
        "select count(*) || ' ' || coalesce(extract(epoch from max(created_at)) * 1000, 0) " +
          "from public.members where nickname like 'pwtest%'",
      ],
      { cwd: appDir, stdio: 'pipe', encoding: 'utf8' },
    ).trim()
  } catch {
    return // The count is a courtesy; failing to read it is not a run failure.
  }

  const [countText, newestText] = out.split(' ')
  const count = Number(countText)
  if (!Number.isFinite(count) || count === 0) return

  const newestMs = Number(newestText)
  if (Number.isFinite(newestMs) && newestMs > seededAt) {
    console.log(
      `e2e: ${count} pwtest rows remain, all newer than this run's seed — ` +
        'another worktree is mid-run. Not a leak, and not ours to delete.',
    )
    return
  }
  console.warn(
    `e2e: ${count} pwtest rows remain and predate this run's seed, so they are OURS. ` +
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
  }

  // Cleanup succeeded, so anything still here belongs to somebody. Say who.
  reportSurvivingRows()
}
