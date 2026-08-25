import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
}
