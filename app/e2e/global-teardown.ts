import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Removes everything global-setup created.
 *
 * Failing here must not fail the run: the tests have already finished by this
 * point, and turning a cleanup hiccup into a red suite would hide whatever they
 * actually found. It warns loudly instead, because the dev database is shared
 * and a leftover pwtest row is somebody else's confusing afternoon.
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
    console.warn(
      '\n[e2e] cleanup failed — pwtest rows may still be in the shared dev database.\n' +
        'Remove them with: npm run db:psql -- -f e2e/cleanup.sql\n' +
        `${e.stderr ?? ''}${e.stdout ?? ''}`,
    )
  }
}
