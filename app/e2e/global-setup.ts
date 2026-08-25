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
export default function globalSetup() {
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
