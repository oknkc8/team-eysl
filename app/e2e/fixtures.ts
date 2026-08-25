import { test as base, expect, type Browser, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BASE_URL } from '../playwright.config'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Where auth.setup.ts parks each role's session. Git-ignored. */
export const STATE = {
  admin: path.join(here, '.auth', 'admin.json'),
  member: path.join(here, '.auth', 'member.json'),
  member2: path.join(here, '.auth', 'member2.json'),
  pending: path.join(here, '.auth', 'pending.json'),
}

export const PASSWORD = 'pwtest-password-1'

/** Ids seed.sql pins, so the route table can name them literally. */
export const SEED = {
  adminMemberId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  memberMemberId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  pendingMemberId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  member2MemberId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  noticeId: '11111111-1111-4111-8111-111111111111',
  activityId: '22222222-2222-4222-8222-222222222222',
  folderId: '33333333-3333-4333-8333-333333333333',
  // One fixture per write test — see the block at the foot of seed.sql for why
  // they are not shared.
  capacityOneActivityId: '44444444-4444-4444-8444-444444444444',
  attendanceActivityId: '55555555-5555-4555-8555-555555555555',
  commentNoticeId: '66666666-6666-4666-8666-666666666666',
  noticeTitle: 'pwtest 공지 제목',
  activityTitle: 'pwtest 훈련',
  folderName: 'pwtest 폴더',
  capacityOneActivityTitle: 'pwtest 정원1 훈련',
  attendanceActivityTitle: 'pwtest 출석 훈련',
  commentNoticeTitle: 'pwtest 댓글 공지',
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
 * Record every console error and uncaught exception on one page.
 *
 * Split out of the fixture below so the two-writer tests can watch their second
 * browser too. A concurrency bug that throws is most likely to throw on the
 * side that loses the race, and that side is never the fixture's `page`.
 */
export function watchConsole(page: Page): ConsoleWatcher {
  const errors: string[] = []
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    const text = msg.text()
    if (!isNoise(text)) errors.push(`console.error: ${text}`)
  })
  page.on('pageerror', (err) => {
    if (!isNoise(err.message)) errors.push(`uncaught: ${err.message}`)
  })
  return { errors }
}

/**
 * `page`, with every console error and uncaught exception recorded.
 *
 * Attached before the first navigation, because a screen that throws during
 * mount does so before any `page.goto()` resolves.
 */
export const test = base.extend<{ consoleWatcher: ConsoleWatcher }>({
  consoleWatcher: async ({ page }, use) => {
    await use(watchConsole(page))
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

// ---------------------------------------------------------------------------
// A second person in the room.
// ---------------------------------------------------------------------------

export type Actor = {
  page: Page
  console: ConsoleWatcher
  /** Closes the browser context. Always call it, or the run leaks a browser. */
  close: () => Promise<void>
}

/**
 * A second signed-in browser, for the tests that need two people at once.
 *
 * `test.use({ storageState })` gives a spec one session, and the two bugs this
 * suite exists to catch — comments overwriting each other, two people taking one
 * seat — are only visible with two. Playwright's own `page` stays whoever the
 * describe block chose; this is the other party.
 *
 * baseURL, locale and timezone are passed explicitly because a context built by
 * hand inherits none of `use` from playwright.config.ts. Without the locale the
 * dates on screen render in the runner's locale and an assertion about what a
 * Korean member sees would be testing the wrong string.
 */
export async function openAs(browser: Browser, storageState: string): Promise<Actor> {
  const context = await browser.newContext({
    storageState,
    baseURL: BASE_URL,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
  })
  const page = await context.newPage()
  // Attached before the first navigation, same reason as the fixture.
  const watcher = watchConsole(page)
  return { page, console: watcher, close: () => context.close() }
}

// ---------------------------------------------------------------------------
// Asking the database directly, as the person whose browser is open.
// ---------------------------------------------------------------------------

/**
 * The two values the app itself is built with, read from the same .env the dev
 * server used.
 *
 * Needed because the refusal tests have to make a request the UI never offers —
 * that is the point of them — and a request from the member's browser needs the
 * publishable key the client normally supplies. The key is public by Supabase's
 * design and access control is RLS, so reading it here grants nothing; it is in
 * .env rather than in this file only because .env is git-ignored and the
 * repository is public.
 */
function readAppEnv(): { url: string; key: string } {
  const envPath = path.resolve(here, '..', '.env')
  let text: string
  try {
    text = fs.readFileSync(envPath, 'utf8')
  } catch {
    throw new Error(`e2e: ${envPath} not found. Copy .env.example and fill it in.`)
  }

  const values = new Map<string, string>()
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (!match || match[1] === undefined || match[2] === undefined) continue
    values.set(match[1], match[2].trim().replace(/^["']|["']$/g, ''))
  }

  const url = values.get('VITE_SUPABASE_URL')
  const key = values.get('VITE_SUPABASE_PUBLISHABLE_KEY')
  if (!url || !key) {
    throw new Error('e2e: .env is missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY.')
  }
  return { url, key }
}

export const APP_ENV = readAppEnv()

export type DirectResponse = { status: number; body: string }

/**
 * Send a request to Supabase from inside a signed-in page, with that page's own
 * session.
 *
 * Every refusal test needs this. A screen that hides a button proves only that
 * the button is hidden; whether the write behind it would be refused is a
 * separate question, and the only honest way to ask it is to make the request
 * the hidden button would have made and see what comes back. Run from the page
 * rather than from node so the token is the live one the member is actually
 * using, not a copy from a storage-state file written minutes earlier.
 *
 * Returns the status and raw body rather than throwing, because a refusal is the
 * expected outcome here and the test wants to assert on its shape.
 */
export async function directRequest(
  page: Page,
  init: { path: string; method?: string; body?: unknown; headers?: Record<string, string> },
): Promise<DirectResponse> {
  return page.evaluate(
    async ({ base, key, req }) => {
      // supabase-js stores the session under sb-<project ref>-auth-token. Read
      // rather than reconstructed: a token this test minted would be testing the
      // test, and the whole claim is about the session the member holds.
      const storageKey = Object.keys(localStorage).find(
        (k) => k.startsWith('sb-') && k.endsWith('-auth-token'),
      )
      if (!storageKey) throw new Error('no supabase session in localStorage')
      const raw = localStorage.getItem(storageKey)
      if (!raw) throw new Error('supabase session key present but empty')
      const token = (JSON.parse(raw) as { access_token?: string }).access_token
      if (!token) throw new Error('supabase session has no access_token')

      const response = await fetch(`${base}${req.path}`, {
        method: req.method ?? 'GET',
        headers: {
          apikey: key,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          // Ask for the affected rows back. Without it an UPDATE that matched
          // nothing and an UPDATE that matched everything both answer 204, and
          // the two are the entire question.
          Prefer: 'return=representation',
          ...req.headers,
        },
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
      })
      return { status: response.status, body: await response.text() }
    },
    { base: APP_ENV.url, key: APP_ENV.key, req: init },
  )
}
