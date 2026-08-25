import { test as base, expect, type Page } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Where auth.setup.ts parks each role's session. Git-ignored. */
export const STATE = {
  admin: path.join(here, '.auth', 'admin.json'),
  member: path.join(here, '.auth', 'member.json'),
  pending: path.join(here, '.auth', 'pending.json'),
}

export const PASSWORD = 'pwtest-password-1'

/** Ids seed.sql pins, so the route table can name them literally. */
export const SEED = {
  adminMemberId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  memberMemberId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  pendingMemberId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  noticeId: '11111111-1111-4111-8111-111111111111',
  activityId: '22222222-2222-4222-8222-222222222222',
  folderId: '33333333-3333-4333-8333-333333333333',
  noticeTitle: 'pwtest 공지 제목',
  activityTitle: 'pwtest 훈련',
  folderName: 'pwtest 폴더',
}

/** A syntactically valid uuid that no row uses, for the not-found branches. */
export const MISSING_UUID = '00000000-0000-4000-8000-000000000000'

/**
 * Console noise that is not the app's fault and would otherwise fail every test.
 *
 * Kept deliberately short. The whole value of the console assertion is that it
 * catches a screen which throws and still paints a shell, and every pattern
 * added here is a class of error the suite stops being able to see.
 */
const IGNORED_CONSOLE = [
  // vite-plugin-pwa registers a worker; over plain http the browser declines it
  // in ways that vary by Chromium build and say nothing about the app.
  /ServiceWorker/i,
  /sw\.js/i,
  // No favicon is served in preview.
  /favicon\.ico/i,
  // React Router's advisories about the next major version.
  /React Router Future Flag/i,
]

const isNoise = (text: string) => IGNORED_CONSOLE.some((re) => re.test(text))

export type ConsoleWatcher = {
  /** Errors seen so far, in order. */
  errors: string[]
}

/**
 * `page`, with every console error and uncaught exception recorded.
 *
 * Attached before the first navigation, because a screen that throws during
 * mount does so before any `page.goto()` resolves.
 */
export const test = base.extend<{ consoleWatcher: ConsoleWatcher }>({
  consoleWatcher: async ({ page }, use) => {
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return
      const text = msg.text()
      if (!isNoise(text)) errors.push(`console.error: ${text}`)
    })
    page.on('pageerror', (err) => {
      if (!isNoise(err.message)) errors.push(`uncaught: ${err.message}`)
    })
    await use({ errors })
  },
})

export { expect }

/**
 * Wait for a screen to settle out of its loading state.
 *
 * Every page paints `불러오는 중…` (route guards) or a shimmer (data sections)
 * first, so asserting straight after `goto` tests the spinner rather than the
 * screen.
 *
 * `h1` alone is not enough. A screen whose data fails to load renders its
 * AsyncSection error in place of the heading — NoticeDetailPage on a missing id
 * shows `공지를 불러오지 못했습니다` inside a role=alert and no h1 at all. That
 * is a settled state, not a hang, so the wait has to accept it or the suite
 * reports a working error path as a timeout.
 */
export async function waitForScreen(page: Page) {
  await page
    .locator('h1, [role="alert"]')
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 })
}

/**
 * Sign in through the real form, the way a member does.
 *
 * Deliberately not a direct call to the Supabase client: the login screen is
 * itself one of the things under test, and a helper that bypassed it would let
 * the form break without a single test noticing.
 */
export async function signIn(page: Page, nickname: string) {
  await page.goto('/login')
  await page.getByLabel('닉네임').fill(nickname)
  await page.getByLabel('비밀번호').fill(PASSWORD)
  await page.getByRole('button', { name: '로그인' }).click()
  // Leaving /login is the signal that Supabase accepted the credentials — not
  // "the home screen rendered". A session can be valid while the screen behind
  // it never loads, which is exactly what flows.spec.ts pins down.
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 })
}
