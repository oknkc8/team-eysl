import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Puts the three pwtest accounts and their content fixtures into the dev
 * database before any browser starts.
 *
 * Runs the SQL through scripts/psql.sh rather than through the Supabase client,
 * because the accounts cannot be created any other way: the rewrite has no
 * signup screen yet, and creating an auth user through the API needs the service
 * role key, which is not in .env and has no business being there.
 *
 * ON_ERROR_STOP is what turns a failed seed into a failed run. Without it psql
 * reports the error and exits 0, and the suite would then fail one test at a
 * time with "no such member" instead of once, here, with the real reason.
 */
export default function globalSetup() {
  try {
    execFileSync('bash', ['scripts/psql.sh', '-v', 'ON_ERROR_STOP=1', '-q', '-f', 'e2e/seed.sql'], {
      cwd: appDir,
      stdio: 'pipe',
      encoding: 'utf8',
    })
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string }
    throw new Error(
      'e2e seed failed. The dev database has to be reachable for these tests.\n' +
        `${e.stderr ?? ''}${e.stdout ?? ''}`,
    )
  }
}
