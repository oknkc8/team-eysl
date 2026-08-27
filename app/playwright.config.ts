import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

/**
 * One port per worktree, derived from where this file sits.
 *
 * The port used to be the literal 4173 for everyone, and `reuseExistingServer`
 * then meant "reuse whatever is already on 4173" — which, with several agents
 * running suites out of sibling worktrees, is somebody else's build. It cost a
 * whole run to find: every board test failed at once against a bundle with no
 * /board routes, `페이지를 찾을 수 없습니다` on every screen, and the identical
 * code passed minutes later once the port was free. A suite that goes red
 * because of who else is working is worse than no suite, because the first
 * thing it teaches you is to distrust it.
 *
 * Derived rather than random, and from the path rather than the branch: the
 * same worktree gets the same port every run, so `reuseExistingServer` keeps
 * doing the thing it is for — skipping a 30-second rebuild between runs — while
 * never reaching a server that is not ours. A random port would fix the
 * collision and throw that away.
 *
 * EYSL_E2E_PORT overrides, for what this cannot foresee: two checkouts whose
 * paths happen to collide, or a port already taken by something else.
 * --strictPort on the preview command is what makes either case loud instead of
 * silently serving on the next port up.
 *
 * COLLISIONS ARE NOT DETECTED, and the span is sized on that basis. Two
 * worktrees whose paths hash to the same port would reuse each other's server
 * exactly as before — the bug this file exists to prevent, arriving silently,
 * because a Vite preview of one build is indistinguishable over HTTP from a
 * preview of another.
 *
 * So the only lever is making it rare, and the birthday maths is worse than it
 * looks: seven worktrees into a hundred slots is a 19.3% chance of some pair
 * sharing, and the seven that exist today landing distinct was luck rather than
 * design. A thousand slots takes those same seven to 2.1%. The range stops at
 * 5172, below Vite's dev default of 5173 and well below Postgres on 5432.
 *
 * If it ever does bite, the symptom is the familiar one — a whole suite failing
 * on catch-all timeouts — and EYSL_E2E_PORT is the way out.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url))
const PORT_FLOOR = 4173
const PORT_SPAN = 1000
const derivedPort =
  PORT_FLOOR +
  (parseInt(createHash('sha256').update(HERE).digest('hex').slice(0, 8), 16) % PORT_SPAN)

/**
 * The override, refused rather than coerced when it is not a port.
 *
 * `Number('')` is 0 and `Number('nope')` is NaN, and both would sail into the
 * preview command and produce a confusing failure a long way from the typo.
 */
function overridePort(raw: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error(
      `EYSL_E2E_PORT must be an integer between 1024 and 65535, got ${JSON.stringify(raw)}`,
    )
  }
  return value
}

export const PORT =
  process.env.EYSL_E2E_PORT === undefined ? derivedPort : overridePort(process.env.EYSL_E2E_PORT)
export const BASE_URL = `http://localhost:${PORT}`

/**
 * Proof that the server answering on PORT is serving OUR build.
 *
 * The derived port makes a collision unlikely; it does not make one detectable,
 * and `--strictPort` is no help because with `reuseExistingServer` Playwright
 * never runs the preview command at all when the URL already answers — so the
 * flag that was supposed to make a collision loud is not executed in the one
 * case that matters. Any server on this port is adopted: a colliding worktree's,
 * or something a developer left running yesterday.
 *
 * So the build writes this file and auth.setup.ts reads it back over HTTP. It
 * turns "silently testing someone else's bundle" — which reads as your own code
 * being broken — into one loud failure that names the other worktree.
 */
export const STAMP_PATH = '/eysl-e2e-stamp.txt'
export const STAMP_VALUE = HERE

/**
 * POSIX single-quoting: everything is literal inside '…', and the only thing
 * that cannot appear is a single quote, which is closed, escaped and reopened.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * Browser smoke coverage for the rewrite.
 *
 * The unit suite is 381 pure-function tests and never mounts a component, so
 * until this existed a screen could throw on mount and every gate stayed green.
 * These specs load each route in a real browser and check two things: that the
 * page painted something real, and that the console stayed quiet. The second is
 * the one that catches a screen which throws and still paints a shell.
 *
 * Deliberately outside `npm test`. The unit suite is fast and offline; this one
 * needs a browser, a build, and the dev database, so it runs as `npm run
 * test:e2e` and nothing else pulls it in.
 */
export default defineConfig({
  testDir: './e2e',
  // Seeds the pwtest accounts, then removes them, so a run leaves the shared dev
  // database exactly as it found it.
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  fullyParallel: true,
  // A stray `test.only` should fail the run rather than silently shrink it.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Four rather than one-per-core: every worker holds a browser and a Supabase
  // connection, and the database is shared with other agents' sessions.
  workers: process.env.CI ? 2 : 4,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // Korean UI: a mismatched locale changes how dates and numbers render, which
    // would make an assertion pass or fail for the wrong reason.
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
  },
  projects: [
    // Signs in each role once and writes its session to e2e/.auth/*.json, so the
    // thirty-odd smoke tests below cost one login apiece rather than one each.
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
      // The screenshot specs are not smoke tests and must not run here — they
      // exist to produce PNGs for a PR, and adding their cost to every suite run
      // is a tax on everyone for something only the author needs.
      testIgnore: /.*\.shots\.ts/,
    },
    {
      // Screenshots for PR bodies. Run with `npm run shots`, never by default:
      // it is NOT in the chromium project above and nothing depends on it.
      //
      // It reuses this file's globalSetup, so the pwtest fixtures and the
      // per-run password are seeded and torn down by the same machinery the
      // suite uses. That is the whole reason it lives here rather than in a
      // script of its own — a second way to seed would be a second thing to keep
      // correct, and this repository has paid for that lesson twice.
      name: 'screenshots',
      testMatch: /.*\.shots\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        // MOBILE, because the app is. A desktop viewport spends two thirds of
        // the frame on grey margin and shows the product smaller than a phone
        // does. 430x932 is an iPhone 14 Pro Max in CSS pixels.
        viewport: { width: 430, height: 932 },
        isMobile: false,
      },
      dependencies: ['setup'],
    },
  ],
  // `npm run dev` cannot start on this machine: fs.inotify.max_user_instances is
  // 128 and already exhausted, so vite's watcher gets EMFILE out of
  // inotify_init. Raising the limit needs root. `preview` is a static file
  // server with no watcher at all, so it sidesteps the limit entirely — and it
  // serves the built bundle, which is the artefact that actually ships.
  webServer: {
    // The stamp is written into dist/ after the build and before the server
    // starts, so anything answering on this port either serves our stamp or is
    // not us. Written here rather than in public/ because public/ is committed
    // and this value is per-worktree.
    // The value travels in the environment rather than in argv, and is quoted
    // for the SHELL rather than for JSON. JSON.stringify() escapes for a
    // JavaScript string literal — it leaves `$`, backticks and `\` untouched,
    // which a shell then expands. A worktree path containing any of those would
    // have produced a wrong stamp or run something nobody wrote. POSIX
    // single-quoting has one escape and this is it.
    command:
      `npm run build` +
      ` && EYSL_E2E_STAMP=${shellQuote(STAMP_VALUE)}` +
      ` node -e "require('fs').writeFileSync('dist${STAMP_PATH}', process.env.EYSL_E2E_STAMP)"` +
      ` && npm run preview -- --port ${PORT} --strictPort`,
    url: BASE_URL,
    // Safe again now that PORT is ours alone: this reuses OUR server between
    // runs and can no longer inherit a sibling worktree's.
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
