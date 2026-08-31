import { MISSING_UUID, SEED, STATE, expect, test, waitForScreen } from './fixtures'

/**
 * Round three: what the app SAYS when something goes wrong.
 *
 * Rounds one and two asked whether screens render and whether writes land.
 * Both passed. This asks the question those cannot: when a member gives bad
 * input, asks for something that is not there, or is refused by the database,
 * does the screen tell them something true and useful — or does it show a
 * spinner forever, a raw SQLSTATE, or nothing at all?
 *
 * Written after six of my own test bugs each looked like an app defect. So the
 * rule here is: assert what the member SEES, never infer it from a failure
 * message.
 *
 * Nothing here writes. Every navigation is a read, and the one form fill is
 * never submitted — the dev database is shared with three other suites.
 */

// ---------------------------------------------------------------------------
// Things that are not there. A 404 is a screen too, and it has to say so.
// ---------------------------------------------------------------------------

test.describe('없는 것을 열면', () => {
  test.use({ storageState: STATE.member })

  const gone = [
    { path: `/board/${MISSING_UUID}`, what: '게시글' },
    { path: `/notices/${MISSING_UUID}`, what: '공지' },
    { path: `/schedule/${MISSING_UUID}`, what: '일정' },
    { path: `/members/${MISSING_UUID}`, what: '회원' },
  ]

  for (const { path, what } of gone) {
    test(`${path} — 빈 화면이 아니라 이유를 말한다`, async ({ page, consoleWatcher }) => {
      await page.goto(path)
      await waitForScreen(page)

      // The screen must settle into SOMETHING a person can read. A spinner that
      // never resolves is the failure this catches: getMyMember's .single()
      // lockout looked exactly like a slow network and had a clean console.
      const body = (await page.locator('body').innerText()).trim()
      expect(body.length, `${path} rendered nothing`).toBeGreaterThan(0)
      await expect(page.locator('h1, [role="alert"]').first()).toBeVisible()

      // Whatever it says, it must not be a raw database error. 'PGRST', a bare
      // SQLSTATE, or an English exception on a Korean screen all mean the app
      // handed the member the plumbing.
      expect(body, `${path} leaked a database error (${what})`).not.toMatch(
        /PGRST|SQLSTATE|duplicate key|violates|null value in column/i,
      )
      // NOT toEqual([]) here, and the reason is worth keeping.
      //
      // A missing id makes PostgREST answer 406 -- its reply when .single()
      // matches no row -- and the browser logs "Failed to load resource" for
      // it. That is the correct not-found path working, not the app throwing;
      // the assertions above already prove the screen painted its Korean
      // explanation.
      //
      // Adding /406/ to IGNORED_CONSOLE would have been the easy fix and the
      // wrong one: that list is deliberately short because every pattern in it
      // is a class of error the whole suite stops seeing, and a 406 elsewhere
      // is exactly the .single() defect that once locked every admin out with
      // a clean console. So the allowance lives here, on the paths where a 4xx
      // is the expected answer.
      const unexpected = consoleWatcher.errors.filter(
        (e) => !/Failed to load resource/i.test(e),
      )
      expect(unexpected, `unexpected console on ${path}`).toEqual([])
      expect(
        consoleWatcher.errors.filter((e) => e.startsWith('uncaught:')),
        `uncaught error on ${path}`,
      ).toEqual([])
    })
  }
})

// ---------------------------------------------------------------------------
// Refusals. The database says no; the screen has to explain it in Korean.
// ---------------------------------------------------------------------------

test.describe('거절당하면', () => {
  test.use({ storageState: STATE.member })

  test('없는 글의 수정 화면도 사람이 읽을 것을 낸다', async ({ page, consoleWatcher }) => {
    await page.goto(`/board/${MISSING_UUID}/edit`)
    await waitForScreen(page)

    const body = (await page.locator('body').innerText()).trim()
    expect(body.length, 'edit screen rendered nothing').toBeGreaterThan(0)
    expect(body, 'edit screen leaked a database error').not.toMatch(/PGRST|SQLSTATE|violates/i)
    const unexpected = consoleWatcher.errors.filter(
      (e) => !/Failed to load resource/i.test(e),
    )
    expect(unexpected, 'unexpected console on a missing edit target').toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The pending and blocked sessions: real tokens, no membership behind them.
// ---------------------------------------------------------------------------

test.describe('승인 대기·차단 계정이 앱을 열면', () => {
  for (const [label, state] of [
    ['승인 대기', STATE.pending],
    ['거절된', STATE.rejected],
    ['내보내진', STATE.blocked],
  ] as const) {
    test(`${label} 계정은 이유를 보고 갇히지 않는다`, async ({ browser }) => {
      const context = await browser.newContext({ storageState: state, locale: 'ko-KR' })
      const page = await context.newPage()
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(e.message))

      await page.goto('/')
      await waitForScreen(page)

      const body = (await page.locator('body').innerText()).trim()
      // An approved-only screen rendered blank for these accounts would be the
      // worst outcome: a real token, no membership, and no explanation.
      expect(body.length, `${label} saw a blank screen`).toBeGreaterThan(0)
      expect(body, `${label} leaked a database error`).not.toMatch(/PGRST|SQLSTATE|violates/i)
      expect(errors, `uncaught error for ${label}`).toEqual([])

      await context.close()
    })
  }
})

// ---------------------------------------------------------------------------
// Bad input on the one write path a member has.
// ---------------------------------------------------------------------------

test.describe('잘못된 입력', () => {
  test.use({ storageState: STATE.member })

  test('제목이 한도를 넘으면 화면이 먼저 막는다', async ({ page, consoleWatcher }) => {
    await page.goto('/board/new')
    await waitForScreen(page)

    // The field carries maxLength={TITLE_MAX} (BoardEditPage:165), so the
    // browser truncates rather than the server refusing. Asserting the capped
    // length is what proves the client limit and the database limit agree —
    // create_board_post_v1 passes 120 to board_post_text().
    const long = 'ㄱ'.repeat(400)
    await page.getByLabel('제목').fill(long)
    const typed = await page.getByLabel('제목').inputValue()
    expect(typed.length, 'the field did not cap the title').toBeLessThanOrEqual(120)

    expect(consoleWatcher.errors, 'console while typing an over-long title').toEqual([])
  })
})

// ---------------------------------------------------------------------------
// A seeded activity must survive every screen above.
// ---------------------------------------------------------------------------

test.describe('스윕이 남긴 것이 없어야 한다', () => {
  test.use({ storageState: STATE.admin })

  test('seed 훈련은 그대로 있다', async ({ page }) => {
    await page.goto(`/schedule/${SEED.activityId}`)
    await waitForScreen(page)
    await expect(page.getByText(SEED.activityTitle)).toBeVisible({ timeout: 15_000 })
  })
})
