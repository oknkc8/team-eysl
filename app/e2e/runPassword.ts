import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The password the seeded pwtest accounts get, generated fresh for every run.
 *
 * It used to be the literal `pwtest-password-1`, written in fixtures.ts and
 * again in seed.sql. THIS REPOSITORY IS PUBLIC, and seed.sql creates a
 * master_admin — so between them those two lines published working administrator
 * credentials for whatever database the suite last pointed at. The account is
 * meant to be removed at teardown, but a teardown that failed used to be a
 * console warning, which is how a run could leave one standing and say nothing.
 *
 * Generating per run means a leftover account is a dead account: the value that
 * would open it existed only in one process and one git-ignored file, and the
 * next run overwrites that file with a different one.
 */

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * Beside the stored sessions, and git-ignored by the same rule that covers them
 * (`.gitignore`: "app/e2e/.auth/"). Sessions and this file are the same kind of
 * thing — short-lived credentials for our dev project — so they live together
 * rather than inventing a second ignored path to remember.
 */
export const PASSWORD_FILE = path.join(here, '.auth', 'password')

/**
 * A new password, written where the workers can find it.
 *
 * 24 random bytes rather than a memorable string: nobody types this, so the only
 * thing length costs is nothing. base64url keeps it free of the quoting hazards
 * a password crosses on its way to psql and to a browser form.
 *
 * The `pwtest` prefix is not decoration — it means a value that escapes into a
 * log is recognisable as test scaffolding rather than someone's real password.
 * Length stays well inside register_member_v1's 72-BYTE bcrypt ceiling and well
 * past its 8-character floor.
 */
export function generateRunPassword(): string {
  const password = `pwtest-${randomBytes(24).toString('base64url')}`
  fs.mkdirSync(path.dirname(PASSWORD_FILE), { recursive: true })
  // 0600 because this is a credential, and the default would be world-readable
  // on a shared machine.
  fs.writeFileSync(PASSWORD_FILE, password, { encoding: 'utf8', mode: 0o600 })
  return password
}

/**
 * The current run's password, for the worker processes.
 *
 * Playwright runs globalSetup in one process and the specs in others, so this is
 * read from disk rather than passed in memory. A missing file means the specs
 * were started without the setup that seeds their accounts — worth saying
 * plainly, because the alternative symptom is every login failing with "invalid
 * credentials" and nothing pointing at the cause.
 */
export function readRunPassword(): string {
  try {
    return fs.readFileSync(PASSWORD_FILE, 'utf8').trim()
  } catch {
    throw new Error(
      `No run password at ${PASSWORD_FILE}. These specs need the seeded accounts, ` +
        'so run them with `npm run test:e2e` rather than calling playwright directly.',
    )
  }
}
