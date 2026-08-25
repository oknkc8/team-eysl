import { defineConfig, devices } from '@playwright/test'

export const BASE_URL = 'http://localhost:4173'

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
    },
  ],
  // `npm run dev` cannot start on this machine: fs.inotify.max_user_instances is
  // 128 and already exhausted, so vite's watcher gets EMFILE out of
  // inotify_init. Raising the limit needs root. `preview` is a static file
  // server with no watcher at all, so it sidesteps the limit entirely — and it
  // serves the built bundle, which is the artefact that actually ships.
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173 --strictPort',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
