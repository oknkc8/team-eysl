import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ledgerDir = path.join(here, '.auth', 'owned-signups')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type OwnedSignup = {
  authUserId: string
  memberId: string
}

function assertOwnedSignup(value: unknown, source: string): asserts value is OwnedSignup {
  if (
    !value ||
    typeof value !== 'object' ||
    !UUID.test((value as OwnedSignup).authUserId) ||
    !UUID.test((value as OwnedSignup).memberId)
  ) {
    throw new Error(`e2e: invalid owned-signup ledger entry in ${source}; refusing cleanup.`)
  }
}

/**
 * The test-owned signup rows are deliberately recorded by ids, never inferred
 * from a nickname or email. A person is allowed to choose any valid nickname;
 * cleanup is not allowed to decide that makes their history disposable.
 */
export function recordOwnedSignup(signup: OwnedSignup) {
  assertOwnedSignup(signup, 'memory')
  fs.mkdirSync(ledgerDir, { recursive: true })
  fs.writeFileSync(path.join(ledgerDir, `${signup.authUserId}.json`), JSON.stringify(signup), {
    encoding: 'utf8',
    mode: 0o600,
  })
}

/** Read every known record, or fail before SQL can delete anything. */
export function readOwnedSignups(): OwnedSignup[] {
  if (!fs.existsSync(ledgerDir)) return []
  const seen = new Map<string, OwnedSignup>()
  for (const name of fs.readdirSync(ledgerDir).sort()) {
    if (!name.endsWith('.json')) continue
    const source = path.join(ledgerDir, name)
    const value = JSON.parse(fs.readFileSync(source, 'utf8')) as unknown
    assertOwnedSignup(value, source)
    const signup = value as OwnedSignup
    if (path.basename(name, '.json') !== signup.authUserId) {
      throw new Error(`e2e: owned-signup ledger filename disagrees with ${source}; refusing cleanup.`)
    }
    seen.set(signup.authUserId, signup)
  }
  return [...seen.values()]
}

/** Start a fresh run only after the previous records were passed to cleanup. */
export function resetOwnedSignups() {
  fs.rmSync(ledgerDir, { force: true, recursive: true })
  fs.mkdirSync(ledgerDir, { recursive: true })
}

export function ownedSignupEnvironment(signups: OwnedSignup[]): Record<string, string> {
  return {
    PWTEST_OWNED_SIGNUP_MEMBER_IDS: signups.map(({ memberId }) => memberId).join(','),
    PWTEST_OWNED_SIGNUP_AUTH_IDS: signups.map(({ authUserId }) => authUserId).join(','),
  }
}
