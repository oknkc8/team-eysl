import { test as setup } from '@playwright/test'
import { STATE, signIn } from './fixtures'

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
