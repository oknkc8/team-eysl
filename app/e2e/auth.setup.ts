import { test as setup } from '@playwright/test'
import { STATE, signIn } from './fixtures'
import { STAMP_PATH, STAMP_VALUE } from '../playwright.config'

/**
 * Signs each seeded role in once and saves its session, so the smoke suite pays
 * for three logins rather than one per test.
 *
 * `signIn` waits only for the URL to leave /login, never for a screen to
 * render — which matters here. pwtestadmin holds a perfectly valid session and
 * still cannot load any screen (flows.spec.ts, "staff cannot load their own
 * member row"). Waiting for content would hang this file on that bug and take
 * the whole suite down with it, instead of letting the one test that names the
 * bug report it.
 */

/**
 * Refuse to test a server that is not ours. This runs before every login.
 *
 * The derived port makes a collision unlikely and undetectable; this makes it
 * detectable. `reuseExistingServer` adopts whatever answers on the port without
 * running the preview command, so `--strictPort` never executes and a colliding
 * worktree's server — or anything a developer left running — is used silently.
 * The symptom is every test failing on catch-all timeouts, which reads as your
 * own code being broken.
 *
 * The failure names the other path, because "wrong server" is not something
 * anyone guesses from a wall of timeouts.
 */
setup('the server on this port is our build', async ({ baseURL }) => {
  const response = await fetch(`${baseURL}${STAMP_PATH}`)
  // Strips ONLY the trailing newline the stamp is written with, where a .trim()
  // would also eat trailing whitespace that is part of the path. A directory
  // named with a trailing space is legal and git will happily make a worktree
  // there, and under .trim() such a build fails to recognise itself — the check
  // rejecting the very tree it was meant to confirm.
  const raw = response.ok ? await response.text() : ''
  const served = raw.replace(/\r?\n$/, '')
  if (served === STAMP_VALUE) return

  // A single-page app answers 200 with index.html for any unknown path, so a
  // build without the stamp looks like a successful fetch of HTML rather than a
  // 404. Saying that plainly beats printing a doctype at somebody.
  const shown = served.trim()
  const describe = shown.startsWith('<')
    ? "(that server's index.html — its build predates this check, so it is not ours)"
    : shown || `(no ${STAMP_PATH}, HTTP ${response.status})`

  throw new Error(
    `${baseURL} is not serving this worktree's build.\n` +
      `  expected: ${STAMP_VALUE}\n` +
      `  serving : ${describe}\n` +
      'Another worktree derived the same port, or a stale server is still up. ' +
      'Set EYSL_E2E_PORT to something free, or stop the other server.',
  )
})

setup('authenticate as 총관리자', async ({ page }) => {
  await signIn(page, 'pwtestadmin')
  await page.context().storageState({ path: STATE.admin })
})

setup('authenticate as 일반회원', async ({ page }) => {
  await signIn(page, 'pwtestmember')
  await page.context().storageState({ path: STATE.member })
})

setup('authenticate as 두 번째 일반회원', async ({ page }) => {
  await signIn(page, 'pwtestmember2')
  await page.context().storageState({ path: STATE.member2 })
})

setup('authenticate as 승인 대기 회원', async ({ page }) => {
  await signIn(page, 'pwtestpending')
  await page.context().storageState({ path: STATE.pending })
})

// The other two ways to hold a valid token and no membership. RequireAuth sends
// all three to /pending, so `signIn` completes for them exactly as it does above
// — it waits for the URL to leave /login, not for a screen the app will never
// give them.
setup('authenticate as 거절된 회원', async ({ page }) => {
  await signIn(page, 'pwtestrejected')
  await page.context().storageState({ path: STATE.rejected })
})

setup('authenticate as 내보내진 회원', async ({ page }) => {
  await signIn(page, 'pwtestblocked')
  await page.context().storageState({ path: STATE.blocked })
})
