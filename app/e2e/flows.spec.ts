import { PASSWORD, SEED, STATE, expect, signIn, test, waitForScreen } from './fixtures'

/**
 * The flows that carry risk, as opposed to the per-screen smoke pass.
 */

// ---------------------------------------------------------------------------
// Login.
// ---------------------------------------------------------------------------

test.describe('로그인', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('잘못된 비밀번호는 한국어로 거절한다', async ({ page, consoleWatcher }) => {
    await page.goto('/login')
    await page.getByLabel('닉네임').fill('pwtestmember')
    await page.getByLabel('비밀번호').fill('definitely-not-the-password')
    await page.getByRole('button', { name: '로그인' }).click()

    await expect(page.getByText('닉네임 또는 비밀번호를 확인해주세요.')).toBeVisible()
    await expect(page).toHaveURL(/\/login$/)
    // A rejected password is an expected answer, not a fault. The one console
    // line allowed is Chromium's own note that a request came back 400, which it
    // logs for every 4xx no matter how the app handles it; what must not appear
    // is an exception of ours. Filtering it globally in fixtures.ts would blind
    // the whole suite to genuine failed requests, so it is tolerated only here.
    const unexpected = consoleWatcher.errors.filter(
      (e) => !/status of 400/.test(e),
    )
    expect(unexpected, 'console after a bad password').toEqual([])
  })

  test('가입 신청 링크가 실제 화면으로 이어진다', async ({ page }) => {
    // The only way into the app for somebody who is not a member yet. The link
    // and the screen behind it can be built separately, and were: SignupPage
    // exists and this link points at /signup, but if the route is missing from
    // router.tsx the catch-all answers and the club cannot take new members.
    await page.goto('/login')
    await page.getByRole('link', { name: /가입 신청/ }).click()
    await expect(page).toHaveURL(/\/signup$/)
    // Asserted positively. `expect(404 text).toHaveCount(0)` was the first
    // version and it passed against a missing route, because the catch-all had
    // not rendered yet when the count was taken — an absence is true before the
    // page exists as readily as after. Waiting for a control cannot pass early.
    //
    // The submit button rather than a heading: SignupPage's h1 is TEAM EYSL,
    // the same as the login screen, so a heading would not tell the two apart.
    await expect(page.getByRole('button', { name: '가입 신청' })).toBeVisible()
  })

  test('없는 닉네임도 같은 문구로 거절한다', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('닉네임').fill('pwtestnobody')
    // Any value would do — the nickname belongs to nobody, so the password is
    // never reached. It uses the run password rather than a literal only so that
    // no password string is written down in this public repository at all.
    await page.getByLabel('비밀번호').fill(PASSWORD)
    await page.getByRole('button', { name: '로그인' }).click()

    // Deliberately identical to the wrong-password message: a different one here
    // would let anyone enumerate who is in the club.
    await expect(page.getByText('닉네임 또는 비밀번호를 확인해주세요.')).toBeVisible()
  })

  test('빈 입력으로는 제출할 수 없다', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByRole('button', { name: '로그인' })).toBeDisabled()
    await page.getByLabel('닉네임').fill('pwtestmember')
    // Still disabled: the button needs both fields, not either.
    await expect(page.getByRole('button', { name: '로그인' })).toBeDisabled()
  })

  test('승인된 회원은 로그인 후 홈을 본다', async ({ page, consoleWatcher }) => {
    await signIn(page, 'pwtestmember')
    await waitForScreen(page)
    await expect(page.getByRole('heading', { name: /안녕하세요/ })).toBeVisible()
    expect(consoleWatcher.errors, 'console after a successful login').toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The state a real first user meets.
// ---------------------------------------------------------------------------

test.describe('승인 대기 회원', () => {
  test.use({ storageState: STATE.pending })

  test('홈으로 가면 /pending 으로 보내고 이유를 설명한다', async ({ page, consoleWatcher }) => {
    await page.goto('/')
    await page.waitForURL('**/pending')
    await expect(page.getByRole('heading', { name: '가입 승인 대기 중' })).toBeVisible()
    // The screen has to say what happens next, not merely that something is
    // wrong — this is the first thing a new member ever sees. Matched loosely on
    // 승인, because the exact wording is copy and will be revised; what is being
    // tested is that an explanation is present at all.
    await expect(page.getByText(/승인/).first()).toBeVisible()
    // And a way back out. Without it the screen is a dead end: the session is
    // valid, so /login bounces straight back here and a shared phone can never
    // be handed over.
    await expect(page.getByRole('button', { name: '로그아웃' })).toBeVisible()
    expect(consoleWatcher.errors, 'console on /pending').toEqual([])
  })

  test('회원 전용 화면을 직접 열어도 /pending 으로 보낸다', async ({ page }) => {
    await page.goto('/notices')
    await page.waitForURL('**/pending')
    await expect(page.getByRole('heading', { name: '가입 승인 대기 중' })).toBeVisible()
  })

  test('관리자 화면을 직접 열어도 /pending 으로 보낸다', async ({ page }) => {
    // RequireAuth sits above RequireStaff, so status is checked before role and
    // an unapproved member never reaches the staff guard at all.
    await page.goto('/members/approval')
    await page.waitForURL('**/pending')
    await expect(page.getByRole('heading', { name: '가입 승인 대기 중' })).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// Admin screens reached by URL without the role.
// ---------------------------------------------------------------------------

const STAFF_ONLY = [
  '/admin/attendance',
  `/admin/attendance/${SEED.activityId}`,
  '/admin/records/new',
  '/admin/records/upload',
  '/notices/new',
  `/notices/${SEED.noticeId}/edit`,
]

const MASTER_ADMIN_ONLY = ['/members/approval', '/members/roles', '/members/blocked']

test.describe('일반회원이 관리자 화면을 직접 열면', () => {
  test.use({ storageState: STATE.member })

  for (const path of [...STAFF_ONLY, ...MASTER_ADMIN_ONLY]) {
    test(`${path} 은 홈으로 돌려보낸다`, async ({ page, consoleWatcher }) => {
      await page.goto(path)
      // Redirected to the home screen rather than shown an empty admin table.
      // An empty list would read as "there is no data" when the truth is
      // "you may not see this", and those are not the same sentence.
      await page.waitForURL((url) => url.pathname === '/', { timeout: 15_000 })
      await waitForScreen(page)
      await expect(page.getByRole('heading', { name: /안녕하세요/ })).toBeVisible()
      expect(consoleWatcher.errors, `console after refusing ${path}`).toEqual([])
    })
  }
})

// ---------------------------------------------------------------------------
// Regression: the staff lockout.
// ---------------------------------------------------------------------------

test.describe('총관리자 세션', () => {
  test.use({ storageState: STATE.admin })

  /**
   * getMyMember() (src/features/auth/api.ts:5-8) selects from `members` with no
   * filter and calls .maybeSingle(), leaning on RLS to return exactly one row.
   * That holds for an ordinary member, whose policy is `auth_user_id =
   * auth.uid()`. It does not hold for staff: members_read is
   * `(auth_user_id = auth.uid()) OR is_staff()`, so an admin gets every row and
   * PostgREST answers PGRST116, "Cannot coerce the result to a single JSON
   * object". useCurrentUser is then left with no user, RequireAuth renders
   * <Loading/> forever, and the console stays clean because react-query keeps
   * the error inside query.error, which nobody reads.
   *
   * So every admin and master admin is locked out of the whole app the moment
   * the club has two members — and the president is a master admin.
   *
   * The fix is one line: filter by the caller's auth_user_id, or go through an
   * RPC the way the legacy app's get_my_member does.
   */
  test('총관리자가 자기 회원 정보를 불러온다', async ({ page }) => {
    await page.goto('/')
    await expect(
      page.getByRole('heading', { name: /안녕하세요/ }),
      'a 총관리자 is stuck on 불러오는 중… — getMyMember() gets PGRST116 because ' +
        'members_read returns every row to staff and .maybeSingle() refuses more than one',
    ).toBeVisible({ timeout: 20_000 })
  })
})

// ---------------------------------------------------------------------------
// Ids that are well-formed but match nothing.
// ---------------------------------------------------------------------------

test.describe('없는 항목을 열면', () => {
  test.use({ storageState: STATE.member })

  const missing = '00000000-0000-4000-8000-000000000000'

  for (const [label, path] of [
    ['공지', `/notices/${missing}`],
    ['일정', `/schedule/${missing}`],
    ['미디어 폴더', `/media/${missing}`],
    ['회원', `/members/${missing}`],
  ] as const) {
    test(`${label} 상세가 깨지지 않는다`, async ({ page, consoleWatcher }) => {
      await page.goto(path)
      // No assertion about which sentence appears — the point is that the screen
      // reaches a rendered state and says something, rather than throwing or
      // spinning forever on an id that simply is not there. Some of these land
      // on a heading and some on an AsyncSection error, and both are settled
      // answers, so either satisfies this.
      await waitForScreen(page)
      await expect(page.locator('h1, [role="alert"]').first()).not.toBeEmpty()
      // 404s from PostgREST are Chromium's own log line, not ours; what would
      // matter is an exception thrown while rendering the empty case.
      const unexpected = consoleWatcher.errors.filter((e) => !/status of 40[0-9]/.test(e))
      expect(unexpected, `console on ${path}`).toEqual([])
    })
  }
})
